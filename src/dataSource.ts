import * as cp from 'child_process';
import * as fs from 'fs';
import { decode, encodingExists } from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassEnvironment, AskpassManager } from './askpass/askpassManager';
import { getConfig } from './config';
import { Logger } from './logger';
import { CommitOrdering, DateType, DeepWriteable, ErrorInfo, ErrorInfoExtensionPrefix, GitBlameEntry, GitCommit, GitCommitDetails, GitCommitStash, GitConfigLocation, GitFileChange, GitFileStatus, GitPushBranchMode, GitRepoConfig, GitRepoConfigBranches, GitResetMode, GitSignature, GitSignatureStatus, GitStash, GitTagDetails, MergeActionOn, RebaseActionOn, SquashMessageFormat, TagType, Writeable } from './types';
import { GitExecutable, GitVersionRequirement, UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED, constructIncompatibleGitVersionMessage, doesVersionMeetRequirement, getPathFromStr, getPathFromUri, openGitTerminal, pathWithTrailingSlash, realpath, resolveSpawnOutput, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;
const EOL_REGEX = /\r\n|\r|\n/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const REMOTE_HEAD_BRANCH_REGEXP = /^remotes\/.*\/HEAD$/;
const GIT_LOG_SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';

export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

const GPG_STATUS_CODE_PARSING_DETAILS: Readonly<{ [statusCode: string]: GpgStatusCodeParsingDetails }> = {
	'GOODSIG': { status: GitSignatureStatus.GoodAndValid, uid: true },
	'BADSIG': { status: GitSignatureStatus.Bad, uid: true },
	'ERRSIG': { status: GitSignatureStatus.CannotBeChecked, uid: false },
	'EXPSIG': { status: GitSignatureStatus.GoodButExpired, uid: true },
	'EXPKEYSIG': { status: GitSignatureStatus.GoodButMadeByExpiredKey, uid: true },
	'REVKEYSIG': { status: GitSignatureStatus.GoodButMadeByRevokedKey, uid: true }
};

/**
 * Interfaces Git Graph with the Git executable to provide all Git integrations.
 */
export class DataSource extends Disposable {
	private readonly logger: Logger;
	private readonly askpassEnv: AskpassEnvironment;
	private gitExecutable!: GitExecutable | null;
	private gitExecutableSupportsGpgInfo!: boolean;
	private gitFormatCommitDetails!: string;
	private gitFormatLog!: string;
	private gitFormatStash!: string;

	/**
	 * Creates the Git Graph Data Source.
	 * @param gitExecutable The Git executable available to Git Graph at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Graph to use.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(gitExecutable: GitExecutable | null, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger) {
		super();
		this.logger = logger;
		this.setGitExecutable(gitExecutable);

		const askpassManager = new AskpassManager();
		this.askpassEnv = askpassManager.getEnv();

		this.registerDisposables(
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('git-graph-plus.date.type') || event.affectsConfiguration('git-graph-plus.dateType') ||
					event.affectsConfiguration('git-graph-plus.repository.commits.showSignatureStatus') || event.affectsConfiguration('git-graph-plus.showSignatureStatus') ||
					event.affectsConfiguration('git-graph-plus.repository.useMailmap') || event.affectsConfiguration('git-graph-plus.useMailmap')
				) {
					this.generateGitCommandFormats();
				}
			}),
			onDidChangeGitExecutable((gitExecutable) => {
				this.setGitExecutable(gitExecutable);
			}),
			askpassManager
		);
	}

	/**
	 * Check if the Git executable is unknown.
	 * @returns TRUE => Git executable is unknown, FALSE => Git executable is known.
	 */
	public isGitExecutableUnknown() {
		return this.gitExecutable === null;
	}

	/**
	 * Set the Git executable used by the DataSource.
	 * @param gitExecutable The Git executable.
	 */
	private setGitExecutable(gitExecutable: GitExecutable | null) {
		this.gitExecutable = gitExecutable;
		this.gitExecutableSupportsGpgInfo = gitExecutable !== null && doesVersionMeetRequirement(gitExecutable.version, GitVersionRequirement.GpgInfo);
		this.generateGitCommandFormats();
	}

	/**
	 * Generate the format strings used by various Git commands.
	 */
	private generateGitCommandFormats() {
		const config = getConfig();
		const dateType = config.dateType === DateType.Author ? '%at' : '%ct';
		const useMailmap = config.useMailmap;

		this.gitFormatCommitDetails = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', '%at', useMailmap ? '%cN' : '%cn', useMailmap ? '%cE' : '%ce', '%ct', // Author / Commit Information
			...(config.showSignatureStatus && this.gitExecutableSupportsGpgInfo ? ['%G?', '%GS', '%GK'] : ['', '', '']), // GPG Key Information
			'%B' // Body
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatLog = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatStash = [
			'%H', '%P', '%gD', // Hash, Parent & Selector Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);
	}


	/* Get Data Methods - Core */

	/**
	 * Get the high-level information of a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showStashes Are stashes shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The repositories information.
	 */
	public getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: ReadonlyArray<string>): Promise<GitRepoInfo> {
		return Promise.all([
			this.getBranches(repo, showRemoteBranches, hideRemotes),
			this.getRemotes(repo),
			showStashes ? this.getStashes(repo) : Promise.resolve([])
		]).then((results) => {
			return { branches: results[0].branches, head: results[0].head, remotes: results[1], stashes: results[2], error: null };
		}).catch((errorMessage) => {
			return { branches: [], head: null, remotes: [], stashes: [], error: errorMessage };
		});
	}

	/**
	 * Get the commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param maxCommits The maximum number of commits to return.
	 * @param showTags Are tags are shown.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Should commits mentioned by reflogs being included.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param commitOrdering The order for commits to be returned.
	 * @param remotes An array of known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @returns The commits in the repository.
	 */
	public getCommits(repo: string, branches: ReadonlyArray<string> | null, maxCommits: number, showTags: boolean, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, commitOrdering: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>): Promise<GitCommitData> {
		const config = getConfig();
		return Promise.all([
			this.getLog(repo, branches, maxCommits + 1, showTags && config.showCommitsOnlyReferencedByTags, showRemoteBranches, includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, remotes, hideRemotes, stashes),
			this.getRefs(repo, showRemoteBranches, config.showRemoteHeads, hideRemotes).then((refData: GitRefData) => refData, (errorMessage: string) => errorMessage)
		]).then(async (results) => {
			let commits: GitCommitRecord[] = results[0], refData: GitRefData | string = results[1], i;
			let moreCommitsAvailable = commits.length === maxCommits + 1;
			if (moreCommitsAvailable) commits.pop();

			// It doesn't matter if getRefs() was rejected if no commits exist
			if (typeof refData === 'string') {
				// getRefs() returned an error message (string)
				if (commits.length > 0) {
					// Commits exist, throw the error
					throw refData;
				} else {
					// No commits exist, so getRefs() will always return an error. Set refData to the default value
					refData = { head: null, heads: [], tags: [], remotes: [] };
				}
			}

			if (refData.head !== null && config.showUncommittedChanges) {
				for (i = 0; i < commits.length; i++) {
					if (refData.head === commits[i].hash) {
						const numUncommittedChanges = await this.getUncommittedChanges(repo);
						if (numUncommittedChanges > 0) {
							commits.unshift({ hash: UNCOMMITTED, parents: [refData.head], author: '*', email: '', date: Math.round((new Date()).getTime() / 1000), message: 'Uncommitted Changes (' + numUncommittedChanges + ')' });
						}
						break;
					}
				}
			}

			let commitNodes: DeepWriteable<GitCommit>[] = [];
			let commitLookup: { [hash: string]: number } = {};

			for (i = 0; i < commits.length; i++) {
				commitLookup[commits[i].hash] = i;
				commitNodes.push({ ...commits[i], heads: [], tags: [], remotes: [], stash: null });
			}

			/* Insert Stashes */
			let toAdd: { index: number, data: GitStash }[] = [];
			for (i = 0; i < stashes.length; i++) {
				if (typeof commitLookup[stashes[i].hash] === 'number') {
					commitNodes[commitLookup[stashes[i].hash]].stash = {
						selector: stashes[i].selector,
						baseHash: stashes[i].baseHash,
						untrackedFilesHash: stashes[i].untrackedFilesHash
					};
				} else if (typeof commitLookup[stashes[i].baseHash] === 'number') {
					toAdd.push({ index: commitLookup[stashes[i].baseHash], data: stashes[i] });
				}
			}
			toAdd.sort((a, b) => a.index !== b.index ? a.index - b.index : b.data.date - a.data.date);
			for (i = toAdd.length - 1; i >= 0; i--) {
				let stash = toAdd[i].data;
				commitNodes.splice(toAdd[i].index, 0, {
					hash: stash.hash,
					parents: [stash.baseHash],
					author: stash.author,
					email: stash.email,
					date: stash.date,
					message: stash.message,
					heads: [], tags: [], remotes: [],
					stash: {
						selector: stash.selector,
						baseHash: stash.baseHash,
						untrackedFilesHash: stash.untrackedFilesHash
					}
				});
			}
			for (i = 0; i < commitNodes.length; i++) {
				// Correct commit lookup after stashes have been spliced in
				commitLookup[commitNodes[i].hash] = i;
			}

			/* Annotate Heads */
			for (i = 0; i < refData.heads.length; i++) {
				if (typeof commitLookup[refData.heads[i].hash] === 'number') commitNodes[commitLookup[refData.heads[i].hash]].heads.push(refData.heads[i].name);
			}

			/* Annotate Tags */
			if (showTags) {
				for (i = 0; i < refData.tags.length; i++) {
					if (typeof commitLookup[refData.tags[i].hash] === 'number') commitNodes[commitLookup[refData.tags[i].hash]].tags.push({ name: refData.tags[i].name, annotated: refData.tags[i].annotated });
				}
			}

			/* Annotate Remotes */
			for (i = 0; i < refData.remotes.length; i++) {
				if (typeof commitLookup[refData.remotes[i].hash] === 'number') {
					let name = refData.remotes[i].name;
					let remote = remotes.find(remote => name.startsWith(remote + '/'));
					commitNodes[commitLookup[refData.remotes[i].hash]].remotes.push({ name: name, remote: remote ? remote : null });
				}
			}

			return {
				commits: commitNodes,
				head: refData.head,
				tags: unique(refData.tags.map((tag) => tag.name)),
				moreCommitsAvailable: moreCommitsAvailable,
				error: null
			};
		}).catch((errorMessage) => {
			return { commits: [], head: null, tags: [], moreCommitsAvailable: false, error: errorMessage };
		});
	}

	/**
	 * Get various Git config variables for a repository that are consumed by the Git Graph View.
	 * @param repo The path of the repository.
	 * @param remotes An array of known remotes.
	 * @returns The config data.
	 */
	public getConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		return Promise.all([
			this.getConfigList(repo),
			this.getConfigList(repo, GitConfigLocation.Local),
			this.getConfigList(repo, GitConfigLocation.Global)
		]).then((results) => {
			const consolidatedConfigs = results[0], localConfigs = results[1], globalConfigs = results[2];

			const branches: GitRepoConfigBranches = {};
			Object.keys(localConfigs).forEach((key) => {
				if (key.startsWith('branch.')) {
					if (key.endsWith('.remote')) {
						const branchName = key.substring(7, key.length - 7);
						branches[branchName] = {
							pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
							remote: localConfigs[key]
						};
					} else if (key.endsWith('.pushremote')) {
						const branchName = key.substring(7, key.length - 11);
						branches[branchName] = {
							pushRemote: localConfigs[key],
							remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
						};
					}
				}
			});

			return {
				config: {
					branches: branches,
					diffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffTool),
					guiDiffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffGuiTool),
					pushDefault: getConfigValue(consolidatedConfigs, GitConfigKey.RemotePushDefault),
					remotes: remotes.map((remote) => ({
						name: remote,
						url: getConfigValue(localConfigs, 'remote.' + remote + '.url'),
						pushUrl: getConfigValue(localConfigs, 'remote.' + remote + '.pushurl')
					})),
					user: {
						name: {
							local: getConfigValue(localConfigs, GitConfigKey.UserName),
							global: getConfigValue(globalConfigs, GitConfigKey.UserName)
						},
						email: {
							local: getConfigValue(localConfigs, GitConfigKey.UserEmail),
							global: getConfigValue(globalConfigs, GitConfigKey.UserEmail)
						}
					}
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { config: null, error: errorMessage };
		});
	}


	/* Get Data Methods - Commit Details View */

	/**
	 * Get the commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @param hasParents Does the commit have parents
	 * @returns The commit details.
	 */
	public getCommitDetails(repo: string, commitHash: string, hasParents: boolean): Promise<GitCommitDetailsData> {
		const fromCommit = commitHash + (hasParents ? '^' : '');
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, fromCommit, commitHash),
			this.getDiffNumStat(repo, fromCommit, commitHash)
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1], results[2], null);
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the stash details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the stash commit open in the Commit Details View.
	 * @param stash The stash.
	 * @returns The stash details.
	 */
	public getStashDetails(repo: string, commitHash: string, stash: GitCommitStash): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, stash.baseHash, commitHash),
			this.getDiffNumStat(repo, stash.baseHash, commitHash),
			stash.untrackedFilesHash !== null ? this.getDiffNameStatus(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([]),
			stash.untrackedFilesHash !== null ? this.getDiffNumStat(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([])
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1], results[2], null);
			if (stash.untrackedFilesHash !== null) {
				generateFileChanges(results[3], results[4], null).forEach((fileChange) => {
					if (fileChange.type === GitFileStatus.Added) {
						fileChange.type = GitFileStatus.Untracked;
						results[0].fileChanges.push(fileChange);
					}
				});
			}
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the uncommitted details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @returns The uncommitted details.
	 */
	public getUncommittedDetails(repo: string): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getDiffNameStatus(repo, 'HEAD', ''),
			this.getDiffNumStat(repo, 'HEAD', ''),
			this.getStatus(repo)
		]).then((results) => {
			return {
				commitDetails: {
					hash: UNCOMMITTED, parents: [],
					author: '', authorEmail: '', authorDate: 0,
					committer: '', committerEmail: '', committerDate: 0, signature: null,
					body: '', fileChanges: generateFileChanges(results[0], results[1], results[2])
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the comparison details for the Commit Comparison View.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the comparison is from.
	 * @param toHash The commit hash the comparison is to.
	 * @returns The comparison details.
	 */
	public getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<GitCommitComparisonData> {
		return Promise.all<DiffNameStatusRecord[], DiffNumStatRecord[], GitStatusFiles | null>([
			this.getDiffNameStatus(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			this.getDiffNumStat(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			toHash === UNCOMMITTED ? this.getStatus(repo) : Promise.resolve(null)
		]).then((results) => {
			return {
				fileChanges: generateFileChanges(results[0], results[1], results[2]),
				error: null
			};
		}).catch((errorMessage) => {
			return { fileChanges: [], error: errorMessage };
		});
	}

	/**
	 * Get the Git blame information for a file.
	 * @param repo The path of the repository.
	 * @param filePath The absolute path of the file.
	 * @returns An array of blame entries, one per line.
	 */
	public getBlame(repo: string, filePath: string): Promise<GitBlameEntry[]> {
		const relPath = filePath.startsWith(repo)
			? filePath.substring(repo.length).replace(/^[\/\\]/, '')
			: filePath;
		return this.spawnGit(['blame', '--porcelain', '--', relPath], repo, (stdout) => {
			return parseGitBlame(stdout);
		}).then((entries) => entries, () => []);
	}

	/**
	 * Get the contents of a file at a specific revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash specifying the revision of the file.
	 * @param filePath The path of the file relative to the repositories root.
	 * @returns The file contents.
	 */
	public getCommitFile(repo: string, commitHash: string, filePath: string) {
		return this._spawnGit(['show', commitHash + ':' + filePath], repo, stdout => {
			const encoding = getConfig(repo).fileEncoding;
			return decode(stdout, encodingExists(encoding) ? encoding : 'utf8');
		});
	}

	/**
	 * Get a short diff of a specific file at a given commit, for use in blame hover tooltips.
	 * @param repo The path of the repository.
	 * @param hash The commit hash.
	 * @param relFilePath The path of the file relative to the repository root.
	 * @returns The diff string (limited to the first 30 hunk lines), or an empty string on error.
	 */
	public getFileDiffForBlame(repo: string, hash: string, relFilePath: string, origLine: number): Promise<string> {
		return this.spawnGit(['show', '-U3', '--first-parent', '--no-color', hash, '--', relFilePath], repo, (stdout) => {
			return extractHunkForLine(stdout, origLine);
		}).then((diff) => diff, () => '');
	}


	/* Get Data Methods - General */

	/**
	 * Get the subject of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The subject string, or NULL if an error occurred.
	 */
	public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', commitHash, '--'], repo, (stdout) => {
			return stdout.trim().replace(/\s+/g, ' ');
		}).then((subject) => subject, () => null);
	}

	/**
	 * Get the URL of a repositories remote.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote.
	 * @returns The URL, or NULL if an error occurred.
	 */
	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return this.spawnGit(['config', '--get', 'remote.' + remote + '.url'], repo, (stdout) => {
			return stdout.split(EOL_REGEX)[0];
		}).then((url) => url, () => null);
	}

	/**
	 * Check to see if a file has been renamed between a commit and the working tree, and return the new file path.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash where `oldFilePath` is known to have existed.
	 * @param oldFilePath The file path that may have been renamed.
	 * @returns The new renamed file path, or NULL if either: the file wasn't renamed or the Git command failed to execute.
	 */
	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string) {
		return this.getDiffNameStatus(repo, commitHash, '', 'R').then((renamed) => {
			const renamedRecordForFile = renamed.find((record) => record.oldFilePath === oldFilePath);
			return renamedRecordForFile ? renamedRecordForFile.newFilePath : null;
		}).catch(() => null);
	}

	/**
	 * Get the details of a tag.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @returns The tag details.
	 */
	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
		if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.TagDetails)) {
			return Promise.resolve({ details: null, error: constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.TagDetails, 'retrieving Tag Details') });
		}

		const ref = 'refs/tags/' + tagName;
		return this.spawnGit(['for-each-ref', ref, '--format=' + ['%(objectname)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents:signature)', '%(contents)'].join(GIT_LOG_SEPARATOR)], repo, (stdout) => {
			const data = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: data[0],
				taggerName: data[1],
				taggerEmail: data[2].substring(data[2].startsWith('<') ? 1 : 0, data[2].length - (data[2].endsWith('>') ? 1 : 0)),
				taggerDate: parseInt(data[3]),
				message: removeTrailingBlankLines(data.slice(5).join(GIT_LOG_SEPARATOR).replace(data[4], '').split(EOL_REGEX)).join('\n'),
				signed: data[4] !== ''
			};
		}).then(async (tag) => ({
			details: {
				hash: tag.hash,
				taggerName: tag.taggerName,
				taggerEmail: tag.taggerEmail,
				taggerDate: tag.taggerDate,
				message: tag.message,
				signature: tag.signed
					? await this.getTagSignature(repo, ref)
					: null
			},
			error: null
		})).catch((errorMessage) => ({
			details: null,
			error: errorMessage
		}));
	}

	/**
	 * Get the submodules of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of the paths of the submodules.
	 */
	public getSubmodules(repo: string) {
		return new Promise<string[]>(resolve => {
			fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err, data) => {
				let submodules: string[] = [];
				if (!err) {
					let lines = data.split(EOL_REGEX), inSubmoduleSection = false, match;
					const section = /^\s*\[.*\]\s*$/, submodule = /^\s*\[submodule "([^"]+)"\]\s*$/, pathProp = /^\s*path\s+=\s+(.*)$/;

					for (let i = 0; i < lines.length; i++) {
						if (lines[i].match(section) !== null) {
							inSubmoduleSection = lines[i].match(submodule) !== null;
							continue;
						}

						if (inSubmoduleSection && (match = lines[i].match(pathProp)) !== null) {
							let root = await this.repoRoot(getPathFromUri(vscode.Uri.file(path.join(repo, getPathFromStr(match[1])))));
							if (root !== null && !submodules.includes(root)) {
								submodules.push(root);
							}
						}
					}
				}
				resolve(submodules);
			});
		});
	}


	/* Repository Info Methods */

	/**
	 * Check if there are any staged changes in the repository.
	 * @param repo The path of the repository.
	 * @returns TRUE => Staged Changes, FALSE => No Staged Changes.
	 */
	private areStagedChanges(repo: string) {
		return this.spawnGit(['diff-index', 'HEAD'], repo, (stdout) => stdout !== '').then(changes => changes, () => false);
	}

	/**
	 * Get the root of the repository containing the specified path.
	 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within a repository).
	 * @returns STRING => The root of the repository, NULL => `pathOfPotentialRepo` is not in a repository.
	 */
	public repoRoot(pathOfPotentialRepo: string) {
		return this.spawnGit(['rev-parse', '--show-toplevel'], pathOfPotentialRepo, (stdout) => getPathFromUri(vscode.Uri.file(path.normalize(stdout.trim())))).then(async (pathReturnedByGit) => {
			if (process.platform === 'win32') {
				// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
				// Attempt to replace the UNC Path with the Drive Letter.
				let driveLetterPathMatch: RegExpMatchArray | null;
				if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
					const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
					if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
						pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
					}
				}
			}
			let path = pathOfPotentialRepo;
			let first = path.indexOf('/');
			while (true) {
				if (pathReturnedByGit === path || pathReturnedByGit === await realpath(path)) return path;
				let next = path.lastIndexOf('/');
				if (first !== next && next > -1) {
					path = path.substring(0, next);
				} else {
					return pathReturnedByGit;
				}
			}
		}).catch(() => null); // null => path is not in a repo
	}

	/**
	 * Get the root of the main repository, if the specified repository is a linked worktree.
	 * @param repo The path of the repository.
	 * @returns STRING => The root of the main repository, NULL => `repo` is not a linked worktree.
	 */
	public worktreeMainRoot(repo: string) {
		return this.spawnGit(['rev-parse', '--git-common-dir'], repo, (stdout) => stdout.trim()).then((commonDir) => {
			// Git returns a relative path (".git") when run in the main repository, and an absolute path when run in a linked worktree.
			const absoluteCommonDir = getPathFromUri(vscode.Uri.file(path.resolve(repo, commonDir)));
			const mainRoot = absoluteCommonDir.substring(0, absoluteCommonDir.lastIndexOf('/'));
			return mainRoot !== '' && mainRoot !== repo ? mainRoot : null;
		}).catch(() => null);
	}


	/* Git Action Methods - Remotes */

	/**
	 * Add a new remote to a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @param url The URL of the remote.
	 * @param pushUrl The Push URL of the remote.
	 * @param fetch Fetch the remote after it is added.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
		let status = await this.runGitCommand(['remote', 'add', name, url], repo);
		if (status !== null) return status;

		if (pushUrl !== null) {
			status = await this.runGitCommand(['remote', 'set-url', name, '--push', pushUrl], repo);
			if (status !== null) return status;
		}

		return fetch ? this.fetch(repo, name, false, false) : null;
	}

	/**
	 * Delete an existing remote from a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'remove', name], repo);
	}

	/**
	 * Edit an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param nameOld The old name of the remote.
	 * @param nameNew The new name of the remote.
	 * @param urlOld The old URL of the remote.
	 * @param urlNew The new URL of the remote.
	 * @param pushUrlOld The old Push URL of the remote.
	 * @param pushUrlNew The new Push URL of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) {
		if (nameOld !== nameNew) {
			let status = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
			if (status !== null) return status;
		}

		if (urlOld !== urlNew) {
			let args = ['remote', 'set-url', nameNew];
			if (urlNew === null) args.push('--delete', urlOld!);
			else if (urlOld === null) args.push('--add', urlNew);
			else args.push(urlNew, urlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		if (pushUrlOld !== pushUrlNew) {
			let args = ['remote', 'set-url', '--push', nameNew];
			if (pushUrlNew === null) args.push('--delete', pushUrlOld!);
			else if (pushUrlOld === null) args.push('--add', pushUrlNew);
			else args.push(pushUrlNew, pushUrlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		return null;
	}

	/**
	 * Prune an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'prune', name], repo);
	}


	/* Git Action Methods - Tags */

	/**
	 * Add a new tag to a commit.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param commitHash The hash of the commit the tag should be added to.
	 * @param type Is the tag annotated or lightweight.
	 * @param message The message of the tag (if it is an annotated tag).
	 * @param force Force add the tag, replacing an existing tag with the same name (if it exists).
	 * @returns The ErrorInfo from the executed command.
	 */
	public addTag(repo: string, tagName: string, commitHash: string, type: TagType, message: string, force: boolean) {
		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (type === TagType.Lightweight) {
			args.push(tagName);
		} else {
			args.push(getConfig().signTags ? '-s' : '-a', tagName, '-m', message);
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Delete an existing tag from a repository.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param deleteOnRemote The name of the remote to delete the tag on, or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
		if (deleteOnRemote !== null) {
			let status = await this.runGitCommand(['push', deleteOnRemote, '--delete', tagName], repo);
			if (status !== null) return status;
		}
		return this.runGitCommand(['tag', '-d', tagName], repo);
	}


	/* Git Action Methods - Remote Sync */

	/**
	 * Fetch from the repositories remote(s).
	 * @param repo The path of the repository.
	 * @param remote The remote to fetch, or NULL (fetch all remotes).
	 * @param prune Is pruning enabled.
	 * @param pruneTags Should tags be pruned.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean) {
		let args = ['fetch', remote === null ? '--all' : remote];

		if (prune) {
			args.push('--prune');
		}
		if (pruneTags) {
			if (!prune) {
				return Promise.resolve('In order to Prune Tags, pruning must also be enabled when fetching from ' + (remote !== null ? 'a remote' : 'remote(s)') + '.');
			} else if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.FetchAndPruneTags)) {
				return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.FetchAndPruneTags, 'pruning tags when fetching'));
			}
			args.push('--prune-tags');
		}

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to a remote.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remote The remote to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode) {
		let args = ['push'];
		args.push(remote, branchName);
		if (setUpstream) args.push('--set-upstream');
		if (mode !== GitPushBranchMode.Normal) args.push('--' + mode);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to multiple remotes.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remotes The remotes to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: string[], setUpstream: boolean, mode: GitPushBranchMode): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the branch ' + branchName + ' to.'];
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/**
	 * Push a tag to remote(s).
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag to push.
	 * @param remotes The remote(s) to push the tag to.
	 * @param commitHash The commit hash the tag is on.
	 * @param skipRemoteCheck Skip checking that the tag is on each of the `remotes`.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushTag(repo: string, tagName: string, remotes: string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return ['No remote(s) were specified to push the tag ' + tagName + ' to.'];
		}

		if (!skipRemoteCheck) {
			const remotesContainingCommit = await this.getRemotesContainingCommit(repo, commitHash, remotes).catch(() => remotes);
			const remotesNotContainingCommit = remotes.filter((remote) => !remotesContainingCommit.includes(remote));
			if (remotesNotContainingCommit.length > 0) {
				return [ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote + JSON.stringify(remotesNotContainingCommit)];
			}
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.runGitCommand(['push', remotes[i], tagName], repo);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}


	/* Git Action Methods - Branches */

	/**
	 * Checkout a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to checkout.
	 * @param remoteBranch The name of the remote branch to check out (if not NULL).
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutBranch(repo: string, branchName: string, remoteBranch: string | null) {
		let args = ['checkout'];
		if (remoteBranch === null) args.push(branchName);
		else args.push('-b', branchName, remoteBranch);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch at a commit.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param commitHash The hash of the commit the branch should be created at.
	 * @param checkout Check out the branch after it is created.
	 * @param force Force create the branch, replacing an existing branch with the same name (if it exists).
	 * @returns The ErrorInfo's from the executed command(s).
	 */
	public async createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean) {
		const args = [];
		if (checkout && !force) {
			args.push('checkout', '-b');
		} else {
			args.push('branch');
			if (force) {
				args.push('-f');
			}
		}
		args.push(branchName, commitHash);

		const statuses = [await this.runGitCommand(args, repo)];
		if (statuses[0] === null && checkout && force) {
			statuses.push(await this.checkoutBranch(repo, branchName, null));
		}
		return statuses;
	}

	/**
	 * Delete a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param force Should force the branch to be deleted (even if not merged).
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteBranch(repo: string, branchName: string, force: boolean) {
		return this.runGitCommand(['branch', force ? '-D' : '-d', branchName], repo);
	}

	/**
	 * Delete a remote branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param remote The name of the remote to delete the branch on.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
		let remoteStatus = await this.runGitCommand(['push', remote, '--delete', branchName], repo);
		if (remoteStatus !== null && (new RegExp('remote ref does not exist', 'i')).test(remoteStatus)) {
			let trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', remote + '/' + branchName], repo);
			return trackingBranchStatus === null ? null : 'Branch does not exist on the remote, deleting the remote tracking branch ' + remote + '/' + branchName + '.\n' + trackingBranchStatus;
		}
		return remoteStatus;
	}

	/**
	 * Fetch a remote branch into a local branch.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote containing the remote branch.
	 * @param remoteBranch The name of the remote branch.
	 * @param localBranch The name of the local branch.
	 * @param force Force fetch the remote branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean) {
		const args = ['fetch'];
		if (force) {
			args.push('-f');
		}
		args.push(remote, remoteBranch + ':' + localBranch);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Pull a remote branch into the current branch.
	 * @param repo The path of the repository.
	 * @param branchName The name of the remote branch.
	 * @param remote The name of the remote containing the remote branch.
	 * @param createNewCommit Is `--no-ff` enabled if a merge is required.
	 * @param squash Is `--squash` enabled if a merge is required.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean) {
		const args = ['pull', remote, branchName], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((pullStatus) => {
			return pullStatus === null && squash
				? this.commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, MergeActionOn.Branch, config.squashPullMessageFormat, config.signCommits)
				: pullStatus;
		});
	}

	/**
	 * Rename a branch in a repository.
	 * @param repo The path of the repository.
	 * @param oldName The old name of the branch.
	 * @param newName The new name of the branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public renameBranch(repo: string, oldName: string, newName: string) {
		return this.runGitCommand(['branch', '-m', oldName, newName], repo);
	}


	/* Git Action Methods - Branches & Commits */

	/**
	 * Merge a branch or commit into the current branch.
	 * @param repo The path of the repository.
	 * @param obj The object to be merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param createNewCommit Is `--no-ff` enabled.
	 * @param squash Is `--squash` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public merge(repo: string, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, squash: boolean, noCommit: boolean) {
		const args = ['merge', obj], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (noCommit) {
			args.push('--no-commit');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((mergeStatus) => {
			return mergeStatus === null && squash && !noCommit
				? this.commitSquashIfStagedChangesExist(repo, obj, actionOn, config.squashMergeMessageFormat, config.signCommits)
				: mergeStatus;
		});
	}

	/**
	 * Rebase the current branch on a branch or commit.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @param ignoreDate Is `--ignore-date` enabled.
	 * @param interactive Should the rebase be performed interactively.
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkRebaseInProgress(repo: string): boolean {
		return fs.existsSync(path.join(repo, '.git', 'rebase-merge')) || fs.existsSync(path.join(repo, '.git', 'rebase-apply'));
	}

	public continueRebase(repo: string): Promise<ErrorInfo> {
		return this._spawnGit(['rebase', '--continue'], repo, () => null, false, { GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' }).catch((errorMessage: string) => errorMessage);
	}

	public abortRebase(repo: string): Promise<ErrorInfo> {
		return this._spawnGit(['rebase', '--abort'], repo, () => null, false).catch((errorMessage: string) => errorMessage);
	}

	public rebase(repo: string, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean) {
		void actionOn;
		if (interactive) {
			return this.rebaseInteractiveInEditor(repo, obj);
		} else {
			const args = ['rebase', obj];
			if (ignoreDate) {
				args.push('--ignore-date');
			}
			if (getConfig().signCommits) {
				args.push('-S');
			}
			return this.runGitCommand(args, repo);
		}
	}

	/**
	 * Launch an interactive rebase workflow in the Visual Studio Code editor.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @returns The ErrorInfo from the executed command.
	 */
	private async rebaseInteractiveInEditor(repo: string, obj: string): Promise<ErrorInfo> {
		let tmpDir: string | null = null;
		try {
			const todoEntries = await this.getInteractiveRebaseTodoEntries(repo, obj);
			if (todoEntries.length === 0) {
				return 'There are no commits to rebase.';
			}

			tmpDir = await this.mkdtemp(path.join(os.tmpdir(), 'git-graph-rebase-'));
			const todoPath = path.join(tmpDir, 'git-rebase-todo');
			const sequenceEditorPath = path.join(tmpDir, 'sequence-editor.js');

			const todoFileContent = [
				'# Git Graph Interactive Rebase Plan',
				'# Edit actions (pick, reword, edit, squash, fixup, drop) and reorder lines before continuing.',
				'# Lines starting with # are ignored.',
				...todoEntries.map((e) => 'pick ' + e.hash + ' ' + e.subject),
				''
			].join('\n');
			await this.writeFile(todoPath, todoFileContent);

			await this.writeFile(sequenceEditorPath, [
				'const fs = require(\'fs\');',
				'const source = process.argv[2];',
				'const target = process.argv[3];',
				'if (!source || !target) {',
				'\tprocess.exit(1);',
				'}',
				'fs.copyFileSync(source, target);'
			].join('\n'));

			const todoDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(todoPath));
			await vscode.window.showTextDocument(todoDoc, { preview: false });

			const startAction = 'Start Rebase';
			const selection = await vscode.window.showInformationMessage(
				'Review and save the interactive rebase plan in the editor, then start the rebase.',
				{ modal: true },
				startAction
			);
			if (selection !== startAction) {
				return 'Interactive rebase cancelled.';
			}

			let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === todoDoc.uri.toString()) || todoDoc;
			if (doc.isDirty && !(await doc.save())) {
				return 'Unable to save the interactive rebase plan.';
			}

			const updatedTodo = await this.readFile(todoPath);
			const hasActionLine = updatedTodo.split(EOL_REGEX)
				.some((line: string) => {
					const trimmed = line.trim();
					return trimmed !== '' && !trimmed.startsWith('#');
				});
			if (!hasActionLine) {
				return 'The interactive rebase plan is empty.';
			}

			const args = ['rebase', '--interactive'];
			if (getConfig().signCommits) {
				args.push('-S');
			}
			args.push(obj);

			const sequenceEditorCommand = '"' + process.execPath.replace(/"/g, '\\"') + '" "' + sequenceEditorPath.replace(/"/g, '\\"') + '" "' + todoPath.replace(/"/g, '\\"') + '"';
			return await this.runGitCommand(args, repo, {
				ELECTRON_RUN_AS_NODE: '1',
				GIT_SEQUENCE_EDITOR: sequenceEditorCommand
			});
		} catch (error) {
			return typeof error === 'string' ? error : 'Unable to launch interactive rebase in the editor.';
		} finally {
			if (tmpDir !== null) {
				await this.cleanupInteractiveRebaseTmpDir(tmpDir);
			}
		}
	}

	/**
	 * Create a temporary directory.
	 * @param prefix The directory prefix.
	 * @returns A promise resolving to the created directory path.
	 */
	private mkdtemp(prefix: string): Promise<string> {
		return new Promise((resolve, reject) => {
			fs.mkdtemp(prefix, (err, folder) => err ? reject(err) : resolve(folder));
		});
	}

	/**
	 * Write a UTF-8 file.
	 * @param filePath The file path.
	 * @param content The file contents.
	 */
	private writeFile(filePath: string, content: string): Promise<void> {
		return new Promise((resolve, reject) => {
			fs.writeFile(filePath, content, 'utf8', (err) => err ? reject(err) : resolve());
		});
	}

	/**
	 * Read a UTF-8 file.
	 * @param filePath The file path.
	 */
	private readFile(filePath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			fs.readFile(filePath, 'utf8', (err, data) => err ? reject(err) : resolve(data));
		});
	}

	/**
	 * Delete a file if it exists.
	 * @param filePath The file path.
	 */
	private unlinkIfExists(filePath: string): Promise<void> {
		return new Promise((resolve) => {
			fs.unlink(filePath, () => resolve());
		});
	}

	/**
	 * Remove a directory if it exists.
	 * @param dirPath The directory path.
	 */
	private rmdirIfExists(dirPath: string): Promise<void> {
		return new Promise((resolve) => {
			fs.rmdir(dirPath, () => resolve());
		});
	}

	/**
	 * Clean up temporary interactive rebase files.
	 * @param dirPath The temporary directory path.
	 */
	private async cleanupInteractiveRebaseTmpDir(dirPath: string): Promise<void> {
		await this.unlinkIfExists(path.join(dirPath, 'git-rebase-todo'));
		await this.unlinkIfExists(path.join(dirPath, 'sequence-editor.js'));
		await this.unlinkIfExists(path.join(dirPath, 'commit-editor.js'));
		await this.unlinkIfExists(path.join(dirPath, 'messages.json'));
		await this.unlinkIfExists(path.join(dirPath, 'counter.txt'));
		await this.rmdirIfExists(dirPath);
	}

	/**
	 * Get the default todo entries for an interactive rebase operation.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @returns An array of interactive rebase todo entries.
	 */
	/**
	 * Get the list of commits to be rebased for a visual interactive rebase,
	 * along with the base (onto) commit for display context.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @returns The base commit and list of todo entries, or an error string.
	 */
	public async getInteractiveRebaseTodos(repo: string, obj: string): Promise<InteractiveRebaseData | string> {
		try {
			const [base, entries] = await Promise.all([
				this.getBaseCommitEntry(repo, obj),
				this.getInteractiveRebaseTodoEntries(repo, obj)
			]);
			return { base, entries };
		} catch (e: unknown) {
			return typeof e === 'string' ? e : 'Unable to get commits for interactive rebase.';
		}
	}

	/**
	 * Parse an existing git-rebase-todo file and enrich entries with author/date from git log.
	 * Used when intercepting a `git rebase -i` launched from the terminal.
	 * @param todoFilePath Absolute path to the git-rebase-todo file.
	 * @returns Parsed and enriched rebase data, or an error string.
	 */
	public async getInteractiveRebaseTodosFromFile(todoFilePath: string): Promise<InteractiveRebaseData | string> {
		try {
			const repoPath = todoFilePath.replace(/[/\\]\.git[/\\]rebase-merge[/\\]git-rebase-todo$/, '');

			const content = fs.readFileSync(todoFilePath, 'utf8');
			const ACTION_MAP: { [key: string]: string } = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
			const VALID_LONG = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);

			const rawEntries: { action: string; hash: string; subject: string }[] = [];
			for (const line of content.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) continue;
				const parts = trimmed.split(/\s+/);
				if (parts.length < 2) continue;
				const action = ACTION_MAP[parts[0]] || parts[0];
				if (!VALID_LONG.has(action)) continue;
				rawEntries.push({ action, hash: parts[1], subject: parts.slice(2).join(' ') });
			}
			if (rawEntries.length === 0) {
				return 'No commits found in the interactive rebase todo file.';
			}

			// Determine base (onto) hash from .git/rebase-merge/onto
			const ontoFile = path.join(repoPath, '.git', 'rebase-merge', 'onto');
			const ontoHash = fs.existsSync(ontoFile) ? fs.readFileSync(ontoFile, 'utf8').trim() : rawEntries[0].hash;

			// Determine branch name from .git/rebase-merge/head-name
			const headNameFile = path.join(repoPath, '.git', 'rebase-merge', 'head-name');
			const headName = fs.existsSync(headNameFile)
				? fs.readFileSync(headNameFile, 'utf8').trim().replace(/^refs\/heads\//, '')
				: '';

			// Enrich entries with author/date from git log
			const hashes = rawEntries.map((e) => e.hash);
			const enriched = await this.getCommitDetailsByHashes(repoPath, hashes);

			const entries: InteractiveRebaseTodoEntry[] = rawEntries.map((e) => {
				const full = enriched[e.hash] || enriched[e.hash.substring(0, 7)];
				return {
					hash: full ? full.hash : e.hash,
					subject: full ? full.subject : e.subject,
					author: full ? full.author : '',
					relativeDate: full ? full.relativeDate : ''
				};
			});

			const base = await this.getBaseCommitEntry(repoPath, ontoHash);

			return { base, entries, headName: headName || undefined };
		} catch (e: unknown) {
			return typeof e === 'string' ? e : 'Unable to parse the interactive rebase todo file.';
		}
	}

	/**
	 * Write modified entries back to a git-rebase-todo file (used in terminal-intercept mode).
	 * @param todoFilePath Absolute path to the git-rebase-todo file.
	 * @param entries The ordered entries with their actions.
	 * @returns null on success, or an error string.
	 */
	public writeRebaseTodoFile(todoFilePath: string, entries: ReadonlyArray<{ action: string; hash: string; subject: string }>): ErrorInfo {
		try {
			const content = entries.map((e) => e.action + ' ' + e.hash + ' ' + e.subject).join('\n') + '\n';
			fs.writeFileSync(todoFilePath, content, 'utf8');
			return null;
		} catch (e: unknown) {
			return e instanceof Error ? e.message : 'Unable to write the interactive rebase todo file.';
		}
	}

	private async getCommitDetailsByHashes(repo: string, hashes: string[]): Promise<{ [hash: string]: InteractiveRebaseTodoEntry }> {
		if (hashes.length === 0) return {};
		return this.spawnGit(
			['-c', 'log.showSignature=false', 'log', '--no-walk', '--format=%H%x01%s%x01%an%x01%ar', ...hashes, '--'],
			repo,
			(stdout) => {
				const result: { [hash: string]: InteractiveRebaseTodoEntry } = {};
				stdout.split(/\r?\n/).forEach((line) => {
					const trimmed = line.trim();
					if (!trimmed) return;
					const parts = trimmed.split('\x01');
					if (!parts[0]) return;
					const entry: InteractiveRebaseTodoEntry = { hash: parts[0], subject: parts[1] || '', author: parts[2] || '', relativeDate: parts[3] || '' };
					result[parts[0]] = entry;
					result[parts[0].substring(0, 7)] = entry;
				});
				return result;
			}
		).catch(() => ({}));
	}

	private getBaseCommitEntry(repo: string, obj: string): Promise<InteractiveRebaseTodoEntry> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '-1', '--format=%H%x01%s%x01%an%x01%ar', obj, '--'], repo, (stdout) => {
			const line = stdout.trim().split(/\r?\n/)[0] || '';
			const parts = line.split('\x01');
			return {
				hash: parts[0] || obj,
				subject: parts[1] || obj,
				author: parts[2] || '',
				relativeDate: parts[3] || ''
			};
		});
	}

	/**
	 * Get the command used to open the combined commit message file (for squash/fixup groups) when
	 * `core.editor` is not configured. Resolves the absolute path of the running VS Code's own `code`
	 * CLI (via `vscode.env.appRoot`) instead of relying on a bare `code` command, since the extension
	 * host's process PATH often doesn't include the directory containing the `code` CLI (e.g. when VS
	 * Code is launched from the Dock/Finder on macOS, rather than from a terminal).
	 * @returns The editor command to use.
	 */
	private getDefaultCommitEditorCmd() {
		try {
			const codeBin = path.join(vscode.env.appRoot, 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
			if (fs.existsSync(codeBin)) {
				return '"' + codeBin + '" --wait';
			}
		} catch (e) {
			// Ignore, and fall back to relying on `code` being available on PATH.
		}
		return 'code --wait';
	}

	/**
	 * Build a `PATH` environment variable value augmented with the directories commonly needed to
	 * resolve editor CLIs (e.g. `code`, `code-insiders`) that are configured (either by us, or by the
	 * user via `core.editor`) as a bare command name. This is necessary because on macOS, when VS Code
	 * is launched from the Dock/Finder (rather than a terminal), its process PATH often doesn't include
	 * `/usr/local/bin` or `/opt/homebrew/bin` - the locations where the `code` CLI shim is installed -
	 * causing a bare `code --wait` (a very common `core.editor` setting) to fail silently.
	 * @returns The augmented `PATH` value.
	 */
	private getAugmentedEditorPath() {
		const pathSeparator = process.platform === 'win32' ? ';' : ':';
		const extraDirs: string[] = [];
		if (process.platform !== 'win32') {
			extraDirs.push('/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin');
		}
		try {
			extraDirs.push(path.join(vscode.env.appRoot, 'bin'));
		} catch (e) {
			// Ignore
		}
		return extraDirs.join(pathSeparator) + pathSeparator + (process.env.PATH || '');
	}

	/**
	 * Execute an interactive rebase with the given ordered and annotated entries.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param entries The interactive rebase entries with their actions.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async rebaseInteractiveWithEntries(repo: string, obj: string, entries: ReadonlyArray<{ action: string; hash: string; subject: string; message?: string }>): Promise<ErrorInfo> {
		let tmpDir: string | null = null;
		try {
			tmpDir = await this.mkdtemp(path.join(os.tmpdir(), 'git-graph-rebase-'));
			const todoPath = path.join(tmpDir, 'git-rebase-todo');
			const sequenceEditorPath = path.join(tmpDir, 'sequence-editor.js');
			const commitEditorPath = path.join(tmpDir, 'commit-editor.js');
			const messagesPath = path.join(tmpDir, 'messages.json');
			const counterPath = path.join(tmpDir, 'counter.txt');

			const todoContent = entries.map((e) => e.action + ' ' + e.hash + ' ' + e.subject).join('\n') + '\n';
			await this.writeFile(todoPath, todoContent);

			await this.writeFile(sequenceEditorPath, [
				'const fs = require(\'fs\');',
				'const source = process.argv[2];',
				'const target = process.argv[3];',
				'if (!source || !target) {',
				'\tprocess.exit(1);',
				'}',
				'fs.copyFileSync(source, target);'
			].join('\n'));

			// Build the ordered queue of commit-message overrides (one entry per editor stop git will make).
			// A string overrides the message (already edited inline in the panel, e.g. via reword); null means
			// there's no override (e.g. a plain squash/fixup meld), in which case the user is shown git's default
			// combined message in their configured editor to review/edit, matching standard `git rebase -i`.
			const messageQueue = buildInteractiveRebaseEditorQueue(entries);
			await this.writeFile(messagesPath, JSON.stringify(messageQueue));
			await this.writeFile(counterPath, '0');

			const coreEditorConfig = await this.spawnGit(['config', '--get', 'core.editor'], repo, (stdout) => stdout.split(EOL_REGEX)[0]).catch(() => '');
			const editorCmd = coreEditorConfig.trim() !== '' ? coreEditorConfig.trim() : this.getDefaultCommitEditorCmd();

			await this.writeFile(commitEditorPath, [
				'const fs = require(\'fs\');',
				'const path = require(\'path\');',
				'const { execSync } = require(\'child_process\');',
				'const target = process.argv[2];',
				'const dir = __dirname;',
				'let msgs = [];',
				'try { msgs = JSON.parse(fs.readFileSync(path.join(dir, "messages.json"), "utf8")); } catch (e) { msgs = []; }',
				'let k = 0;',
				'try { k = parseInt(fs.readFileSync(path.join(dir, "counter.txt"), "utf8"), 10) || 0; } catch (e) { k = 0; }',
				'const m = msgs[k];',
				'if (typeof m === "string" && target) {',
				'\tfs.writeFileSync(target, m.charAt(m.length - 1) === "\\n" ? m : m + "\\n", "utf8");',
				'} else if (target) {',
				'\t// No override: let the user review/edit the combined message git already wrote to <target>,',
				'\t// by opening it in their configured editor and waiting for it to be closed.',
				'\ttry { execSync(' + JSON.stringify(editorCmd) + ' + \' \' + JSON.stringify(target), { stdio: "ignore" }); } catch (e) { /* ignore */ }',
				'}',
				'try { fs.writeFileSync(path.join(dir, "counter.txt"), String(k + 1), "utf8"); } catch (e) { /* ignore */ }'
			].join('\n'));

			const args = ['rebase', '--interactive'];
			if (getConfig().signCommits) {
				args.push('-S');
			}
			args.push(obj);

			const sequenceEditorCommand = '"' + process.execPath.replace(/"/g, '\\"') + '" "' + sequenceEditorPath.replace(/"/g, '\\"') + '" "' + todoPath.replace(/"/g, '\\"') + '"';
			const commitEditorCommand = '"' + process.execPath.replace(/"/g, '\\"') + '" "' + commitEditorPath.replace(/"/g, '\\"') + '"';
			return await this.runGitCommand(args, repo, {
				ELECTRON_RUN_AS_NODE: '1',
				GIT_SEQUENCE_EDITOR: sequenceEditorCommand,
				GIT_EDITOR: commitEditorCommand,
				// Ensure the `code` (or other editor) CLI configured via `core.editor` can be resolved by
				// the `execSync` call inside commitEditorPath, even if it's referenced as a bare command
				// name and the extension host's own PATH is missing common install locations (see
				// getAugmentedEditorPath for details).
				PATH: this.getAugmentedEditorPath()
			});
		} catch (error) {
			return typeof error === 'string' ? error : 'Unable to execute interactive rebase.';
		} finally {
			if (tmpDir !== null) {
				await this.cleanupInteractiveRebaseTmpDir(tmpDir);
			}
		}
	}

	private getInteractiveRebaseTodoEntries(repo: string, obj: string): Promise<InteractiveRebaseTodoEntry[]> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '--reverse', '--format=%H%x01%s%x01%an%x01%ar', obj + '..HEAD', '--'], repo, (stdout) => {
			const lines = stdout.split(EOL_REGEX);
			const entries: InteractiveRebaseTodoEntry[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (lines[i] === '') continue;
				const parts = lines[i].split('\x01');
				if (parts.length < 2 || parts[0].length < 1) continue;
				entries.push({
					hash: parts[0],
					subject: parts[1] || '',
					author: parts[2] || '',
					relativeDate: parts[3] || ''
				});
			}
			return entries;
		});
	}


	/* Git Action Methods - Branches & Tags */

	/**
	 * Create an archive of a repository at a specific reference, and save to disk.
	 * @param repo The path of the repository.
	 * @param ref The reference of the revision to archive.
	 * @param outputFilePath The file path that the archive should be saved to.
	 * @param type The type of archive.
	 * @returns The ErrorInfo from the executed command.
	 */
	public archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip') {
		return this.runGitCommand(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
	}


	/* Git Action Methods - Commits */

	/**
	 * Checkout a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to check out.
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutCommit(repo: string, commitHash: string) {
		return this.runGitCommand(['checkout', commitHash], repo);
	}

	/**
	 * Cherrypick a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to be cherry picked.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @param recordOrigin Is `-x` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean) {
		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to drop.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommit(repo: string, commitHash: string) {
		const args = ['rebase'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push('--onto', commitHash + '^', commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to a specified commit.
	 * @param repo The path of the repository.
	 * @param commit The hash of the commit that the current branch should be reset to.
	 * @param resetMode The mode of the reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetToCommit(repo: string, commit: string, resetMode: GitResetMode) {
		return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
	}

	/**
	 * Revert a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to revert.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @returns The ErrorInfo from the executed command.
	 */
	public revertCommit(repo: string, commitHash: string, parentIndex: number) {
		const args = ['revert', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}


	/* Git Action Methods - Config */

	/**
	 * Set a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be set.
	 * @param value The value to be set.
	 * @param location The location where the configuration value should be set.
	 * @returns The ErrorInfo from the executed command.
	 */
	public setConfigValue(repo: string, key: GitConfigKey, value: string, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, key, value], repo);
	}

	/**
	 * Unset a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be unset.
	 * @param location The location where the configuration value should be unset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public unsetConfigValue(repo: string, key: GitConfigKey, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, '--unset-all', key], repo);
	}


	/* Git Action Methods - Uncommitted */

	/**
	 * Clean the untracked files in a repository.
	 * @param repo The path of the repository.
	 * @param directories Is `-d` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cleanUntrackedFiles(repo: string, directories: boolean) {
		return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
	}


	/* Git Action Methods - File */

	/**
	 * Reset a file to the specified revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit to reset the file to.
	 * @param filePath The file to reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
		return this.runGitCommand(['checkout', commitHash, '--', filePath], repo);
	}


	/* Git Action Methods - Stash */

	/**
	 * Apply a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public applyStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'apply'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch from a stash.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param branchName The name of the branch to be created.
	 * @returns The ErrorInfo from the executed command.
	 */
	public branchFromStash(repo: string, selector: string, branchName: string) {
		return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
	}

	/**
	 * Drop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropStash(repo: string, selector: string) {
		return this.runGitCommand(['stash', 'drop', selector], repo);
	}

	/**
	 * Pop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public popStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'pop'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push the uncommitted changes to a stash.
	 * @param repo The path of the repository.
	 * @param message The message of the stash.
	 * @param includeUntracked Is `--include-untracked` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
		if (this.gitExecutable === null) {
			return Promise.resolve(UNABLE_TO_FIND_GIT_MSG);
		} else if (!doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.PushStash)) {
			return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.PushStash));
		}

		let args = ['stash', 'push'];
		if (includeUntracked) args.push('--include-untracked');
		if (message !== '') args.push('--message', message);
		return this.runGitCommand(args, repo);
	}


	/* Public Utils */

	/**
	 * Opens an external directory diff for the specified commits.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the diff is from.
	 * @param toHash The commit hash the diff is to.
	 * @param isGui Is the external diff tool GUI based.
	 * @returns The ErrorInfo from the executed command.
	 */
	public openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				const args = ['difftool', '--dir-diff'];
				if (isGui) {
					args.push('-g');
				}
				if (fromHash === toHash) {
					if (toHash === UNCOMMITTED) {
						args.push('HEAD');
					} else {
						args.push(toHash + '^..' + toHash);
					}
				} else {
					if (toHash === UNCOMMITTED) {
						args.push(fromHash);
					} else {
						args.push(fromHash + '..' + toHash);
					}
				}
				if (isGui) {
					this.logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
					this.runGitCommand(args, repo).then((errorInfo) => {
						this.logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
						if (errorInfo !== null) {
							const errorMessage = errorInfo.replace(EOL_REGEX, ' ');
							this.logger.logError(errorMessage);
							showErrorMessage(errorMessage);
						}
					});
				} else {
					openGitTerminal(repo, this.gitExecutable.path, args.join(' '), 'Open External Directory Diff');
				}
				setTimeout(() => resolve(null), 1500);
			}
		});
	}

	/**
	 * Open a new terminal, set up the Git executable, and optionally run a command.
	 * @param repo The path of the repository.
	 * @param command The command to run.
	 * @param name The name for the terminal.
	 * @returns The ErrorInfo from opening the terminal.
	 */
	public openGitTerminal(repo: string, command: string | null, name: string) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				openGitTerminal(repo, this.gitExecutable.path, command, name);
				setTimeout(() => resolve(null), 1000);
			}
		});
	}


	/* Private Data Providers */

	/**
	 * Get the branches in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The branch data.
	 */
	private getBranches(repo: string, showRemoteBranches: boolean, hideRemotes: ReadonlyArray<string>) {
		let args = ['branch'];
		if (showRemoteBranches) args.push('-a');
		args.push('--no-color');

		const hideRemotePatterns = hideRemotes.map((remote) => 'remotes/' + remote + '/');
		const showRemoteHeads = getConfig().showRemoteHeads;

		return this.spawnGit(args, repo, (stdout) => {
			let branchData: GitBranchData = { branches: [], head: null, error: null };
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let name = lines[i].substring(2).split(' -> ')[0];
				if (INVALID_BRANCH_REGEXP.test(name) || hideRemotePatterns.some((pattern) => name.startsWith(pattern)) || (!showRemoteHeads && REMOTE_HEAD_BRANCH_REGEXP.test(name))) {
					continue;
				}

				if (lines[i][0] === '*') {
					branchData.head = name;
					branchData.branches.unshift(name);
				} else {
					branchData.branches.push(name);
				}
			}
			return branchData;
		});
	}

	/**
	 * Get the base commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @returns The base commit details.
	 */
	private getCommitDetailsBase(repo: string, commitHash: string) {
		return this.spawnGit(['-c', 'log.showSignature=false', 'show', '--quiet', commitHash, '--format=' + this.gitFormatCommitDetails], repo, (stdout): DeepWriteable<GitCommitDetails> => {
			const commitInfo = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: commitInfo[0],
				parents: commitInfo[1] !== '' ? commitInfo[1].split(' ') : [],
				author: commitInfo[2],
				authorEmail: commitInfo[3],
				authorDate: parseInt(commitInfo[4]),
				committer: commitInfo[5],
				committerEmail: commitInfo[6],
				committerDate: parseInt(commitInfo[7]),
				signature: ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(commitInfo[8])
					? {
						key: commitInfo[10].trim(),
						signer: commitInfo[9].trim(),
						status: <GitSignatureStatus>commitInfo[8]
					}
					: null,
				body: removeTrailingBlankLines(commitInfo.slice(11).join(GIT_LOG_SEPARATOR).split(EOL_REGEX)).join('\n'),
				fileChanges: []
			};
		});
	}

	/**
	 * Get the configuration list of a repository.
	 * @param repo The path of the repository.
	 * @param location The location of the configuration to be listed.
	 * @returns A set of key-value pairs of Git configuration records.
	 */
	private getConfigList(repo: string, location?: GitConfigLocation): Promise<GitConfigSet> {
		const args = ['--no-pager', 'config', '--list', '-z', '--includes'];
		if (location) {
			args.push('--' + location);
		}

		return this.spawnGit(args, repo, (stdout) => {
			const configs: GitConfigSet = {}, keyValuePairs = stdout.split('\0');
			const numPairs = keyValuePairs.length - 1;
			let comps, key;
			for (let i = 0; i < numPairs; i++) {
				comps = keyValuePairs[i].split(EOL_REGEX);
				key = comps.shift()!;
				configs[key] = comps.join('\n');
			}
			return configs;
		}).catch((errorMessage) => {
			if (typeof errorMessage === 'string') {
				const message = errorMessage.toLowerCase();
				if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
					// If the Git command failed due to the configuration file not existing, return an empty list instead of throwing the exception
					return {};
				}
			} else {
				errorMessage = 'An unexpected error occurred while spawning the Git child process.';
			}
			throw errorMessage;
		});
	}

	/**
	 * Get the diff `--name-status` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--name-status` records.
	 */
	private getDiffNameStatus(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--name-status', filter).then((output) => {
			let records: DiffNameStatusRecord[] = [], i = 0;
			while (i < output.length && output[i] !== '') {
				let type = <GitFileStatus>output[i][0];
				if (type === GitFileStatus.Added || type === GitFileStatus.Deleted || type === GitFileStatus.Modified) {
					// Add, Modify, or Delete
					let p = getPathFromStr(output[i + 1]);
					records.push({ type: type, oldFilePath: p, newFilePath: p });
					i += 2;
				} else if (type === GitFileStatus.Renamed) {
					// Rename
					records.push({ type: type, oldFilePath: getPathFromStr(output[i + 1]), newFilePath: getPathFromStr(output[i + 2]) });
					i += 3;
				} else {
					break;
				}
			}
			return records;
		});
	}

	/**
	 * Get the diff `--numstat` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--numstat` records.
	 */
	private getDiffNumStat(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--numstat', filter).then((output) => {
			let records: DiffNumStatRecord[] = [], i = 0;
			while (i < output.length && output[i] !== '') {
				let fields = output[i].split('\t');
				if (fields.length !== 3) break;
				if (fields[2] !== '') {
					// Add, Modify, or Delete
					records.push({ filePath: getPathFromStr(fields[2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
					i += 1;
				} else {
					// Rename
					records.push({ filePath: getPathFromStr(output[i + 2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
					i += 3;
				}
			}
			return records;
		});
	}

	/**
	 * Get the raw commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param num The maximum number of commits to return.
	 * @param includeTags Include commits only referenced by tags.
	 * @param includeRemotes Include remote branches.
	 * @param includeCommitsMentionedByReflogs Include commits mentioned by reflogs.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @param remotes An array of the known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @returns An array of commits.
	 */
	private getLog(repo: string, branches: ReadonlyArray<string> | null, num: number, includeTags: boolean, includeRemotes: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, order: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>) {
		const args = ['-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + this.gitFormatLog, '--' + order + '-order'];
		if (onlyFollowFirstParent) {
			args.push('--first-parent');
		}
		if (branches !== null) {
			for (let i = 0; i < branches.length; i++) {
				args.push(branches[i]);
			}
		} else {
			// Show All
			args.push('--branches');
			if (includeTags) args.push('--tags');
			if (includeCommitsMentionedByReflogs) args.push('--reflog');
			if (includeRemotes) {
				if (hideRemotes.length === 0) {
					args.push('--remotes');
				} else {
					remotes.filter((remote) => !hideRemotes.includes(remote)).forEach((remote) => {
						args.push('--glob=refs/remotes/' + remote);
					});
				}
			}

			// Add the unique list of base hashes of stashes, so that commits only referenced by stashes are displayed
			const stashBaseHashes = stashes.map((stash) => stash.baseHash);
			stashBaseHashes.filter((hash, index) => stashBaseHashes.indexOf(hash) === index).forEach((hash) => args.push(hash));

			args.push('HEAD');
		}
		args.push('--');

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			let commits: GitCommitRecord[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 6) break;
				commits.push({ hash: line[0], parents: line[1] !== '' ? line[1].split(' ') : [], author: line[2], email: line[3], date: parseInt(line[4]), message: line[5] });
			}
			return commits;
		});
	}

	/**
	 * Get the references in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showRemoteHeads Are remote heads shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The references data.
	 */
	private getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: ReadonlyArray<string>) {
		let args = ['show-ref'];
		if (!showRemoteBranches) args.push('--heads', '--tags');
		args.push('-d', '--head');

		const hideRemotePatterns = hideRemotes.map((remote) => 'refs/remotes/' + remote + '/');

		return this.spawnGit(args, repo, (stdout) => {
			let refData: GitRefData = { head: null, heads: [], tags: [], remotes: [] };
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(' ');
				if (line.length < 2) continue;

				let hash = line.shift()!;
				let ref = line.join(' ');

				if (ref.startsWith('refs/heads/')) {
					refData.heads.push({ hash: hash, name: ref.substring(11) });
				} else if (ref.startsWith('refs/tags/')) {
					let annotated = ref.endsWith('^{}');
					refData.tags.push({ hash: hash, name: (annotated ? ref.substring(10, ref.length - 3) : ref.substring(10)), annotated: annotated });
				} else if (ref.startsWith('refs/remotes/')) {
					if (!hideRemotePatterns.some((pattern) => ref.startsWith(pattern)) && (showRemoteHeads || !ref.endsWith('/HEAD'))) {
						refData.remotes.push({ hash: hash, name: ref.substring(13) });
					}
				} else if (ref === 'HEAD') {
					refData.head = hash;
				}
			}
			return refData;
		});
	}

	/**
	 * Get all of the remotes that contain the specified commit hash.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to test.
	 * @param knownRemotes The list of known remotes to check for.
	 * @returns A promise resolving to a list of remote names.
	 */
	private getRemotesContainingCommit(repo: string, commitHash: string, knownRemotes: string[]) {
		return this.spawnGit(['branch', '-r', '--no-color', '--contains=' + commitHash], repo, (stdout) => {
			// Get the names of all known remote branches that contain commitHash
			const branchNames = stdout.split(EOL_REGEX)
				.filter((line) => line.length > 2)
				.map((line) => line.substring(2).split(' -> ')[0])
				.filter((branchName) => !INVALID_BRANCH_REGEXP.test(branchName));

			// Get all the remotes that are the prefix of at least one remote branch name
			return knownRemotes.filter((knownRemote) => {
				const knownRemotePrefix = knownRemote + '/';
				return branchNames.some((branchName) => branchName.startsWith(knownRemotePrefix));
			});
		});
	}

	/**
	 * Get the stashes in a repository.
	 * @param repo The path of the repository.
	 * @returns An array of stashes.
	 */
	private getStashes(repo: string) {
		return this.spawnGit(['reflog', '--format=' + this.gitFormatStash, 'refs/stash', '--'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			let stashes: GitStash[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 7 || line[1] === '') continue;
				let parentHashes = line[1].split(' ');
				stashes.push({
					hash: line[0],
					baseHash: parentHashes[0],
					untrackedFilesHash: parentHashes.length === 3 ? parentHashes[2] : null,
					selector: line[2],
					author: line[3],
					email: line[4],
					date: parseInt(line[5]),
					message: line[6]
				});
			}
			return stashes;
		}).catch(() => <GitStash[]>[]);
	}

	/**
	 * Get the names of the remotes of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of remote names.
	 */
	private getRemotes(repo: string) {
		return this.spawnGit(['remote'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			lines.pop();
			return lines;
		});
	}

	/**
	 * Get the signature of a signed tag.
	 * @param repo The path of the repository.
	 * @param ref The reference identifying the tag.
	 * @returns A Promise resolving to the signature.
	 */
	private getTagSignature(repo: string, ref: string): Promise<GitSignature> {
		return this._spawnGit(['verify-tag', '--raw', ref], repo, (stdout, stderr) => stderr || stdout.toString(), true).then((output) => {
			const records = output.split(EOL_REGEX)
				.filter((line) => line.startsWith('[GNUPG:] '))
				.map((line) => line.split(' '));

			let signature: Writeable<GitSignature> | null = null, trustLevel: string | null = null, parsingDetails: GpgStatusCodeParsingDetails | undefined;
			for (let i = 0; i < records.length; i++) {
				parsingDetails = GPG_STATUS_CODE_PARSING_DETAILS[records[i][1]];
				if (parsingDetails) {
					if (signature !== null) {
						throw new Error('Multiple Signatures Exist: As Git currently doesn\'t support them, nor does Git Graph (for consistency).');
					} else {
						signature = {
							status: parsingDetails.status,
							key: records[i][2],
							signer: parsingDetails.uid ? records[i].slice(3).join(' ') : '' // When parsingDetails.uid === TRUE, the signer is the rest of the record (so join the remaining arguments)
						};
					}
				} else if (records[i][1].startsWith('TRUST_')) {
					trustLevel = records[i][1];
				}
			}

			if (signature !== null && signature.status === GitSignatureStatus.GoodAndValid && (trustLevel === 'TRUST_UNDEFINED' || trustLevel === 'TRUST_NEVER')) {
				signature.status = GitSignatureStatus.GoodWithUnknownValidity;
			}

			if (signature !== null) {
				return signature;
			} else {
				throw new Error('No Signature could be parsed.');
			}
		}).catch(() => ({
			status: GitSignatureStatus.CannotBeChecked,
			key: '',
			signer: ''
		}));
	}

	/**
	 * Get the number of uncommitted changes in a repository.
	 * @param repo The path of the repository.
	 * @returns The number of uncommitted changes.
	 */
	private getUncommittedChanges(repo: string) {
		return this.spawnGit(['status', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain'], repo, (stdout) => {
			const numLines = stdout.split(EOL_REGEX).length;
			return numLines > 1 ? numLines - 1 : 0;
		});
	}

	/**
	 * Get the untracked and deleted files that are not staged or committed.
	 * @param repo The path of the repository.
	 * @returns The untracked and deleted files.
	 */
	private getStatus(repo: string) {
		return this.spawnGit(['status', '-s', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain', '-z'], repo, (stdout) => {
			let output = stdout.split('\0'), i = 0;
			let status: GitStatusFiles = { deleted: [], untracked: [] };
			let path = '', c1 = '', c2 = '';
			while (i < output.length && output[i] !== '') {
				if (output[i].length < 4) break;
				path = output[i].substring(3);
				c1 = output[i].substring(0, 1);
				c2 = output[i].substring(1, 2);
				if (c1 === 'D' || c2 === 'D') status.deleted.push(path);
				else if (c1 === '?' || c2 === '?') status.untracked.push(path);

				if (c1 === 'R' || c2 === 'R' || c1 === 'C' || c2 === 'C') {
					// Renames or copies
					i += 2;
				} else {
					i += 1;
				}
			}
			return status;
		});
	}


	/* Private Utils */

	/**
	 * Check if there are staged changes that resulted from a squash merge, and if so, commit them.
	 * @param repo The path of the repository.
	 * @param obj The object being squash merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param squashMessageFormat The format to be used in the commit message of the squash.
	 * @returns The ErrorInfo from the executed command.
	 */
	private commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: MergeActionOn, squashMessageFormat: SquashMessageFormat, signCommits: boolean): Promise<ErrorInfo> {
		return this.areStagedChanges(repo).then((changes) => {
			if (changes) {
				const args = ['commit'];
				if (signCommits) {
					args.push('-S');
				}
				if (squashMessageFormat === SquashMessageFormat.Default) {
					args.push('-m', 'Merge ' + actionOn.toLowerCase() + ' \'' + obj + '\'');
				} else {
					args.push('--no-edit');
				}
				return this.runGitCommand(args, repo);
			} else {
				return null;
			}
		});
	}

	/**
	 * Get the diff between two revisions.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param arg Sets the data reported from the diff.
	 * @param filter The types of file changes to retrieve.
	 * @returns The diff output.
	 */
	private execDiff(repo: string, fromHash: string, toHash: string, arg: '--numstat' | '--name-status', filter: string) {
		let args: string[];
		if (fromHash === toHash) {
			args = ['diff-tree', arg, '-r', '--root', '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
		} else {
			args = ['diff', arg, '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
			if (toHash !== '') args.push(toHash);
		}

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split('\0');
			if (fromHash === toHash) lines.shift();
			return lines;
		});
	}

	/**
	 * Run a Git command (typically for a Git Graph View action).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Graph View).
	 */
	private runGitCommand(args: string[], repo: string, extraEnv?: NodeJS.ProcessEnv): Promise<ErrorInfo> {
		return this._spawnGit(args, repo, () => null, false, extraEnv).catch((errorMessage: string) => errorMessage);
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	private spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this._spawnGit(args, repo, (stdout) => resolveValue(stdout.toString()));
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a buffer.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout` and `stderr`.
	 * @param ignoreExitCode Ignore the exit code returned by Git (default: `FALSE`).
	 */
	private _spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: Buffer, stderr: string): T }, ignoreExitCode: boolean = false, extraEnv?: NodeJS.ProcessEnv) {
		return new Promise<T>((resolve, reject) => {
			if (this.gitExecutable === null) {
				return reject(UNABLE_TO_FIND_GIT_MSG);
			}

			resolveSpawnOutput(cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv, extraEnv || {})
			})).then((values) => {
				const status = values[0], stdout = values[1], stderr = values[2];
				if (status.code === 0 || ignoreExitCode) {
					resolve(resolveValue(stdout, stderr));
				} else {
					reject(getErrorMessage(status.error, stdout, stderr));
				}
			});

			this.logger.logCmd('git', args);
		});
	}
}


/**
 * Generates the file changes from the diff output and status information.
 * @param nameStatusRecords The `--name-status` records.
 * @param numStatRecords The `--numstat` records.
 * @param status The deleted and untracked files.
 * @returns An array of file changes.
 */
function generateFileChanges(nameStatusRecords: DiffNameStatusRecord[], numStatRecords: DiffNumStatRecord[], status: GitStatusFiles | null) {
	let fileChanges: Writeable<GitFileChange>[] = [], fileLookup: { [file: string]: number } = {}, i = 0;

	for (i = 0; i < nameStatusRecords.length; i++) {
		fileLookup[nameStatusRecords[i].newFilePath] = fileChanges.length;
		fileChanges.push({ oldFilePath: nameStatusRecords[i].oldFilePath, newFilePath: nameStatusRecords[i].newFilePath, type: nameStatusRecords[i].type, additions: null, deletions: null });
	}

	if (status !== null) {
		let filePath;
		for (i = 0; i < status.deleted.length; i++) {
			filePath = getPathFromStr(status.deleted[i]);
			if (typeof fileLookup[filePath] === 'number') {
				fileChanges[fileLookup[filePath]].type = GitFileStatus.Deleted;
			} else {
				fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Deleted, additions: null, deletions: null });
			}
		}
		for (i = 0; i < status.untracked.length; i++) {
			filePath = getPathFromStr(status.untracked[i]);
			fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Untracked, additions: null, deletions: null });
		}
	}

	for (i = 0; i < numStatRecords.length; i++) {
		if (typeof fileLookup[numStatRecords[i].filePath] === 'number') {
			fileChanges[fileLookup[numStatRecords[i].filePath]].additions = numStatRecords[i].additions;
			fileChanges[fileLookup[numStatRecords[i].filePath]].deletions = numStatRecords[i].deletions;
		}
	}

	return fileChanges;
}

/**
 * Get the specified config value from a set of key-value config pairs.
 * @param configs A set key-value pairs of Git configuration records.
 * @param key The key of the desired config.
 * @returns The value for `key` if it exists, otherwise NULL.
 */
function getConfigValue(configs: GitConfigSet, key: string) {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * Produce a suitable error message from a spawned Git command that terminated with an erroneous status code.
 * @param error An error generated by JavaScript (optional).
 * @param stdoutBuffer A buffer containing the data outputted to `stdout`.
 * @param stderr A string containing the data outputted to `stderr`.
 * @returns A suitable error message.
 */
function getErrorMessage(error: Error | null, stdoutBuffer: Buffer, stderr: string) {
	let stdout = stdoutBuffer.toString(), lines: string[];
	if (stdout !== '' || stderr !== '') {
		lines = (stderr + stdout).split(EOL_REGEX);
		lines.pop();
	} else if (error) {
		lines = error.message.split(EOL_REGEX);
	} else {
		lines = [];
	}
	return lines.join('\n');
}

/**
 * Parse the output of `git blame --porcelain` into an array of blame entries.
 * @param stdout The stdout output of the git blame command.
 * @returns An array of GitBlameEntry objects.
 */
function parseGitBlame(stdout: string): GitBlameEntry[] {
	const lines = stdout.split('\n');
	const commits = new Map<string, { author: string; authorEmail: string; authorDate: number; summary: string }>();
	const result: GitBlameEntry[] = [];
	let i = 0;

	while (i < lines.length) {
		const headerMatch = lines[i].match(/^([0-9a-f]{40}) (\d+) (\d+)/);
		if (!headerMatch) {
			i++;
			continue;
		}
		const hash = headerMatch[1];
		const origLine = parseInt(headerMatch[2], 10);
		const finalLine = parseInt(headerMatch[3], 10);
		i++;

		if (!commits.has(hash)) {
			let author = '', authorEmail = '', authorDate = 0, summary = '';
			while (i < lines.length && !lines[i].startsWith('\t')) {
				const line = lines[i];
				if (line.startsWith('author ') && !line.startsWith('author-')) {
					author = line.substring(7);
				} else if (line.startsWith('author-mail ')) {
					authorEmail = line.substring(12).replace(/^<|>$/g, '');
				} else if (line.startsWith('author-time ')) {
					authorDate = parseInt(line.substring(12), 10);
				} else if (line.startsWith('summary ')) {
					summary = line.substring(8);
				}
				i++;
			}
			commits.set(hash, { author, authorEmail, authorDate, summary });
		} else {
			while (i < lines.length && !lines[i].startsWith('\t')) i++;
		}

		const entry = commits.get(hash)!;
		result.push({ hash, author: entry.author, authorEmail: entry.authorEmail, authorDate: entry.authorDate, summary: entry.summary, line: finalLine, origLine });
		i++; // skip the content line (tab-prefixed)
	}

	return result;
}

function extractHunkForLine(diffOutput: string, origLine: number): string {
	const lines = diffOutput.split('\n');
	let i = 0;
	while (i < lines.length && !lines[i].startsWith('@@')) i++;

	while (i < lines.length) {
		const hunkMatch = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (!hunkMatch) {
			i++;
			continue;
		}
		const newStart = parseInt(hunkMatch[1], 10);
		const newLen = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
		const hunkLines: string[] = [];
		i++;
		while (i < lines.length && !lines[i].startsWith('@@')) {
			hunkLines.push(lines[i]);
			i++;
		}
		if (origLine >= newStart && origLine < newStart + Math.max(newLen, 1)) {
			return extractChangeBlock(hunkLines, newStart, origLine);
		}
	}
	return '';
}

/**
 * Within a hunk, find the change block containing origLine on the + side, and
 * return just the new line plus the old line it replaced (paired by position),
 * mimicking the concise per-line diff shown by GitLens.
 */
function extractChangeBlock(hunkLines: string[], newStart: number, origLine: number): string {
	let plusLine = newStart;
	let i = 0;

	while (i < hunkLines.length) {
		const l = hunkLines[i];
		if (l.startsWith('-') || l.startsWith('+')) {
			// Collect a change block: a run of deletions followed by a run of additions.
			const dels: string[] = [];
			while (i < hunkLines.length && hunkLines[i].startsWith('-')) {
				dels.push(hunkLines[i]);
				i++;
			}
			const adds: string[] = [];
			const addLineNums: number[] = [];
			while (i < hunkLines.length && hunkLines[i].startsWith('+')) {
				adds.push(hunkLines[i]);
				addLineNums.push(plusLine);
				plusLine++;
				i++;
			}

			const addIdx = addLineNums.indexOf(origLine);
			if (addIdx >= 0) {
				const out: string[] = [];
				// Pair with the deletion at the same position, or show an empty
				// placeholder when the line is brand new (no line replaced), like GitLens.
				out.push(addIdx < dels.length ? dels[addIdx] : '-');
				out.push(adds[addIdx]);
				return out.join('\n');
			}
		} else {
			// context line
			plusLine++;
			i++;
		}
	}

	return '';
}

/**
 * Remove trailing blank lines from an array of lines.
 * @param lines The array of lines.
 * @returns The same array.
 */
function removeTrailingBlankLines(lines: string[]) {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Get all the unique strings from an array of strings.
 * @param items The array of strings with duplicates.
 * @returns An array of unique strings.
 */
function unique(items: ReadonlyArray<string>) {
	const uniqueItems: { [item: string]: true } = {};
	items.forEach((item) => uniqueItems[item] = true);
	return Object.keys(uniqueItems);
}


/* Types */

interface DiffNameStatusRecord {
	type: GitFileStatus;
	oldFilePath: string;
	newFilePath: string;
}

interface DiffNumStatRecord {
	filePath: string;
	additions: number;
	deletions: number;
}

interface GitBranchData {
	branches: string[];
	head: string | null;
	error: ErrorInfo;
}

interface GitCommitRecord {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	date: number;
	message: string;
}

interface GitCommitData {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	error: ErrorInfo;
}

export interface GitCommitDetailsData {
	commitDetails: GitCommitDetails | null;
	error: ErrorInfo;
}

/**
 * Build the ordered queue of commit-message overrides applied during an interactive rebase, one
 * item per editor stop git will make (top-down). A string overrides the message for that stop; null
 * means there's no override, so the user is shown git's default message (e.g. the combined squash
 * message) in their configured editor to review/edit. Plans containing `edit` return an empty queue
 * (all defaults preserved) to avoid misaligning the queue with git's unpredictable stops.
 * @param entries The ordered interactive rebase entries.
 * @returns The ordered queue of message overrides.
 */
export function buildInteractiveRebaseEditorQueue(entries: ReadonlyArray<{ action: string; message?: string }>): (string | null)[] {
	if (entries.some((e) => e.action === 'edit')) {
		return [];
	}
	const eff = entries.filter((e) => e.action !== 'drop');
	const queue: (string | null)[] = [];
	let i = 0;
	while (i < eff.length) {
		const leader = eff[i];
		i++;
		let hasSquash = leader.action === 'squash';
		while (i < eff.length && (eff[i].action === 'squash' || eff[i].action === 'fixup')) {
			if (eff[i].action === 'squash') {
				hasSquash = true;
			}
			i++;
		}
		if (leader.action === 'reword' || hasSquash) {
			const msg = leader.message;
			queue.push(typeof msg === 'string' && msg.trim() !== '' ? msg : null);
		}
	}
	return queue;
}

export interface InteractiveRebaseTodoEntry {
	readonly hash: string;
	readonly subject: string;
	readonly author: string;
	readonly relativeDate: string;
}

export interface InteractiveRebaseData {
	readonly base: InteractiveRebaseTodoEntry;
	readonly entries: InteractiveRebaseTodoEntry[];
	readonly headName?: string;
}

interface GitCommitComparisonData {
	fileChanges: GitFileChange[];
	error: ErrorInfo;
}

type GitConfigSet = { [key: string]: string };

interface GitRef {
	hash: string;
	name: string;
}

interface GitRefTag extends GitRef {
	annotated: boolean;
}

interface GitRefData {
	head: string | null;
	heads: GitRef[];
	tags: GitRefTag[];
	remotes: GitRef[];
}

interface GitRepoInfo extends GitBranchData {
	remotes: string[];
	stashes: GitStash[];
}

interface GitRepoConfigData {
	config: GitRepoConfig | null;
	error: ErrorInfo;
}

interface GitStatusFiles {
	deleted: string[];
	untracked: string[];
}

interface GitTagDetailsData {
	details: GitTagDetails | null;
	error: ErrorInfo;
}

interface GpgStatusCodeParsingDetails {
	readonly status: GitSignatureStatus,
	readonly uid: boolean
}

import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { BlameAnnotationProvider } from './blameAnnotationProvider';
import { CommandManager } from './commands';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { ExtensionState } from './extensionState';
import { onStartUp } from './life-cycle/startup';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { StatusBarItem } from './statusBarItem';
import { InteractiveRebasePanel } from './interactiveRebase';
import { GitExecutable, UNABLE_TO_FIND_GIT_MSG, findGit, getGitExecutableFromPaths, showErrorMessage, showInformationMessage } from './utils';
import { EventEmitter } from './utils/event';

/**
 * Activate Git Graph.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger();
	logger.log('Starting Git Graph ...');

	const gitExecutableEmitter = new EventEmitter<GitExecutable>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;

	const extensionState = new ExtensionState(context, onDidChangeGitExecutable);

	let gitExecutable: GitExecutable | null;
	try {
		gitExecutable = await findGit(extensionState);
		gitExecutableEmitter.emit(gitExecutable);
		logger.log('Using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
	} catch (_) {
		gitExecutable = null;
		showErrorMessage(UNABLE_TO_FIND_GIT_MSG);
		logger.logError(UNABLE_TO_FIND_GIT_MSG);
	}

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;

	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const commandManager = new CommandManager(context, avatarManager, dataSource, extensionState, repoManager, gitExecutable, onDidChangeGitExecutable, logger);
	const diffDocProvider = new DiffDocProvider(dataSource);
	const blameAnnotationProvider = new BlameAnnotationProvider(dataSource);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-graph-plus')) {
				configurationEmitter.emit(event);
			} else if (event.affectsConfiguration('git.path')) {
				const paths = getConfig().gitPaths;
				if (paths.length === 0) return;

				getGitExecutableFromPaths(paths).then((gitExecutable) => {
					gitExecutableEmitter.emit(gitExecutable);
					const msg = 'Git Graph is now using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')';
					showInformationMessage(msg);
					logger.log(msg);
					repoManager.searchWorkspaceForRepos();
				}, () => {
					const msg = 'The new value of "git.path" ("' + paths.join('", "') + '") does not ' + (paths.length > 1 ? 'contain a string that matches' : 'match') + ' the path and filename of a valid Git executable.';
					showErrorMessage(msg);
					logger.logError(msg);
				});
			}
		}),
		diffDocProvider,
		commandManager,
		statusBarItem,
		repoManager,
		avatarManager,
		dataSource,
		blameAnnotationProvider,
		vscode.commands.registerCommand('git-graph-plus.toggleInlineBlame', async () => {
			const config = vscode.workspace.getConfiguration('git-graph-plus');
			const current = config.get<boolean>('inlineBlame.enabled', true);
			await config.update('inlineBlame.enabled', !current, vscode.ConfigurationTarget.Global);
		}),
		configurationEmitter,
		extensionState,
		gitExecutableEmitter,
		logger
	);
	logger.log('Started Git Graph - Ready to use!');

	// Intercept `git rebase -i` when git opens git-rebase-todo in VS Code
	// (requires `core.editor = code --wait` in .gitconfig).
	// When the file is detected, we open our visual panel instead of the raw text editor.
	const GIT_REBASE_TODO_REGEX = /[/\\]\.git[/\\]rebase-merge[/\\]git-rebase-todo$/;
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(async (editor) => {
			if (!editor) return;
			const filePath = editor.document.uri.fsPath;
			if (!GIT_REBASE_TODO_REGEX.test(filePath)) return;

			// Keep the document open (tab stays alive = `code --wait` process alive).
			// Our panel will close it after writing the modified todo file.
			const error = await InteractiveRebasePanel.launchFromFile(filePath, dataSource);
			if (error) {
				showErrorMessage('Git Graph: ' + error);
			}
		})
	);

	extensionState.expireOldCodeReviews();
	onStartUp(context).catch(() => { });
}

/**
 * Deactivate Git Graph.
 */
export function deactivate() { }

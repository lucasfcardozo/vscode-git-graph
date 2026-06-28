import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { GitBlameEntry } from './types';
import { getRelativeTimeDiff } from './utils';
import { Disposable } from './utils/disposable';

const UNCOMMITTED_HASH = '0000000000000000000000000000000000000000';
const MAX_SUMMARY_LEN = 45;

/**
 * Provides inline Git blame annotations on the line where the cursor is located.
 * Shows author, relative time and commit message as ghost text, with a rich hover
 * tooltip containing the avatar, full message and file diff.
 */
export class BlameAnnotationProvider extends Disposable {
	private readonly dataSource: DataSource;
	private readonly decorationType: vscode.TextEditorDecorationType;
	private blameCache: Map<string, GitBlameEntry[]> = new Map();
	private diffCache: Map<string, string> = new Map();
	private repoCache: Map<string, string> = new Map();
	private pendingLoad: NodeJS.Timer | null = null;

	constructor(dataSource: DataSource) {
		super();
		this.dataSource = dataSource;

		this.decorationType = vscode.window.createTextEditorDecorationType({
			after: {
				margin: '0 0 0 3em',
				color: new vscode.ThemeColor('editorGhostText.foreground'),
				fontStyle: 'italic'
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
		});

		this.registerDisposables(
			this.decorationType,
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				this.scheduleLoad(editor);
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				this.decorateCursorLine(event.textEditor);
			}),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				const editor = vscode.window.activeTextEditor;
				if (editor && editor.document === doc) {
					this.blameCache.delete(doc.uri.fsPath);
					this.scheduleLoad(editor);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				const editor = vscode.window.activeTextEditor;
				if (editor && editor.document === event.document) {
					this.blameCache.delete(event.document.uri.fsPath);
					editor.setDecorations(this.decorationType, []);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph-plus.inlineBlame.enabled')) {
					this.scheduleLoad(vscode.window.activeTextEditor);
				}
			})
		);

		this.scheduleLoad(vscode.window.activeTextEditor);
	}

	private scheduleLoad(editor: vscode.TextEditor | undefined) {
		if (this.pendingLoad !== null) {
			clearTimeout(this.pendingLoad);
		}
		this.pendingLoad = setTimeout(() => {
			this.pendingLoad = null;
			this.loadAndDecorate(editor);
		}, 300);
	}

	private async loadAndDecorate(editor: vscode.TextEditor | undefined) {
		if (!editor || editor.document.uri.scheme !== 'file') {
			return;
		}

		if (!getConfig().inlineBlameEnabled) {
			editor.setDecorations(this.decorationType, []);
			return;
		}

		const filePath = editor.document.uri.fsPath;

		if (!this.blameCache.has(filePath)) {
			const dirPath = path.dirname(filePath);
			const repoPath = await this.dataSource.repoRoot(dirPath).catch(() => null);
			if (!repoPath) {
				return;
			}
			this.repoCache.set(filePath, repoPath);
			const entries = await this.dataSource.getBlame(repoPath, filePath);
			this.blameCache.set(filePath, entries);
		}

		this.decorateCursorLine(editor);
	}

	private decorateCursorLine(editor: vscode.TextEditor) {
		if (!editor || editor.document.uri.scheme !== 'file') {
			return;
		}

		if (!getConfig().inlineBlameEnabled) {
			editor.setDecorations(this.decorationType, []);
			return;
		}

		const filePath = editor.document.uri.fsPath;
		const entries = this.blameCache.get(filePath);
		if (!entries || entries.length === 0) {
			return;
		}

		const cursorLine = editor.selection.active.line;
		const entry = entries.find((e) => e.line - 1 === cursorLine);

		if (!entry) {
			editor.setDecorations(this.decorationType, []);
			return;
		}

		const line = editor.document.lineAt(cursorLine);
		const range = new vscode.Range(cursorLine, line.range.end.character, cursorLine, line.range.end.character);
		const isUncommitted = entry.hash === UNCOMMITTED_HASH;
		const summary = entry.summary.length > MAX_SUMMARY_LEN
			? entry.summary.substring(0, MAX_SUMMARY_LEN) + '\u2026'
			: entry.summary;

		const inlineText = isUncommitted
			? '  Uncommitted changes'
			: `  ${entry.author}, ${getRelativeTimeDiff(entry.authorDate)} \u2022 ${summary}`;

		const hoverMessage = isUncommitted ? undefined : this.buildHoverMessage(entry, filePath);

		editor.setDecorations(this.decorationType, [{
			range,
			hoverMessage,
			renderOptions: {
				after: { contentText: inlineText }
			}
		}]);

		// If the diff for this specific line hasn't been fetched yet, fetch it in
		// the background and refresh the hover once it is available.
		const diffKey = entry.hash + ':' + filePath + ':' + entry.origLine;
		if (!isUncommitted && !this.diffCache.has(diffKey)) {
			this.fetchDiffAndRefresh(editor, entry, filePath, range, inlineText);
		}
	}

	private async fetchDiffAndRefresh(
		editor: vscode.TextEditor,
		entry: GitBlameEntry,
		filePath: string,
		range: vscode.Range,
		inlineText: string
	) {
		const diffKey = entry.hash + ':' + filePath + ':' + entry.origLine;
		if (this.diffCache.has(diffKey)) {
			return;
		}

		const repoPath = this.repoCache.get(filePath);
		if (!repoPath) {
			return;
		}

		const relPath = filePath.startsWith(repoPath)
			? filePath.substring(repoPath.length).replace(/^[\/\\]/, '')
			: filePath;

		const diff = await this.dataSource.getFileDiffForBlame(repoPath, entry.hash, relPath, entry.origLine);
		this.diffCache.set(diffKey, diff);

		// Only update if cursor is still on the same line/hash
		if (editor.document.isClosed) {
			return;
		}

		const currentEntries = this.blameCache.get(filePath);
		const cursorLine = editor.selection.active.line;
		const current = currentEntries && currentEntries.find((e) => e.line - 1 === cursorLine);
		if (!current || current.hash !== entry.hash) {
			return;
		}

		editor.setDecorations(this.decorationType, [{
			range,
			hoverMessage: this.buildHoverMessage(entry, filePath),
			renderOptions: {
				after: { contentText: inlineText }
			}
		}]);
	}

	private buildHoverMessage(entry: GitBlameEntry, filePath: string): vscode.MarkdownString {
		const emailHash = crypto.createHash('md5').update(entry.authorEmail.toLowerCase().trim()).digest('hex');
		const avatarUrl = `https://www.gravatar.com/avatar/${emailHash}?s=20&d=identicon`;
		const relTime = getRelativeTimeDiff(entry.authorDate);
		const date = new Date(entry.authorDate * 1000).toLocaleString();

		const md = new vscode.MarkdownString();
		md.isTrusted = true;

		md.appendMarkdown(`![](${avatarUrl})&nbsp;&nbsp;**${escapeMarkdown(entry.author)}** &lt;${escapeMarkdown(entry.authorEmail)}&gt;\n\n`);
		md.appendMarkdown(`${escapeMarkdown(entry.summary)}\n\n`);
		md.appendMarkdown('---\n\n');
		md.appendMarkdown(`\`${entry.hash.substring(0, 8)}\` &nbsp; ${relTime} &nbsp; *(${date})*\n\n`);

		const diffKey = entry.hash + ':' + filePath + ':' + entry.origLine;
		const diff = this.diffCache.get(diffKey);
		if (diff) {
			md.appendMarkdown(`\`\`\`diff\n${diff}\n\`\`\`\n`);
		}

		return md;
	}

	public dispose() {
		if (this.pendingLoad !== null) {
			clearTimeout(this.pendingLoad);
			this.pendingLoad = null;
		}
		super.dispose();
	}
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

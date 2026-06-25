import * as vscode from 'vscode';
import { DataSource, InteractiveRebaseData, InteractiveRebaseTodoEntry } from './dataSource';
import { getNonce } from './utils';

export type InteractiveRebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface InteractiveRebaseEntryState {
	action: InteractiveRebaseAction;
	hash: string;
	subject: string;
}

interface WebviewMessage {
	command: string;
	entries?: InteractiveRebaseEntryState[];
}

/**
 * Manages the Visual Interactive Rebase WebView Panel.
 */
export class InteractiveRebasePanel {
	private static currentPanel: InteractiveRebasePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly repo: string;
	private readonly obj: string;
	private readonly dataSource: DataSource;
	private readonly todoFilePath: string | null;
	private readonly subscriptions: vscode.Disposable[] = [];

	/**
	 * Launch the Visual Interactive Rebase panel for the given repository and base object.
	 * @param repo The path of the repository.
	 * @param obj The branch or commit to rebase onto.
	 * @param dataSource The DataSource instance.
	 * @returns An error string if something went wrong, or null on success.
	 */
	public static async launch(repo: string, obj: string, dataSource: DataSource): Promise<string | null> {
		if (InteractiveRebasePanel.currentPanel) {
			InteractiveRebasePanel.currentPanel.panel.dispose();
		}

		const result = await dataSource.getInteractiveRebaseTodos(repo, obj);
		if (typeof result === 'string') {
			return result;
		}
		if (result.entries.length === 0) {
			return 'There are no commits to rebase.';
		}

		InteractiveRebasePanel.currentPanel = new InteractiveRebasePanel(repo, obj, result, dataSource, null);
		return null;
	}

	/**
	 * Intercept a git-rebase-todo file opened by `git rebase -i` from the terminal.
	 * Parses the file, shows the visual panel, and writes back on save.
	 * @param todoFilePath Absolute path to the git-rebase-todo file.
	 * @param dataSource The DataSource instance.
	 * @returns An error string on failure, or null on success.
	 */
	public static async launchFromFile(todoFilePath: string, dataSource: DataSource): Promise<string | null> {
		if (InteractiveRebasePanel.currentPanel) {
			InteractiveRebasePanel.currentPanel.panel.dispose();
		}

		const result = await dataSource.getInteractiveRebaseTodosFromFile(todoFilePath);
		if (typeof result === 'string') {
			return result;
		}
		if (result.entries.length === 0) {
			return 'There are no commits to rebase.';
		}

		InteractiveRebasePanel.currentPanel = new InteractiveRebasePanel('', '', result, dataSource, todoFilePath);
		return null;
	}

	private constructor(repo: string, obj: string, data: InteractiveRebaseData, dataSource: DataSource, todoFilePath: string | null) {
		this.repo = repo;
		this.obj = obj;
		this.dataSource = dataSource;
		this.todoFilePath = todoFilePath;

		// In file-intercept mode, use the branch name from the todo file metadata
		const displayLabel = data.headName || obj;

		this.panel = vscode.window.createWebviewPanel(
			'git-graph-interactive-rebase',
			'Interactive Rebase',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		this.panel.webview.html = this.getHtml(data.base, data.entries, displayLabel);

		this.subscriptions.push(
			this.panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
				if (msg.command === 'startRebase' && msg.entries) {
					await this.handleStartRebase(msg.entries);
				} else if (msg.command === 'cancel') {
					if (this.todoFilePath) {
						// In file-intercept mode, also close the todo file tab so
						// `code --wait` exits and git proceeds with the unmodified picks.
						await InteractiveRebasePanel.closeTodoDocument(this.todoFilePath);
					}
					this.panel.dispose();
				}
			})
		);

		this.panel.onDidDispose(() => {
			this.subscriptions.forEach((s) => s.dispose());
			this.subscriptions.length = 0;
			InteractiveRebasePanel.currentPanel = undefined;
		});
	}

	private async handleStartRebase(entries: InteractiveRebaseEntryState[]) {
		if (this.todoFilePath) {
			// File-intercept mode: write back to the todo file, then close the
			// text document so `code --wait` exits and git reads the modified file.
			const error = this.dataSource.writeRebaseTodoFile(this.todoFilePath, entries);
			if (error) {
				this.panel.webview.postMessage({ command: 'error', message: error });
				return;
			}
			await InteractiveRebasePanel.closeTodoDocument(this.todoFilePath);
			this.panel.dispose();
		} else {
			// Run mode: start the rebase via DataSource.
			const error = await this.dataSource.rebaseInteractiveWithEntries(this.repo, this.obj, entries);
			if (error) {
				this.panel.webview.postMessage({ command: 'error', message: error });
			} else {
				this.panel.dispose();
			}
		}
	}

	/** Close the git-rebase-todo text document tab so `code --wait` can exit. */
	private static async closeTodoDocument(todoFilePath: string): Promise<void> {
		const uri = vscode.Uri.file(todoFilePath);
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
		if (!doc) return;
		try {
			await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
			await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		} catch (_) { /* ignore */ }
	}

	private getHtml(base: InteractiveRebaseTodoEntry, entries: InteractiveRebaseTodoEntry[], displayLabel?: string): string {
		const nonce = getNonce();

		const initialEntries = entries.map((e) => ({
			action: 'pick',
			hash: e.hash,
			subject: e.subject,
			relativeDate: e.relativeDate
		}));

		// Safely serialize for embedding in <script>; prevent </script> tag close and <!-- injection.
		const entriesJson = JSON.stringify(initialEntries)
			.replace(/<\/script>/gi, '<\\/script>')
			.replace(/<!--/g, '<\\!--');

		function esc(s: string) {
			return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}

		const count = entries.length;
		const isMac = process.platform === 'darwin';
		const altKey = isMac ? '\u2325' : 'Alt'; // ⌥ on Mac, Alt elsewhere
		const ctrlKey = isMac ? '\u2318' : 'Ctrl'; // ⌘ on Mac, Ctrl elsewhere
		const rawLabel = displayLabel || this.obj;
		const branchLabel = esc(/^[0-9a-f]{40}$/i.test(rawLabel) ? rawLabel.substring(0, 7) : rawLabel);
		const baseHash = esc(base.hash.substring(0, 7));
		const baseSubject = esc(base.subject);
		const baseDate = esc(base.relativeDate);

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Interactive Rebase</title>
<style nonce="${nonce}">
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
	font-family: var(--vscode-font-family);
	font-size: 14px;
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	display: flex;
	flex-direction: column;
	height: 100vh;
	overflow: hidden;
}

/* ── Controls bar — matches #controls from main.css ── */
#topbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 14px;
	border-bottom: 1px solid rgba(128,128,128,0.5);
	height: 42px;
	line-height: 42px;
	font-size: 16px;
	font-weight: 700;
	user-select: none;
	flex-shrink: 0;
	white-space: nowrap;
	overflow: hidden;
}
#topbar-meta {
	font-weight: 400;
	font-size: 13px;
	opacity: 0.75;
	overflow: hidden;
	text-overflow: ellipsis;
	margin-left: 10px;
	flex: 1;
}
#sort-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	height: 24px;
	padding: 0 10px;
	border: 1px solid rgba(128,128,128,0.4);
	border-radius: 5px;
	background: rgba(128,128,128,0.08);
	color: inherit;
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	user-select: none;
	white-space: nowrap;
	flex-shrink: 0;
}
#sort-btn:hover { background: rgba(128,128,128,0.18); border-color: rgba(128,128,128,0.6); }
code.ref {
	font-family: var(--vscode-editor-font-family, monospace);
}

/* ── Error banner ── */
#error-banner {
	display: none;
	padding: 5px 12px;
	border-bottom: 1px solid rgba(255,0,0,0.3);
	background-color: rgba(255,0,0,0.08);
	font-size: 12px;
	word-break: break-word;
	flex-shrink: 0;
}

/* ── Entry list ── */
#entry-list {
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 6px 8px 6px 2px;
}

/* ── Shared row wrapper (timeline + card) ── */
.entry, .base-row {
	display: grid;
	grid-template-columns: 20px 1fr;
	align-items: center;
	height: 38px;
	margin: 3px 0;
	user-select: none;
}
.base-row { opacity: 0.85; margin-bottom: 8px; }

/* ── Card: the bordered box containing action+subject+date+hash ── */
.entry-card {
	display: grid;
	grid-template-columns: 116px 1fr 90px 56px;
	align-items: center;
	height: 36px;
	border: 1px solid transparent;
	border-radius: 4px;
	padding-right: 5px;
	position: relative;
	transition: border-color 0.1s, background-color 0.1s, box-shadow 0.1s;
}
.base-card {
	display: grid;
	grid-template-columns: 1fr 90px 56px;
	align-items: center;
	height: 36px;
	padding-left: 8px;
	padding-right: 5px;
	border-bottom: 1px solid rgba(128,128,128,0.25);
	background: rgba(128,128,128,0.07);
	border-radius: 4px;
}

/* ── Interactive row states ── */
.entry { cursor: default; }
.entry:hover .entry-card { background: rgba(128,128,128,0.07); }
.entry.selected .entry-card { background: rgba(128,128,128,0.14); border-color: rgba(128,128,128,0.6); }
.entry.dragging .entry-card { opacity: 0.2; }
.entry.drag-over .entry-card { border-top: 2px solid rgba(128,128,128,0.7); }
.entry[data-action="drop"] .row-subject,
.entry[data-action="drop"] .row-date,
.entry[data-action="drop"] .row-hash { opacity: 0.4; text-decoration: line-through; }

/* ── Per-action accent colours (GitLens-style) ── */
.entry { --accent: rgba(128,128,128,0.8); }
.entry[data-action="reword"] { --accent: #3794ff; }
.entry[data-action="edit"]   { --accent: #e8a33d; }
.entry[data-action="squash"] { --accent: #b180d7; }
.entry[data-action="fixup"]  { --accent: #4ec9b0; }
.entry[data-action="drop"]   { --accent: #f14c4c; }
.entry .row-dot { border-color: var(--accent); }
.entry:not([data-action="pick"]) .entry-card { box-shadow: inset 3px 0 0 var(--accent); border-color: var(--accent); }
.entry.selected:not([data-action="pick"]) .entry-card { border-color: var(--accent); }
.entry:not([data-action="pick"]) .action-dd-btn { border-color: var(--accent); color: var(--accent); }

/* ── Timeline (col 1, 20px wide) ── */
.row-timeline {
	position: relative;
	width: 20px;
	height: 38px;
	display: flex;
	align-items: center;
	justify-content: center;
}
.row-timeline::before, .row-timeline::after {
	content: '';
	position: absolute;
	left: 50%; transform: translateX(-50%);
	width: 1px;
	background: rgba(128,128,128,0.4);
}
/* Extend line through the 3px margin gaps between rows */
.row-timeline::before { top: -3px; bottom: calc(50% + 7px); }
.row-timeline::after  { top: calc(50% + 7px); bottom: -3px; }
.base-row .row-timeline::before { display: none; }
.base-row.reversed .row-timeline::before { display: block; }
.base-row.reversed .row-timeline::after { display: none; }
.entry:last-child .row-timeline::after { display: none; }
.row-dot {
	width: 10px; height: 10px;
	border-radius: 50%;
	border: 2px solid rgba(128,128,128,0.8);
	background: var(--vscode-editor-background);
	position: relative; z-index: 1;
}
.base-row .row-dot { width: 8px; height: 8px; border-color: rgba(128,128,128,0.6); }
.entry.selected .row-dot { background: rgba(128,128,128,0.6); }

/* ── Action (first col of card) ── */
.row-action {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 4px;
	height: 100%;
}
.drag-handle {
	cursor: grab;
	opacity: 0;
	font-size: 12px;
	line-height: 1;
	flex-shrink: 0;
	color: rgba(128,128,128,0.8);
}
.entry:hover .drag-handle { opacity: 1; }
.drag-handle:active { cursor: grabbing; }

/* ── Custom action dropdown ── */
.action-dd { position: relative; flex: 1; }
.action-dd-btn {
	display: flex;
	align-items: center;
	width: 100%;
	height: 22px;
	padding: 0 5px 0 7px;
	background-color: rgba(128,128,128,0.1);
	border: 1px solid rgba(128,128,128,0.45);
	border-radius: 4px;
	cursor: pointer;
	font-size: 13px;
	color: inherit;
	gap: 4px;
	user-select: none;
}
.action-dd-btn:hover { border-color: rgba(128,128,128,0.7); background-color: rgba(128,128,128,0.15); }
.action-dd-label { flex: 1; }
.action-dd-caret { font-size: 8px; opacity: 0.6; flex-shrink: 0; }
.action-dd-list {
	display: none;
	position: fixed;
	min-width: 100px;
	background: var(--vscode-dropdown-background, var(--vscode-editor-background));
	border: 1px solid rgba(128,128,128,0.5);
	border-radius: 4px;
	z-index: 9999;
	padding: 3px 0;
	box-shadow: 0 4px 14px rgba(0,0,0,0.35);
	list-style: none;
}
.action-dd.open .action-dd-list { display: block; }
.action-dd-list li {
	padding: 5px 12px;
	cursor: pointer;
	font-size: 13px;
	white-space: nowrap;
}
.action-dd-list li:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
.action-dd-list li.active { background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,0.2)); font-weight: 600; }

/* ── Subject (col 3) ── */
.row-subject {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	padding-left: 6px;
	padding-right: 8px;
}
.base-card .row-subject { padding-left: 0; }

/* ── Date (col 4) ── */
.row-date {
	font-size: 13px;
	opacity: 0.7;
	white-space: nowrap;
	text-align: right;
	padding-right: 6px;
}

/* ── Hash (col 5) ── */
.row-hash {
	font-family: var(--vscode-editor-font-family, monospace);
	font-size: 13px;
	opacity: 0.65;
	white-space: nowrap;
	text-align: right;
}

/* ── Footer ── */
#footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 6px 12px;
	border-top: 1px solid rgba(128,128,128,0.5);
	flex-shrink: 0;
}
#footer-hints {
	display: flex;
	flex-wrap: wrap;
	gap: 0 12px;
	font-size: 11px;
	opacity: 0.55;
	user-select: none;
}
.sc { white-space: nowrap; line-height: 19px; }
.sc u { text-decoration: underline; text-underline-offset: 2px; }
#footer-btns { display: flex; gap: 8px; flex-shrink: 0; }
.roundedBtn {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 28px;
	line-height: 26px;
	padding: 0 15px;
	border: 1px solid rgba(128,128,128,0.5);
	border-radius: 5px;
	background-color: rgba(128,128,128,0.1);
	color: inherit;
	font-family: inherit;
	font-size: 13px;
	cursor: pointer;
	user-select: none;
}
.roundedBtn:hover { background-color: rgba(128,128,128,0.2); }
.roundedBtn:disabled { opacity: 0.5; cursor: default; pointer-events: none; }
#abortBtn { border-color: rgba(200,60,60,0.45); color: var(--vscode-errorForeground, #f07070); border-radius: 5px; }
#abortBtn:hover { background: rgba(200,60,60,0.12); border-color: rgba(200,60,60,0.7); }
#startBtn { background: var(--vscode-button-background, rgba(0,120,212,0.85)); color: var(--vscode-button-foreground, #fff); border-color: transparent; border-radius: 5px; }
#startBtn:hover { background: var(--vscode-button-hoverBackground, rgba(0,120,212,1)); }
.kbd-hint { font-size: 11px; opacity: 0.6; }
.spinner {
	display: none;
	width: 10px; height: 10px;
	border: 1.5px solid rgba(128,128,128,0.6);
	border-top-color: var(--vscode-foreground);
	border-radius: 50%;
	animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.roundedBtn.loading .spinner { display: inline-block; }
.roundedBtn.loading .btn-label { opacity: 0.65; }
</style>
</head>
<body>

<div id="topbar">
	<span>Git Graph &middot; Interactive Rebase</span>
	<span id="topbar-meta"><code class="ref">${branchLabel}</code>&nbsp;onto&nbsp;<code class="ref">${baseHash}</code>&nbsp;&middot;&nbsp;${count}&nbsp;${count === 1 ? 'commit' : 'commits'}</span>
	<button id="sort-btn" title="Toggle commit order">&#x2191;&#x2193;&nbsp;Oldest first</button>
</div>

<div id="error-banner"></div>

<div id="entry-list">
	<div class="base-row">
		<div class="row-timeline"><div class="row-dot"></div></div>
		<div class="base-card">
			<div class="row-subject" title="${baseSubject}">${baseSubject}</div>
			<div class="row-date">${baseDate}</div>
			<div class="row-hash">${baseHash}</div>
		</div>
	</div>
</div>

<div id="footer">
	<div id="footer-hints">
		<span class="sc"><u>p</u>ick</span>
		<span class="sc"><u>r</u>eword</span>
		<span class="sc"><u>e</u>dit</span>
		<span class="sc"><u>s</u>quash</span>
		<span class="sc"><u>f</u>ixup</span>
		<span class="sc"><u>d</u>rop</span>
		<span class="sc">${altKey}+&#x2191;&#x2193;&nbsp;move</span>
		<span class="sc">&#x2191;&#x2193;&nbsp;select</span>
	</div>
	<div id="footer-btns">
		<button class="roundedBtn" id="abortBtn">Abort</button>
		<button class="roundedBtn" id="startBtn"><span class="spinner"></span><span class="btn-label">Start Rebase</span><span class="kbd-hint">&nbsp;${ctrlKey}+Enter</span></button>
	</div>
</div>

<script nonce="${nonce}">
(function() {
	const vscode = acquireVsCodeApi();

	let entries = ${entriesJson};
	let draggingIndex = -1;
	let selectedIndex = -1;

	function render(keepSel) {
		const list = document.getElementById('entry-list');
		list.querySelectorAll('.entry').forEach(function(el) { el.remove(); });
		entries.forEach(function(entry, i) { list.appendChild(makeRow(entry, i)); });
		if (keepSel && selectedIndex >= 0 && selectedIndex < entries.length) setSelected(selectedIndex);
	}

	function makeRow(entry, index) {
		const row = document.createElement('div');
		row.className = 'entry';
		row.dataset.index = String(index);
		row.dataset.action = entry.action;
		row.draggable = true;

		const timeline = document.createElement('div');
		timeline.className = 'row-timeline';
		const dot = document.createElement('div');
		dot.className = 'row-dot';
		timeline.appendChild(dot);

		const actionCell = document.createElement('div');
		actionCell.className = 'row-action';
		const handle = document.createElement('span');
		handle.className = 'drag-handle';
		handle.textContent = '\\u2807';
		handle.title = 'Drag to reorder';

		const dd = document.createElement('div');
		dd.className = 'action-dd';
		const ddBtn = document.createElement('div');
		ddBtn.className = 'action-dd-btn';
		const ddLabel = document.createElement('span');
		ddLabel.className = 'action-dd-label';
		ddLabel.textContent = entry.action;
		const ddCaret = document.createElement('span');
		ddCaret.className = 'action-dd-caret';
		ddCaret.textContent = '\u25be';
		ddBtn.appendChild(ddLabel);
		ddBtn.appendChild(ddCaret);
		const ddList = document.createElement('ul');
		ddList.className = 'action-dd-list';
		['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'].forEach(function(a) {
			const li = document.createElement('li');
			li.textContent = a;
			if (a === entry.action) li.classList.add('active');
			li.addEventListener('mousedown', function(e) {
				e.stopPropagation();
				setAction(index, a);
				dd.classList.remove('open');
			});
			ddList.appendChild(li);
		});
		dd.appendChild(ddBtn);
		dd.appendChild(ddList);
		actionCell.appendChild(handle);
		actionCell.appendChild(dd);

		const subject = document.createElement('div');
		subject.className = 'row-subject';
		subject.textContent = entry.subject;
		subject.title = entry.subject;

		const date = document.createElement('div');
		date.className = 'row-date';
		date.textContent = entry.relativeDate || '';

		const hashCell = document.createElement('div');
		hashCell.className = 'row-hash';
		hashCell.textContent = entry.hash.substring(0, 7);

		const card = document.createElement('div');
		card.className = 'entry-card';
		card.appendChild(actionCell);
		card.appendChild(subject);
		card.appendChild(date);
		card.appendChild(hashCell);

		row.appendChild(timeline);
		row.appendChild(card);

		row.addEventListener('mousedown', function(e) { if (!e.target.closest('.action-dd')) setSelected(index); });
		ddBtn.addEventListener('mousedown', function(e) {
			e.stopPropagation();
			setSelected(index);
			if (dd.classList.contains('open')) {
				dd.classList.remove('open');
			} else {
				document.querySelectorAll('.action-dd.open').forEach(function(d) { d.classList.remove('open'); });
				const rect = ddBtn.getBoundingClientRect();
				ddList.style.top = (rect.bottom + 2) + 'px';
				ddList.style.left = rect.left + 'px';
				dd.classList.add('open');
			}
		});

		row.addEventListener('dragstart', function(e) {
			draggingIndex = parseInt(row.dataset.index);
			row.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
		});
		row.addEventListener('dragend', function() {
			row.classList.remove('dragging');
			document.querySelectorAll('.entry').forEach(function(el) { el.classList.remove('drag-over'); });
		});
		row.addEventListener('dragover', function(e) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			document.querySelectorAll('.entry').forEach(function(el) { el.classList.remove('drag-over'); });
			row.classList.add('drag-over');
		});
		row.addEventListener('dragleave', function() { row.classList.remove('drag-over'); });
		row.addEventListener('drop', function(e) {
			e.preventDefault();
			row.classList.remove('drag-over');
			const target = parseInt(row.dataset.index);
			if (draggingIndex >= 0 && draggingIndex !== target) {
				const moved = entries.splice(draggingIndex, 1)[0];
				entries.splice(target, 0, moved);
				const newSel = draggingIndex === selectedIndex ? target
					: (selectedIndex > draggingIndex && selectedIndex <= target) ? selectedIndex - 1
					: (selectedIndex < draggingIndex && selectedIndex >= target) ? selectedIndex + 1
					: selectedIndex;
				selectedIndex = -1;
				render(false);
				setSelected(newSel);
			}
		});
		return row;
	}

	function setSelected(i) {
		document.querySelectorAll('.entry.selected').forEach(function(el) { el.classList.remove('selected'); });
		selectedIndex = i;
		if (i < 0 || i >= entries.length) return;
		const rows = document.querySelectorAll('.entry');
		if (rows[i]) { rows[i].classList.add('selected'); rows[i].scrollIntoView({ block: 'nearest' }); }
	}

	function setAction(i, action) {
		entries[i].action = action;
		const rows = document.querySelectorAll('.entry');
		if (!rows[i]) return;
		rows[i].dataset.action = action;
		const lbl = rows[i].querySelector('.action-dd-label');
		if (lbl) lbl.textContent = action;
		rows[i].querySelectorAll('.action-dd-list li').forEach(function(li) {
			li.classList.toggle('active', li.textContent === action);
		});
	}

	function moveEntry(from, to) {
		if (to < 0 || to >= entries.length) return;
		const moved = entries.splice(from, 1)[0];
		entries.splice(to, 0, moved);
		render(false);
		setSelected(to);
	}

	document.addEventListener('keydown', function(e) {
		if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON')) return;
		if (!e.altKey) {
			if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(Math.min(selectedIndex + 1, entries.length - 1)); return; }
			if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected(Math.max(selectedIndex - 1, 0)); return; }
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('startBtn').click(); return; }
		}
		if (e.altKey) {
			if (e.key === 'ArrowDown' && selectedIndex >= 0) { e.preventDefault(); moveEntry(selectedIndex, selectedIndex + 1); return; }
			if (e.key === 'ArrowUp'   && selectedIndex >= 0) { e.preventDefault(); moveEntry(selectedIndex, selectedIndex - 1); return; }
		}
		if (e.target.closest('.action-dd')) return;
		if (selectedIndex < 0) return;
		const shortcuts = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
		const action = shortcuts[e.key];
		if (action) { e.preventDefault(); setAction(selectedIndex, action); }
	});

	document.addEventListener('mousedown', function(e) {
		if (!e.target.closest('.action-dd')) {
			document.querySelectorAll('.action-dd.open').forEach(function(d) { d.classList.remove('open'); });
		}
	});

	function setLoading(loading) {
		document.getElementById('startBtn').classList.toggle('loading', loading);
		document.getElementById('startBtn').disabled = loading;
		document.getElementById('abortBtn').disabled = loading;
	}

	function showError(msg) {
		const b = document.getElementById('error-banner');
		b.textContent = msg; b.style.display = 'block';
	}

	document.getElementById('startBtn').addEventListener('click', function() {
		document.getElementById('error-banner').style.display = 'none';
		if (entries.filter(function(e) { return e.action !== 'drop'; }).length === 0) {
			showError('Cannot start rebase: all commits are marked as drop.');
			return;
		}
		setLoading(true);
		vscode.postMessage({
			command: 'startRebase',
			entries: entries.map(function(e) { return { action: e.action, hash: e.hash, subject: e.subject }; })
		});
	});

	document.getElementById('abortBtn').addEventListener('click', function() {
		vscode.postMessage({ command: 'cancel' });
	});

	window.addEventListener('message', function(event) {
		const msg = event.data;
		if (msg.command === 'error') { setLoading(false); showError(msg.message); }
	});

	render(false);
	if (entries.length > 0) setSelected(0);

	var sortNewest = false;
	document.getElementById('sort-btn').addEventListener('click', function() {
		sortNewest = !sortNewest;
		entries.reverse();
		if (selectedIndex >= 0) selectedIndex = entries.length - 1 - selectedIndex;
		document.getElementById('sort-btn').innerHTML = sortNewest
			? '\u2191\u2193&nbsp;Newest first'
			: '\u2191\u2193&nbsp;Oldest first';
		render(true);
		var list = document.getElementById('entry-list');
		var baseRow = list.querySelector('.base-row');
		if (sortNewest) {
			baseRow.classList.add('reversed');
			list.appendChild(baseRow);
		} else {
			baseRow.classList.remove('reversed');
			list.insertBefore(baseRow, list.firstChild);
		}
	});
})();
</script>
</body>
</html>`;
	}
}


import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type EditorTheme, Key, matchesKey, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Option, Question, Result } from "./schema.ts";

// ── TUILike ───────────────────────────────────────────────────────────────────
// Minimal interface satisfied by both the real TUI and a test stub.
export interface TUILike {
	requestRender(): void;
	terminal?: { rows: number; columns: number };
}

// ── QuestionState ─────────────────────────────────────────────────────────────
interface QuestionState {
	/** Visual cursor position — where the highlight is, NOT the answer */
	cursorIndex: number;
	/** Single-select: explicitly chosen option index; null = nothing chosen yet */
	selectedIndex: number | null;
	/** For multiSelect: set of explicitly selected option indices */
	selectedIndices: Set<number>;
	/** Whether the user has confirmed this question */
	confirmed: boolean;
	/** Free-text answer typed by the user; null = free-text not chosen */
	freeTextValue: string | null;
	/** Whether the inline Editor is currently active */
	inEditMode: boolean;
	/** Scroll offset — index of the first visible option in the current viewport */
	scrollOffset: number;
}

type DisplayOption = Option & { isOther?: true };

// ── AskUserQuestionComponent ──────────────────────────────────────────────────
export class AskUserQuestionComponent implements Component {
	private questions: Question[];
	private theme: Theme;
	private tui: TUILike;
	private done: (result: Result | null) => void;

	private states: QuestionState[];
	private activeTab: number = 0;
	private editor: Editor;
	private commentEditor: Editor;
	private comment: string = "";

	// Render cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Guard: prevent done() being called more than once
	private _resolved: boolean = false;

	constructor(questions: Question[], tui: TUILike, theme: Theme, done: (result: Result | null) => void) {
		this.questions = questions;
		this.tui = tui;
		this.theme = theme;
		this.done = done;

		this.states = questions.map(() => ({
			cursorIndex: 0,
			selectedIndex: null,
			selectedIndices: new Set<number>(),
			confirmed: false,
			freeTextValue: null,
			inEditMode: false,
			scrollOffset: 0,
		}));

		const makeEditorTheme = (): EditorTheme => ({
			borderColor: (s) => theme.fg("muted", s),
			selectList: {
				selectedPrefix: (s) => theme.fg("accent", s),
				selectedText: (s) => theme.fg("accent", s),
				description: (s) => theme.fg("muted", s),
				scrollInfo: (s) => theme.fg("dim", s),
				noMatch: (s) => theme.fg("warning", s),
			},
		});

		this.editor = new Editor(tui as TUI, makeEditorTheme());
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};

		this.commentEditor = new Editor(tui as TUI, makeEditorTheme());
		this.commentEditor.disableSubmit = true;
		this.commentEditor.onChange = () => {
			this.comment = this.commentEditor.getText();
			this.invalidate();
			this.tui.requestRender();
		};

		this.invalidate();
	}

	// ── Derived helpers ─────────────────────────────────────────────────────────

	private allOptions(q: Question): DisplayOption[] {
		return [...q.options, { label: "Type your own answer...", isOther: true as const }];
	}

	private allConfirmed(): boolean {
		return this.states.every((s) => s.confirmed);
	}

	private get totalTabs(): number {
		return this.questions.length + 1; // questions + Submit
	}

	// ── Public interface ────────────────────────────────────────────────────────

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	// ── render() ────────────────────────────────────────────────────────────────

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) {
			return this.cachedLines;
		}

		if (this.questions.length === 0) {
			return [];
		}

		const t = this.theme;
		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));

		// ── Top separator ──
		add(t.fg("accent", "─".repeat(width)));

		// ── Tab bar ──
		this.renderTabBar(width, add);
		lines.push("");

		// ── Question body or Submit tab ──
		const q = this.questions[this.activeTab];
		if (!q) {
			// activeTab is on Submit tab (or out of bounds) — render Submit view
			this.renderSubmitTab(width, add);
		} else {
			const state = this.states[this.activeTab];
			this.renderQuestionBody(q, state, width, add);
		}

		// ── Bottom separator ──
		add(t.fg("accent", "─".repeat(width)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderTabBar(_width: number, add: (s: string) => void): void {
		const t = this.theme;
		const parts: string[] = [" "];

		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const s = this.states[i];
			const isActive = i === this.activeTab;
			// Truncate header to 12 chars
			const header = truncateToWidth(q.header, 12);
			const label = ` ${header} `;

			let styled: string;
			if (isActive) {
				styled = t.bg("selectedBg", t.fg("text", label));
			} else if (s.confirmed) {
				styled = t.fg("success", ` ■${header} `);
			} else {
				styled = t.fg("muted", `  ${header} `);
			}
			parts.push(styled);
		}

		// Submit tab
		const isSubmitActive = this.activeTab === this.questions.length;
		const submitLabel = " ✓ Submit ";
		let submitStyled: string;
		if (isSubmitActive) {
			submitStyled = t.bg("selectedBg", t.fg("text", submitLabel));
		} else if (this.allConfirmed()) {
			submitStyled = t.fg("success", submitLabel);
		} else {
			submitStyled = t.fg("dim", submitLabel);
		}
		parts.push(submitStyled);

		add(parts.join(""));
	}

	private renderQuestionBody(q: Question, state: QuestionState, width: number, add: (s: string) => void): void {
		const t = this.theme;
		const allOpts = this.allOptions(q);

		// Question text (word-wrapped)
		{
			const wrapped = wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - 2);
			for (const line of wrapped) {
				add(line);
			}
		}
		add("");

		// Calculate available height for options list.
		// Render all option lines into a buffer; slice by scrollOffset later.
		const renderedOptions: string[] = [];
		// Map option index → first line index in renderedOptions
		const optionLineIndex: number[] = [];
		for (let i = 0; i < allOpts.length; i++) {
			optionLineIndex[i] = renderedOptions.length;
			const opt = allOpts[i];
			const isSelected = i === state.cursorIndex;
			const isOther = opt.isOther === true;
			const prefix = isSelected ? t.fg("accent", ">") : " ";

			if (q.multiSelect && !isOther) {
				const checked = state.selectedIndices.has(i);
				const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
				const labelColor = isSelected ? "accent" : "text";
				renderedOptions.push(`${prefix} ${box} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}`);
			} else if (isOther) {
				const hasFreeText = state.freeTextValue !== null && !state.inEditMode;
				const suffix = state.inEditMode ? t.fg("accent", " ✎") : "";
				const labelColor = isSelected ? "accent" : "muted";
				if (q.multiSelect) {
					const box = hasFreeText ? t.fg("success", "[✓]") : t.fg("dim", "[ ]");
					renderedOptions.push(`${prefix} ${box} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}${suffix}`);
				} else {
					const check = hasFreeText ? t.fg("success", "✓") : " ";
					renderedOptions.push(`${prefix} ${check} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}${suffix}`);
				}
				if (hasFreeText) {
					const indent = q.multiSelect ? "       " : "     ";
					const preview = truncateToWidth(state.freeTextValue ?? "", width - indent.length);
					renderedOptions.push(`${indent}${t.fg("dim", `"${preview}"`)}`);
				}
			} else {
				const isConfirmedChoice = state.selectedIndex === i;
				const check = isConfirmedChoice ? t.fg("success", "✓") : " ";
				const labelColor = isSelected ? "accent" : "text";
				renderedOptions.push(`${prefix} ${check} ${t.fg(labelColor, `${i + 1}. ${opt.label}`)}`);
			}

			if (!isOther && opt.description) {
				const indent = q.multiSelect ? "       " : "     ";
				const wrapped = wrapTextWithAnsi(t.fg("muted", opt.description), width - indent.length);
				for (const line of wrapped) {
					renderedOptions.push(`${indent}${line}`);
				}
			}
		}

		// Compute viewport: available rows = terminal rows - (header/tabs lines + footer lines + editor lines)
		// Use a generous estimate: terminal height or unlimited fallback.
		const terminalRows = this.tui.terminal?.rows;
		if (terminalRows) {
			// Find how many lines we've already emitted (question text + blank line + top/bottom separators + tab bar)
			// Recalculate based on the actual question text height.
			// Simpler: count lines we've already added vs what we'll add below.
			// We don't have access to the total line count easily. Let's compute from scratch.

			// Re-render the header portion to count its height.
			const headerQPart: string[] = [];
			{
				const wrapped = wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - 2);
				headerQPart.push(...wrapped);
			}
			// header lines consumed: question text + blank line after it
			const headerLines = headerQPart.length + 1; // +1 for the blank add("")

			// Footer: 2 lines (blank + footer) when not in edit mode; 2 + editor lines + extra blank when in edit mode
			let footerLines = 2; // blank line + footer help
			if (state.inEditMode) {
				footerLines += 3; // blank + "Your answer:" + editor.render lines (at least 1)
			}

			// Total consumed outside options: top separator (1) + tab bar (1) + header + footer + bottom sep (1)
			const overheadLines = 1 + 1 + headerLines + footerLines + 1;
			const viewportHeight = Math.max(1, terminalRows - overheadLines);

			// Keep cursor in viewport
			const cursorRenderedIdx = optionLineIndex[state.cursorIndex] ?? 0;
			if (cursorRenderedIdx < state.scrollOffset) {
				state.scrollOffset = cursorRenderedIdx;
			} else if (cursorRenderedIdx >= state.scrollOffset + viewportHeight) {
				state.scrollOffset = cursorRenderedIdx - viewportHeight + 1;
			}
			state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, Math.max(0, renderedOptions.length - viewportHeight)));

			// Slice visible options
			if (state.scrollOffset > 0) {
				add(t.fg("dim", ` ↑ ${state.scrollOffset} more above`));
			}
			const endIdx = Math.min(renderedOptions.length, state.scrollOffset + viewportHeight);
			for (let i = state.scrollOffset; i < endIdx; i++) {
				add(renderedOptions[i]);
			}
			if (endIdx < renderedOptions.length) {
				add(t.fg("dim", ` ↓ ${renderedOptions.length - endIdx} more below`));
			}
		} else {
			// No terminal info — render all options
			for (const line of renderedOptions) {
				add(line);
			}
		}

		// Inline editor (when in edit mode)
		if (state.inEditMode) {
			add("");
			add(t.fg("muted", " Your answer:"));
			const editorLines = this.editor.render(width - 4);
			for (const line of editorLines) {
				add(` ${line}`);
			}
		}

		add("");

		// Footer help — context-sensitive based on cursor position
		if (state.inEditMode) {
			add(t.fg("dim", " Enter submit · Esc back"));
		} else {
			const onOther = state.cursorIndex === allOpts.length - 1;
			const tabHint = " · ←→ switch tabs";
			let actionHint: string;
			if (onOther) {
				actionHint = "Space/Tab open editor";
			} else if (q.multiSelect) {
				actionHint = "Space toggle · Enter confirm";
			} else {
				actionHint = "Enter select";
			}
			const scrollHint = allOpts.length > 4 ? " · PgUp/PgDn scroll" : "";
			add(t.fg("dim", ` ↑↓ navigate · ${actionHint}${tabHint}${scrollHint} · Esc cancel`));
		}
	}

	private renderSubmitTab(width: number, add: (s: string) => void): void {
		const t = this.theme;
		const allDone = this.allConfirmed();

		const title = allDone ? t.fg("success", t.bold(" Ready to submit")) : t.fg("warning", t.bold(" Unanswered questions"));
		add(title);
		add("");

		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const state = this.states[i];
			const answer = this.getAnswerText(q, state);
			if (answer !== null) {
				add(t.fg("muted", ` ${truncateToWidth(q.header, 12)}: `) + t.fg("text", answer));
			} else {
				add(t.fg("dim", ` ${truncateToWidth(q.header, 12)}: `) + t.fg("warning", "—"));
			}
		}

		add("");

		// Comment editor — always visible on Submit tab
		add(t.fg("muted", " Leave a comment:"));
		const commentLines = this.commentEditor.render(width - 4);
		for (const line of commentLines) {
			add(` ${line}`);
		}
		add("");

		if (allDone) {
			add(t.fg("success", " Press Enter to submit"));
		} else {
			const missing = this.questions
				.filter((_, i) => !this.states[i].confirmed)
				.map((q) => truncateToWidth(q.header, 12))
				.join(", ");
			add(t.fg("warning", ` Still needed: ${missing}`));
		}
		add("");
		add(t.fg("dim", " ←→ switch tabs · Esc cancel"));
	}

	private getAnswerText(q: Question, state: QuestionState): string | null {
		if (!state.confirmed) return null;
		if (q.multiSelect) {
			const labels = [...state.selectedIndices].sort((a, b) => a - b).map((idx) => q.options[idx].label);
			if (state.freeTextValue !== null) labels.push(state.freeTextValue);
			return labels.join(", ");
		}
		if (state.freeTextValue !== null) return state.freeTextValue;
		if (state.selectedIndex !== null) return q.options[state.selectedIndex].label;
		return null;
	}

	// ── Private navigation helpers ───────────────────────────────────────────────

	private moveCursor(delta: -1 | 1): void {
		const q = this.questions[this.activeTab];
		const state = this.states[this.activeTab];
		const max = this.allOptions(q).length - 1;
		state.cursorIndex = Math.max(0, Math.min(max, state.cursorIndex + delta));
		// Keep cursor in viewport — scrollOffset will be clamped in renderQuestionBody
		const terminalRows = this.tui.terminal?.rows;
		if (terminalRows) {
			// Simple heuristic: if cursor moves above scrollOffset, bring scrollOffset up;
			// if below visible area, push it down. The precise clip happens in renderQuestionBody.
			if (state.cursorIndex < state.scrollOffset) {
				state.scrollOffset = state.cursorIndex;
			} else {
				// Estimate viewport height (will be precise in render)
				const approxOverhead = 6; // top sep + tab bar + question + blank + footer + bottom sep
				const approxViewport = Math.max(1, terminalRows - approxOverhead);
				if (state.cursorIndex >= state.scrollOffset + approxViewport) {
					state.scrollOffset = state.cursorIndex - approxViewport + 1;
				}
			}
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private pageCursor(dir: -1 | 1): void {
		const q = this.questions[this.activeTab];
		const state = this.states[this.activeTab];
		const max = this.allOptions(q).length - 1;
		const terminalRows = this.tui.terminal?.rows ?? 24;
		const pageSize = Math.max(1, terminalRows - 8); // approximate visible options
		state.cursorIndex = Math.max(0, Math.min(max, state.cursorIndex + dir * pageSize));
		state.scrollOffset = state.cursorIndex;
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleSelected(index: number): void {
		const state = this.states[this.activeTab];
		if (state.selectedIndices.has(index)) {
			state.selectedIndices.delete(index);
		} else {
			state.selectedIndices.add(index);
		}
		// If all answers removed, un-confirm so Submit tab blocks correctly
		if (state.selectedIndices.size === 0 && state.freeTextValue === null) {
			state.confirmed = false;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private enterEditMode(): void {
		const state = this.states[this.activeTab];
		state.inEditMode = true;
		// Restore previous free-text value if any
		if (state.freeTextValue !== null) {
			this.editor.setText(state.freeTextValue);
		} else {
			this.editor.setText("");
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private exitEditMode(save: boolean): void {
		const state = this.states[this.activeTab];
		if (save) {
			state.freeTextValue = this.editor.getText().trim();
			// Free-text replaces any prior regular-option selection — clear the ✓ indicator
			state.selectedIndex = null;
		} else {
			// Discard typed text — clear freeTextValue only if it was never confirmed
			// (if confirmed, freeTextValue holds the answer — don't touch it)
			if (!state.confirmed) {
				state.freeTextValue = null;
			}
		}
		this.editor.setText("");
		state.inEditMode = false;
		this.invalidate();
	}

	private autoConfirmIfAnswered(): void {
		const q = this.questions[this.activeTab];
		const state = this.states[this.activeTab];
		if (!q || !state || state.confirmed) return;
		if (q.multiSelect) {
			if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
				state.confirmed = true;
			}
		} else {
			if (state.freeTextValue !== null || state.selectedIndex !== null) {
				state.confirmed = true;
			}
		}
	}

	private confirmAndAdvance(): void {
		const state = this.states[this.activeTab];
		state.confirmed = true;
		this.advance();
	}

	private advance(): void {
		if (this.activeTab < this.questions.length - 1) {
			this.activeTab++;
		} else {
			this.activeTab = this.questions.length; // Submit tab
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private submit(): void {
		this._resolved = true;
		this.done(this.buildResult());
	}

	private cancel(): void {
		this._resolved = true;
		this.done(null);
	}

	private buildResult(): Result {
		const answers: Record<string, string> = {};
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const s = this.states[i];
			if (!s.confirmed) continue;
			if (q.multiSelect) {
				const labels = [...s.selectedIndices].sort((a, b) => a - b).map((idx) => q.options[idx].label);
				if (s.freeTextValue !== null) labels.push(s.freeTextValue);
				answers[q.question] = labels.join(", ");
			} else if (s.freeTextValue !== null) {
				answers[q.question] = s.freeTextValue;
			} else if (s.selectedIndex !== null) {
				answers[q.question] = q.options[s.selectedIndex].label;
			}
		}
		const comment = this.comment.trim();
		return {
			questions: this.questions,
			answers,
			cancelled: false,
			...(comment ? { comment } : {}),
		};
	}

	// ── External editor ──────────────────────────────────────────────────────────

	private openInExternalEditor(text: string): string {
		const editorCmd = process.env.VISUAL || process.env.EDITOR || "vi";
		const tmpPath = join(tmpdir(), `pi-askuser-${Date.now()}.txt`);
		writeFileSync(tmpPath, text, "utf-8");
		try {
			execSync(`${editorCmd} ${tmpPath}`, { stdio: "inherit" });
			if (existsSync(tmpPath)) {
				return readFileSync(tmpPath, "utf-8");
			}
		} finally {
			try {
				unlinkSync(tmpPath);
			} catch {
				/* best effort */
			}
		}
		return text;
	}

	// ── handleInput() ────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		// Guard: once done has been called, ignore all further input
		if (this._resolved) return;

		// ── Submit tab ─────────────────────────────────────────────────────────────
		// Check Submit tab FIRST — states[activeTab] is undefined when on Submit tab
		if (this.activeTab === this.questions.length) {
			if (matchesKey(data, Key.enter)) {
				if (this.allConfirmed()) this.submit();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.cancel();
				return;
			}
			if (matchesKey(data, Key.right)) {
				this.activeTab = 0;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.left)) {
				this.activeTab = this.questions.length - 1;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.ctrl("g"))) {
				const newText = this.openInExternalEditor(this.commentEditor.getText());
				this.commentEditor.setText(newText);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			// Route all other input to the comment editor
			this.commentEditor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const state = this.states[this.activeTab];
		const q = this.questions[this.activeTab];

		// ── Edit mode: route to inline editor ──────────────────────────────────────
		if (state.inEditMode) {
			if (matchesKey(data, Key.ctrl("g"))) {
				const newText = this.openInExternalEditor(this.editor.getText());
				this.editor.setText(newText);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				this.exitEditMode(false);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const text = this.editor.getText().trim();
				if (text) {
					this.exitEditMode(true);
					// Multi-select: just return to options so user can still toggle checkboxes
					// Single-select: auto-confirm since free-text is the only answer
					if (!q.multiSelect) {
						this.confirmAndAdvance();
					} else {
						this.tui.requestRender();
					}
				} else {
					// Empty text — clear any previously saved free-text answer
					state.freeTextValue = null;
					// If nothing else is selected, un-confirm so Submit tab blocks correctly.
					// Multi-select: un-confirm only if no boxes are checked.
					// Single-select: un-confirm only if no option is selected.
					if (q.multiSelect) {
						if (state.selectedIndices.size === 0) {
							state.confirmed = false;
						}
					} else if (state.selectedIndex === null) {
						state.confirmed = false;
					}
					this.exitEditMode(false);
					this.tui.requestRender();
				}
				return;
			}
			this.editor.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// ── Question tab ───────────────────────────────────────────────────────────
		if (matchesKey(data, Key.escape)) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.right)) {
			this.autoConfirmIfAnswered();
			this.activeTab = (this.activeTab + 1) % this.totalTabs;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.autoConfirmIfAnswered();
			this.activeTab = (this.activeTab - 1 + this.totalTabs) % this.totalTabs;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up)) {
			this.moveCursor(-1);
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.moveCursor(1);
			return;
		}

		if (matchesKey(data, Key.pageUp)) {
			this.pageCursor(-1);
			return;
		}

		if (matchesKey(data, Key.pageDown)) {
			this.pageCursor(1);
			return;
		}

		const opts = this.allOptions(q);
		const onOther = state.cursorIndex === opts.length - 1;

		// "Type your own answer..." — Space or Tab opens the editor
		// Enter confirms if there's already a saved free-text answer
		if (onOther) {
			if (matchesKey(data, Key.space) || matchesKey(data, Key.tab)) {
				this.enterEditMode();
				return;
			}
			if (matchesKey(data, Key.enter) && state.freeTextValue !== null) {
				this.confirmAndAdvance();
				return;
			}
		}

		if (q.multiSelect) {
			if (matchesKey(data, Key.space) && !onOther) {
				// Space = toggle selection
				this.toggleSelected(state.cursorIndex);
				return;
			}
			if (matchesKey(data, Key.enter) && !onOther) {
				if (state.selectedIndices.size > 0 || state.freeTextValue !== null) {
					this.confirmAndAdvance();
				}
				return;
			}
		} else {
			if (matchesKey(data, Key.enter) && !onOther) {
				// Record explicit selection and clear any free-text
				state.selectedIndex = state.cursorIndex;
				state.freeTextValue = null;
				this.confirmAndAdvance();
				return;
			}
		}
	}
}

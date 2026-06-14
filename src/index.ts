import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, TruncatedText } from "@earendil-works/pi-tui";
import { autoFix } from "./auto-fix.ts";
import { AskUserQuestionComponent } from "./component.ts";
import { InputSchema, type QuestionInput, type Result } from "./schema.ts";

// ── Turn-tracking state ──

let lastToolNames: string[] = [];
let justHadUserTurn = false;

const NON_TRIGGERING_TOOLS = new Set(["read", "write", "edit", "grep", "glob", "list_files", "bash", "ls", "find", "cat", "head", "tail", "ask_user_question"]);

const CLARIFICATION_NUDGE = `

Before responding, pause and ask: is anything ambiguous, underspecified, or reliant on an assumption the user hasn't confirmed? If yes, call ask_user_question with focused questions instead of guessing.`;

export default function (pi: ExtensionAPI) {
	// Track tool calls so we know what happened before each agent turn
	pi.on("tool_call", async (event) => {
		lastToolNames.push(event.name);
	});

	pi.on("turn_start", async () => {
		lastToolNames = [];
		justHadUserTurn = true;
	});

	// Inject clarification nudge after user messages and non-trivial tool calls
	pi.on("before_agent_start", async (event, _ctx) => {
		// After a user turn: always nudge
		if (justHadUserTurn) {
			justHadUserTurn = false;
			return {
				systemPrompt: (event.systemPrompt ?? "") + CLARIFICATION_NUDGE,
			};
		}

		// After tool calls: nudge only if any tool was NOT a safe read/write/edit
		const hasNonTrivial = lastToolNames.some((n) => !NON_TRIGGERING_TOOLS.has(n));
		if (hasNonTrivial) {
			return {
				systemPrompt: (event.systemPrompt ?? "") + CLARIFICATION_NUDGE,
			};
		}
	});
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: `Ask the user 1–32 clarifying questions before proceeding.
LLMs can create as many queries as needed — don't hesitate to ask multiple focused questions.
After the user reviews their answers on the Submit tab, they can optionally leave a free-text comment before submitting.
Use this tool to:
1. Clarify ambiguous instructions
2. Get the user's preference between valid approaches
3. Make decisions on implementation choices
4. Offer choices about what direction to take
Each question must have 2–4 options. Users can always select "Other" to type a free-text answer, so do not include an "Other" option yourself.
Option labels should be concise (1–5 words).
Set multiSelect: true when more than one option can validly apply at the same time.
The header field is a short label (max 12 characters) used in the tab bar when showing multiple questions. Defaults to first 12 chars of question text if omitted.
If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.
Always use this tool instead of asking questions in plain text — it provides a structured, interactive UI.`,

		parameters: InputSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { fixed: questions, warnings } = autoFix(params.questions as QuestionInput[]);

			if (questions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: ["Error: No valid questions after auto-fix.", ...warnings].join("\n"),
						},
					],
					details: {
						questions: [],
						answers: {},
						cancelled: true,
					} satisfies Result,
				};
			}

			if (!ctx.hasUI) {
				// Non-interactive session — deregister so the LLM won't try again
				pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
				return {
					content: [
						{
							type: "text",
							text: "Error: ask_user_question requires an interactive session. The tool has been disabled for this session.",
						},
					],
					details: {
						questions: [],
						answers: {},
						cancelled: true,
					} satisfies Result,
				};
			}

			const result = await ctx.ui.custom<Result | null>((tui, theme, _kb, done) => new AskUserQuestionComponent(questions, tui, theme, done));

			if (result === null || result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: {
						questions,
						answers: {},
						cancelled: true,
					} satisfies Result,
				};
			}

			const summaryLines = result.questions.map((q) => `"${q.question}" = "${result.answers[q.question] ?? "(no answer)"}"`);

			const commentLine = result.comment ? `\nUser comment: "${result.comment}"` : "";

			const warningText = warnings.length > 0 ? `\n⚠ Auto-fixed ${warnings.length} issue(s):\n${warnings.map((w) => `  - ${w}`).join("\n")}\n` : "";

			return {
				content: [
					{
						type: "text",
						text: warningText + summaryLines.join("\n") + commentLine,
					},
				],
				details: result satisfies Result,
			};
		},

		renderCall(args, theme) {
			const questions = (args.questions ?? []) as QuestionInput[];
			const topics = questions.map((q) => q.header ?? q.question.slice(0, 12)).join(", ");
			return new TruncatedText(theme.fg("toolTitle", theme.bold("ask user ")) + theme.fg("muted", topics), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as Result | undefined;

			if (!details) {
				const t = result.content[0];
				return new TruncatedText(t?.type === "text" ? t.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new TruncatedText(theme.fg("warning", "Cancelled"), 0, 0);
			}

			// One TruncatedText per question — each line item truncated independently
			const box = new Box(0, 0);
			for (const q of details.questions) {
				const answer = details.answers[q.question] ?? "(no answer)";
				box.addChild(new TruncatedText(theme.fg("success", "✓ ") + theme.fg("accent", `${q.header}: `) + theme.fg("text", answer), 0, 0));
			}
			if (details.comment) {
				box.addChild(new TruncatedText(theme.fg("muted", "💬 ") + theme.fg("text", details.comment), 0, 0));
			}
			return box;
		},
	});
}

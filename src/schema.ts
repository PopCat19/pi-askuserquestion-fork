import { type Static, Type } from "typebox";

// ── Shared option type ────────────────────────────────────────────────────────

export const OptionSchema = Type.Object({
	label: Type.String({
		description: "Display label shown to the user and returned as the answer value",
	}),
	description: Type.Optional(
		Type.String({
			description: "Optional clarifying text shown below the label",
		}),
	),
});

export type Option = Static<typeof OptionSchema>;

// ── Loose input (what the LLM sends) ──────────────────────────────────────────
//
// Constraints are enforced by autoFix(), not the schema.
// The LLM can send imperfect JSON — missing fields get defaults,
// excess items get truncated, duplicates get deduplicated.
// Warnings in the response teach the LLM to converge on correct usage.

export const QuestionInputSchema = Type.Object({
	question: Type.String({
		description: "Full question text displayed to the user",
	}),
	header: Type.Optional(
		Type.String({
			description:
				"Short label used in the tab bar when multiple questions are shown. Max 12 characters. Defaults to first 12 chars of question text if omitted.",
		}),
	),
	options: Type.Array(OptionSchema, {
		description: "Between 2 and 4 choices for the user to select from",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "When true the user may select multiple options. Answers are joined with ', '. Defaults to false.",
		}),
	),
});

export const InputSchema = Type.Object({
	questions: Type.Array(QuestionInputSchema, {
		description: "1 to 32 questions to ask the user",
	}),
});

export type QuestionInput = Static<typeof QuestionInputSchema>;

// ── Strict question (after autoFix, what the component receives) ──────────────

export const QuestionSchema = Type.Object({
	question: Type.String(),
	header: Type.String(),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
	multiSelect: Type.Boolean(),
});

export type Question = Static<typeof QuestionSchema>;

// ── Output (details returned to the LLM and used in renderResult) ─────────────
//
// Answer encoding rules:
//   Single-select:       { [question]: "Label" }
//   Multi-select joined: { [question]: "Label A, Label C" }  (sorted by option index)
//   Free-text:           { [question]: "user typed text" }
//   Cancelled:           key absent from answers; cancelled: true

export const ResultSchema = Type.Object({
	// Pass-through so renderResult has headers + option descriptions without
	// re-parsing the LLM input.
	questions: Type.Array(QuestionSchema),

	// Maps question text → selected label(s).
	// Multi-select: labels joined with ", " e.g. "Option A, Option C"
	// Free-text: the user's typed string verbatim
	// Cancelled: key absent (see cancelled flag)
	answers: Type.Record(Type.String(), Type.String()),

	// True when the user pressed Esc before submitting
	cancelled: Type.Boolean(),

	// Optional free-text comment left by the user during review on the Submit tab
	comment: Type.Optional(
		Type.String({
			description: "Optional free-text comment left by the user during review on the Submit tab",
		}),
	),
});

export type Result = Static<typeof ResultSchema>;

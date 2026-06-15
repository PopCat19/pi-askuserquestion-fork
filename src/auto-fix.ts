import type { Question, QuestionInput } from "./schema.ts";

const MIN_OPTIONS = 2;

export interface AutoFixResult {
	fixed: Question[];
	warnings: string[];
}

export function autoFix(questions: QuestionInput[]): AutoFixResult {
	const warnings: string[] = [];

	// 1. Filter out empty question text
	const nonEmpty = questions.filter((q, i) => {
		if (!q.question || q.question.trim() === "") {
			warnings.push(`Question #${i + 1} had empty text — skipped`);
			return false;
		}
		return true;
	});

	// 2. Deduplicate question texts (keep first occurrence)
	const seenQuestions = new Set<string>();
	const deduped: QuestionInput[] = [];
	for (const q of nonEmpty) {
		if (seenQuestions.has(q.question)) {
			warnings.push(`Duplicate question "${q.question.slice(0, 40)}" — kept first occurrence`);
			continue;
		}
		seenQuestions.add(q.question);
		deduped.push(q);
	}

	// 3. Fix each question individually
	const result: Question[] = deduped.map((q, i) => fixQuestion(q, i + 1, warnings));

	return { fixed: result, warnings };
}

function fixQuestion(q: QuestionInput, qNum: number, warnings: string[]): Question {
	// Default header from question text
	let header = q.header?.trim();
	if (!header) {
		header = q.question.slice(0, 12);
		warnings.push(`Q${qNum}: missing header — defaulted to "${header}"`);
	}

	// Default multiSelect to false
	const multiSelect = q.multiSelect ?? false;
	if (q.multiSelect === undefined) {
		warnings.push(`Q${qNum}: missing multiSelect — defaulted to false`);
	}

	// Fix options
	let options = [...(q.options ?? [])];

	// Filter empty labels
	const beforeFilter = options.length;
	options = options.filter((o) => o.label && o.label.trim() !== "");
	if (beforeFilter > options.length) {
		warnings.push(`Q${qNum}: ${beforeFilter - options.length} option(s) with empty label — removed`);
	}

	// Deduplicate option labels (keep first occurrence)
	const seenLabels = new Set<string>();
	const dedupedOptions: typeof options = [];
	for (const o of options) {
		if (seenLabels.has(o.label)) {
			warnings.push(`Q${qNum}: duplicate option "${o.label}" — kept first occurrence`);
			continue;
		}
		seenLabels.add(o.label);
		dedupedOptions.push(o);
	}
	options = dedupedOptions;

	// Pad to MIN_OPTIONS with generic defaults
	if (options.length < MIN_OPTIONS) {
		const defaults = ["Yes", "No"];
		const needed = MIN_OPTIONS - options.length;
		for (let j = 0; j < needed && j < defaults.length; j++) {
			options.push({ label: defaults[j] });
		}
		warnings.push(`Q${qNum}: only ${options.length - needed} option(s) — added defaults to reach ${MIN_OPTIONS}`);
	}

	return {
		question: q.question,
		header,
		options,
		multiSelect,
	};
}

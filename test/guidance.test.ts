import { expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { parseSplitArgs } from "../index.ts";
import { splitCompletions, splitHint } from "../guidance.ts";

test("accepting a handoff example after a custom quoted title preserves the title", async () => {
	const native = new CombinedAutocompleteProvider([{ name: "split", getArgumentCompletions: splitCompletions }]);
	const line = '/split “Sam’s tests” ';
	const suggestions = await native.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	const example = suggestions?.items.find(item => item.label === "Add a handoff focus");
	if (!suggestions || !example) throw new Error("Missing focused handoff example");
	const applied = native.applyCompletion([line], 0, line.length, example, suggestions.prefix);
	expect(parseSplitArgs(applied.lines[0].slice(7))).toEqual({ name: "Sam’s tests", focus: "Investigate the failing tests" });
});

test("a finished command or free-form focus needs no completion to submit", () => {
	for (const args of ['"My name"', "Why didn’t the retry work?", '"My name" Why retry?', "--help"]) {
		expect(splitCompletions(args)).toBeNull();
	}
});

test("only single-line split commands get inline guidance", () => {
	for (const text of ["", "/splitter", "Explain /split", "/other", "/split first\nsecond"]) expect(splitHint(text)).toBeUndefined();
	expect(splitHint('/split “Test fixes')).toContain('”');
	expect(splitHint('/split “Test fixes”')).toContain('optional handoff focus');
});

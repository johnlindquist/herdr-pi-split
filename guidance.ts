import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Container, CURSOR_MARKER, Input, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const SPLIT_USAGE = '/split ["name"] [handoff focus]';
export const NAME_QUOTES: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
const nameExample = '"Test fixes"';
const focusExample = "Investigate the failing tests";
const examples: AutocompleteItem[] = [
	{ value: "", label: "Pick a message", description: "Copy history through that message" },
	{ value: nameExample, label: nameExample, description: "Give the new session a name" },
	{ value: focusExample, label: focusExample, description: "Start with a focused summary" },
	{ value: `${nameExample} ${focusExample}`, label: "Name + focus", description: "Name the session and request a summary" },
	{ value: "--help", label: "--help", description: "Show examples without opening a pane" },
];

export function splitHelp(shortcut: string): string {
	return [
		"Split a conversation in Herdr",
		"Run /split, choose a message, then press Enter. A new Pi pane opens on the right with the conversation up to that message. The original session stays unchanged.",
		"",
		...examples.map(item => `/split${item.value ? ` ${item.value}` : ""}  —  ${item.description}`),
		"",
		"The picker starts at the newest user message or reply on this branch. Use ↑/↓ or type to search. Esc cancels. Shift+Enter asks what the new session should focus on; leave it blank for a general summary.",
		"Quote only the name. Unquoted text asks your current model for a handoff: a summary to start from, with the history still in the tree. If the summary fails, the fork opens with its history instead.",
		"No quoted name? Pi names a focused handoff from its focus; otherwise it keeps the branch name or uses its latest request.",
		`Shortcut: ${shortcut}. Type a space after /split for examples; use ↑/↓ and Tab to insert one and edit it.`,
	].join("\n");
}

/** Each value replaces the entire argument prefix. Never substitute an example for free-form text. */
export function splitCompletions(prefix: string): AutocompleteItem[] | null {
	if (!prefix.trim()) return examples;
	if (prefix === "--help" || prefix === "-h") return null;
	if (prefix.startsWith("-") && "--help".startsWith(prefix)) return [examples[4]];
	const quote = NAME_QUOTES[prefix[0]];
	if (quote) {
		const end = prefix.indexOf(quote, 1);
		if (end < 0 && prefix.slice(1).trim()) return [{ value: prefix + quote, label: "Close the name", description: "Keep the name you typed" }];
		if (end >= 0 && end === prefix.length - 1) return null; // Enter runs the named split.
		if (end > 1 && !prefix.slice(end + 1).trim()) return [
			{ value: prefix, label: "Use this name", description: "Keep the conversation through the chosen message" },
			{ value: `${prefix.trimEnd()} ${focusExample}`, label: "Add a handoff focus", description: focusExample },
		];
	}
	if (examples.some(item => item.value === prefix)) return null;
	const matches = examples.filter(item => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
	return matches.length ? [{ value: prefix, label: "Keep what I typed", description: "Use my own wording" }, ...matches] : null;
}

export function splitHint(text: string): string | undefined {
	if (!/^\/split(?: |$)/.test(text) || /[\r\n]/.test(text)) return undefined;
	const args = text.slice(6).trimStart();
	if (!args) return text === "/split" ? '["name"] [handoff focus] · Space: examples · Enter: pick a message' : '["name"] [handoff focus] · ↑/↓ + Tab: insert example';
	if (args.trimEnd() === "--help" || args.trimEnd() === "-h") return "Show the guide without splitting";
	const quote = NAME_QUOTES[args[0]];
	if (quote) {
		const end = args.indexOf(quote, 1);
		if (end < 0) return `Close the name with ${quote}`;
		if (!args.slice(end + 1).trim()) return "[optional handoff focus]";
	}
	return "Pick a message to summarize";
}

/** The stock extension input ignores its placeholder on Pi 1.5; the TUI Input renders it. */
export function askHandoffFocus(ctx: ExtensionContext): Promise<string | undefined> {
	const title = "What should the new session focus on?";
	const options = { overlay: false, blocked: { kind: "question" as const, message: title } };
	return ctx.ui.custom<string | undefined>((_tui, theme, keys, done) => {
		const input = new Input({ placeholder: `e.g. ${focusExample}`, placeholderStyle: text => theme.fg("dim", text) });
		input.onSubmit = done;
		input.onEscape = () => done(undefined);
		const dialog = new class extends Container {
			get focused() { return input.focused; }
			set focused(value: boolean) { input.focused = value; }
			handleInput(data: string) {
				if (keys.matches(data, "tui.select.confirm")) done(input.getValue());
				else input.handleInput(data);
			}
		};
		dialog.addChild(new Text(theme.fg("accent", title), 0, 0));
		dialog.addChild(input);
		dialog.addChild(new Text(theme.fg("dim", "Enter: summarize · Leave blank for a general summary · Esc: cancel"), 0, 0));
		return dialog;
	}, options);
}

export function installSplitGuidance(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	// Native argument completions handle typing; explicit Tab otherwise requests file paths.
	ctx.ui.addAutocompleteProvider(current => ({
		triggerCharacters: current.triggerCharacters,
		getSuggestions(lines, line, col, options) {
			const before = (lines[line] ?? "").slice(0, col);
			if (options.force && line === 0 && lines.length === 1 && before.startsWith("/split ") && before === lines[0]) {
				const prefix = before.slice(7);
				const items = splitCompletions(prefix);
				if (items) return Promise.resolve({ prefix, items });
			}
			return current.getSuggestions(lines, line, col, options);
		},
		shouldTriggerFileCompletion: (lines, line, col) => (line === 0 && lines.length === 1 && lines[0].slice(0, col).startsWith("/split ")) || (current.shouldTriggerFileCompletion?.(lines, line, col) ?? true),
		applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
	}));

	// Pi has no per-command inline hint API. Decorate only the focused editor's blank
	// cursor padding, not its input, key handlers, completion rows, or prototype.
	const prior = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui, theme, keys) => {
		const editor = prior?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
		const render = editor.render.bind(editor);
		editor.render = width => {
			const rows = render(width);
			const hint = splitHint(editor.getText());
			if (!hint) return rows;
			const i = rows.findIndex(row => row.includes(CURSOR_MARKER));
			if (i < 0) return rows;
			const row = rows[i];
			const tail = row.slice(row.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length);
			if (stripTerminalSequences(tail).trim()) return rows; // cursor before actual text
			const base = row.trimEnd();
			const room = Math.min(width - visibleWidth(base), row.length - base.length);
			if (room < 4) return rows;
			const suffix = truncateToWidth(hint, room);
			rows[i] = base + ctx.ui.theme.fg("dim", suffix) + " ".repeat(room - visibleWidth(suffix));
			return rows;
		};
		return editor;
	});
}

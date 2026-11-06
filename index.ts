import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExecResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	SessionManager,
	serializeConversation,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { appPaneCommand, openAppPane, resolveSplitParent, type SplitParent } from "./app-pane.ts";
import { askHandoffFocus, installSplitGuidance, NAME_QUOTES, splitCompletions, splitHelp, SPLIT_USAGE } from "./guidance.ts";

// ctrl+shift+alt+f: ctrl+shift+f is pi's built-in tui.altScreen.search and wins nothing by overriding it.
const SPLIT_SHORTCUT = "ctrl+shift+alt+f";
const SPLIT_STATUS_KEY = "herdr-split";
const HERDR_TIMEOUT_MS = 30_000;
/** Budget for the handoff summarization call over the split's history. */
const HANDOFF_TIMEOUT_MS = 10 * 60_000;
/** Budget for the title model; the split keeps its inherited name past it. */
const NAME_TIMEOUT_MS = 60_000;
/** The status screen exits within a tick or two of the "opening" step; past this the launch goes ahead anyway. */
const PROGRESS_EXIT_WAIT_MS = 3_000;
const FOOTER_TICK_MS = 1_000;
const MAX_TITLE_CHARS = 80;
/** Longest request text sent to the title model. */
const MAX_TITLE_INPUT_CHARS = 4_000;

const PROGRESS_PANE_SCRIPT = fileURLToPath(new URL("./progress-pane.mjs", import.meta.url));
const HANDOFF_PROMPT = readFileSync(new URL("./handoff.md", import.meta.url), "utf8");
const TITLE_PROMPT = readFileSync(new URL("./title.md", import.meta.url), "utf8");

type ProgressStep = "handoff" | "naming" | "opening";

interface ProgressState {
	title: string;
	sessionId: string;
	focus: string;
	handoff: boolean;
	naming: boolean;
	step: ProgressStep;
	startedAt: number;
	stepStartedAt: number;
	launcher: string;
}

const FOOTER_STEP_LABELS: Record<ProgressStep, string> = {
	handoff: "writing handoff",
	naming: "naming",
	opening: "opening session",
};

export interface SplitSnapshot {
	sessionFile: string;
	sessionId: string;
}

/** Parsed `/split ["name"] [handoff focus]` arguments. */
export interface SplitRequest {
	name?: string;
	focus?: string;
}

export type SplitTarget = { kind: "current" } | { kind: "entry"; entryId: string };

/** Tree selection: where to split, and whether Shift+Enter asked for a handoff. */
export interface SplitChoice {
	target: SplitTarget;
	handoff: boolean;
}

type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
type Ui = ExtensionContext["ui"];

export interface SplitPaneOptions {
	cwd: string;
	exec: Exec;
	parentPaneId: string;
	sessionFile: string;
	launcher: Launcher;
}

export interface Launcher {
	/** Executable that starts this same agent. */
	command: string;
	/** `KEY=VALUE` pairs the pane's shell needs for that executable to find this agent's state. */
	env: string[];
}

function displayError(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).replaceAll("\t", " ").replace(/\s+/g, " ");
	return message.length > 200 ? `${message.slice(0, 199)}…` : message;
}

function commandError(action: string, result: ExecResult): Error {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
	return new Error(`${action} failed: ${detail}`);
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function shellQuote(words: string[]): string {
	return words.map(word => `'${word.replaceAll("'", `'\\''`)}'`).join(" ");
}

/** Absolute path of `name` on PATH, or undefined. */
function which(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here.
		}
	}
	return undefined;
}

/**
 * The command that starts this same agent again: `pi` from PATH (or `HERDR_SPLIT_LAUNCHER` if set).
 * A custom agent dir is passed through as env so the split uses the same Pi profile.
 */
export function resolveLauncher(env: NodeJS.ProcessEnv = process.env): Launcher {
	const override = env.HERDR_SPLIT_LAUNCHER?.trim();
	if (override) return { command: override, env: [] };
	const agentDir = env.PI_CODING_AGENT_DIR;
	return { command: which("pi") ?? "pi", env: agentDir ? [`PI_CODING_AGENT_DIR=${agentDir}`] : [] };
}

/** The line typed into the split's shell. */
export function resumeCommand(launcher: Launcher, sessionFile: string): string {
	const prefix = launcher.env.length > 0 ? `env ${shellQuote(launcher.env)} ` : "";
	// `command` first: a leading quote or space can hit a prompt keybinding instead of being inserted.
	return `command ${prefix}${shellQuote([launcher.command, "--session", sessionFile])}`;
}

function parsePaneId(stdout: string): string {
	let response: { result?: { pane?: { pane_id?: unknown } } };
	try {
		response = JSON.parse(stdout) as typeof response;
	} catch {
		throw new Error("Herdr returned invalid JSON while splitting the pane");
	}
	const paneId = response.result?.pane?.pane_id;
	if (typeof paneId !== "string" || paneId.length === 0) {
		throw new Error("Herdr split response did not include a pane ID");
	}
	return paneId;
}

async function runHerdr(exec: Exec, cwd: string, action: string, args: string[]): Promise<ExecResult> {
	const result = await exec(process.env.HERDR_BIN || process.env.HERDR_BIN_PATH || "herdr", args, {
		cwd,
		timeout: HERDR_TIMEOUT_MS,
	});
	if (result.code !== 0) throw commandError(action, result);
	return result;
}

/**
 * `/split ["name"] [handoff focus]`. Only a leading quoted name is tokenized;
 * the remainder stays verbatim so apostrophes and quotes in the focus need no escaping.
 */
export function parseSplitArgs(raw: string): SplitRequest {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const closing = NAME_QUOTES[trimmed[0]];
	if (!closing) return { focus: trimmed };
	const end = trimmed.indexOf(closing, 1);
	if (end === -1) throw new Error(`Split name is missing its closing ${closing}`);
	const name = trimmed.slice(1, end).trim();
	if (!name) throw new Error("Split name is empty");
	const focus = trimmed.slice(end + 1).trim();
	return focus ? { name, focus } : { name };
}

/**
 * The built-in /tree selector (search, filters, every branch), mounted for choosing the
 * split point. Enter splits there; Shift+Enter splits there and asks for a handoff.
 * The current leaf means "fork everything as it is now".
 */
export async function pickSplitPoint(ctx: ExtensionContext): Promise<SplitChoice | undefined> {
	const tree = ctx.sessionManager.getTree();
	if (tree.length === 0) throw new Error("This conversation has no entries to split from");
	const leafId = ctx.sessionManager.getLeafId();
	// The leaf can be a tool result, compaction or extension record. Keep it as the
	// active-path marker, but open the cursor on the latest conversation message.
	const latestMessage = ctx.sessionManager.getBranch().findLast(entry => {
		if (entry.type !== "message") return false;
		const msg = entry.message;
		return msg.role === "user" || (msg.role === "assistant" && (
			msg.stopReason === "error" || msg.stopReason === "aborted" ||
			msg.content.some(block => block.type === "text" && block.text.trim().length > 0)
		));
	});
	return ctx.ui.custom<SplitChoice | undefined>((tui, theme, _keybindings, done) => {
		const choose = (entryId: string, handoff: boolean): void =>
			done({ target: entryId === leafId ? { kind: "current" } : { kind: "entry", entryId }, handoff });
		const selector = new TreeSelectorComponent(
			tree,
			leafId,
			Math.max(5, tui.terminal.rows - 2),
			entryId => choose(entryId, false),
			() => done(undefined),
			undefined,
			latestMessage?.id,
		);
		const hint = theme.fg("accent", "Split from…") + theme.fg("dim", "  Enter: split here · Shift+Enter: summarize · Esc: cancel");
		const handleInput = selector.handleInput.bind(selector);
		return {
			render: (width: number) => {
				const w = Math.max(1, width);
				// The hint is wider than narrow terminals: wrap it, and clamp every line to the real width.
				return [...wrapTextWithAnsi(hint, w), ...selector.render(width)].map(line => truncateToWidth(line, w));
			},
			invalidate: () => selector.invalidate(),
			handleInput: (data: string) => {
				const selected = matchesKey(data, "shift+enter") ? selector.getTreeList().getSelectedNode() : undefined;
				if (selected) choose(selected.entry.id, true);
				else handleInput(data);
			},
			get focused() {
				return selector.focused;
			},
			set focused(value: boolean) {
				selector.focused = value;
			},
		};
	});
}

/** Entries that never reach the model, so they do not separate a tool call from its results. */
const CONTEXT_TRANSPARENT = new Set(["thinking_level_change", "model_change", "usage", "custom", "label", "session_info"]);

/**
 * Tool calls still in flight at the end of `branch`: those of the final assistant message that
 * have no result yet. A result is only valid directly after its call, so older unanswered calls
 * (interrupted turns) must not be closed here; pi already supplies their placeholder results in
 * place. Appending results for them at the end left orphaned results that every provider rejects.
 */
export function pendingToolCalls(branch: SessionEntry[]): { id: string; name: string }[] {
	const answered = new Set<string>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (CONTEXT_TRANSPARENT.has(entry.type)) continue;
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if ((message.role as string) === "system") continue;
		if (message.role !== "assistant") return [];
		// pi drops errored and aborted turns from model context; a result for their calls would be orphaned.
		if (message.stopReason === "error" || message.stopReason === "aborted") return [];
		const pending: { id: string; name: string }[] = [];
		for (const block of message.content) {
			if (block.type === "toolCall" && !answered.has(block.id)) pending.push({ id: block.id, name: block.name });
		}
		return pending;
	}
	return [];
}

/** Create the child session file: the root-to-target path, without touching the live parent manager. */
export async function createDetachedSplit(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	target: SplitTarget,
	name?: string,
): Promise<SplitSnapshot> {
	const sourceFile = ctx.sessionManager.getSessionFile();
	if (!sourceFile) throw new Error("The current session is not persisted");
	const targetId = target.kind === "current" ? ctx.sessionManager.getLeafId() : target.entryId;
	if (!targetId || !ctx.sessionManager.getEntry(targetId)) throw new Error("Selected entry was not found");
	const child = SessionManager.open(sourceFile, ctx.sessionManager.getSessionDir(), ctx.cwd);
	let childFile: string | undefined;
	try {
		childFile = child.createBranchedSession(targetId);
		if (!childFile || childFile === sourceFile) throw new Error("The detached split was not persisted");
		// The selected history may end during a tool call. Close only the child's pending
		// calls; the live parent keeps executing and receives its real results.
		for (const call of pendingToolCalls(child.getBranch())) {
			const aborted: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "Not executed in this split; the original session continues independently" }],
				isError: true,
				timestamp: Date.now(),
			};
			child.appendMessage(aborted);
		}
		if (name) child.appendSessionInfo(name);
		return { sessionFile: childFile, sessionId: child.getSessionId() };
	} catch (error) {
		if (childFile && childFile !== sourceFile) await fs.rm(childFile, { force: true }).catch(() => undefined);
		throw error;
	}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

/**
 * The newest user request on the path to `leafId`. Titles come from this, never from the
 * assistant's replies or earlier exchanges, which go stale as the conversation moves on.
 */
export function latestUserRequest(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message.content).trim();
		if (text) return text;
	}
	return undefined;
}

/** The session name in effect at the end of `branch`, if any. */
function branchName(branch: SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
}

export function cleanTitle(raw: string): string | undefined {
	const first = raw.split("\n").find(line => line.trim());
	const title = first
		?.replace(/^\s*(title\s*:\s*)/i, "")
		.replace(/^[\s"'`*#\u201c\u2018]+|[\s"'`*.\u201d\u2019]+$/g, "")
		.replace(/\s+/g, " ");
	return title ? title.slice(0, MAX_TITLE_CHARS) : undefined;
}

type ModelAccess = Pick<ExtensionContext, "model" | "modelRegistry">;

async function completeText(access: ModelAccess, system: string, user: string, timeoutMs: number): Promise<string> {
	if (!access.model) throw new Error("no model is selected");
	// Resolve credentials explicitly so a missing login fails with the registry's own message.
	const auth = await access.modelRegistry.getApiKeyAndHeaders(access.model);
	if (!auth.ok) throw new Error(auth.error);
	const response = await access.modelRegistry.complete(
		access.model,
		{
			systemPrompt: system,
			messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: AbortSignal.timeout(timeoutMs),
			cacheRetention: "none",
			sessionId: randomUUID(),
		},
	);
	if (response.stopReason === "aborted") throw new Error(`the model call timed out after ${Math.round(timeoutMs / 1000)}s`);
	if (response.stopReason === "error") throw new Error(response.errorMessage ?? "the model call failed");
	return messageText(response.content).trim();
}

/** Name a split from `source` (a handoff focus or the latest user request) with the session's current model. */
export async function generateSplitName(access: ModelAccess, source: string, timeoutMs = NAME_TIMEOUT_MS): Promise<string> {
	const text = await completeText(access, TITLE_PROMPT, source.slice(0, MAX_TITLE_INPUT_CHARS), timeoutMs);
	const name = cleanTitle(text);
	if (!name) throw new Error("the title model returned no name");
	return name;
}

/** The context of `branch` as it would be sent to the model, compaction-aware. */
function handoffMessages(branch: SessionEntry[]) {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	const toMessage = (entry: SessionEntry) => {
		if (entry.type === "message") return entry.message;
		if (entry.type === "compaction") {
			return {
				role: "compactionSummary" as const,
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: new Date(entry.timestamp).getTime(),
			};
		}
		return undefined;
	};
	let slice = branch;
	if (compactionIndex >= 0) {
		const compaction = branch[compactionIndex];
		const firstKept = compaction.type === "compaction" ? branch.findIndex(e => e.id === compaction.firstKeptEntryId) : -1;
		slice = [compaction, ...(firstKept >= 0 ? branch.slice(firstKept, compactionIndex) : []), ...branch.slice(compactionIndex + 1)];
	}
	return slice.map(toMessage).filter(message => message !== undefined);
}

/** Summarize the split's history, steered by `focus`; the result becomes the split's whole starting context. */
export async function generateHandoff(
	access: ModelAccess,
	branch: SessionEntry[],
	focus: string,
	timeoutMs = HANDOFF_TIMEOUT_MS,
): Promise<{ summary: string; tokensBefore: number }> {
	const messages = handoffMessages(branch);
	if (messages.length === 0) throw new Error("there is no conversation to hand off");
	const conversation = serializeConversation(convertToLlm(messages));
	const goal = focus ? `\n\n## Focus for the new session\n\n${focus}` : "\n\n## Focus for the new session\n\n(none given; continue the most recent request)";
	const summary = await completeText(access, HANDOFF_PROMPT, `## Conversation\n\n${conversation}${goal}`, timeoutMs);
	if (!summary) throw new Error("the model returned an empty handoff");
	return { summary, tokensBefore: Math.ceil(conversation.length / 4) };
}

/**
 * Write the handoff (as a compaction that keeps only the summary) and the name onto the split.
 * Call only once no other process writes the file: the pane has not started yet.
 */
export function applyToSplit(
	snapshot: SplitSnapshot,
	sessionDir: string,
	cwd: string,
	changes: { handoff?: { summary: string; tokensBefore: number }; name?: string },
): void {
	if (!changes.handoff && !changes.name) return;
	const child = SessionManager.open(snapshot.sessionFile, sessionDir, cwd);
	if (changes.handoff) child.appendCompaction(changes.handoff.summary, null, changes.handoff.tokensBefore, undefined, true);
	if (changes.name) child.appendSessionInfo(changes.name);
}

/** Open the split's pane beside the parent at a shell prompt, leaving focus on the parent. */
export async function createSplitPane(options: Pick<SplitPaneOptions, "cwd" | "exec" | "parentPaneId">): Promise<string> {
	const split = await runHerdr(options.exec, options.cwd, "Herdr pane split", [
		"pane",
		"split",
		options.parentPaneId,
		"--direction",
		"right",
		"--ratio",
		"0.5",
		"--cwd",
		options.cwd,
		"--no-focus",
	]);
	return parsePaneId(split.stdout);
}

/** Start the persisted child in an existing pane and focus it. */
export async function launchSplitSession(options: SplitPaneOptions & { childPaneId: string }): Promise<void> {
	await runHerdr(options.exec, options.cwd, "Split pane startup", [
		"pane",
		"run",
		options.childPaneId,
		resumeCommand(options.launcher, options.sessionFile),
	]);
	await runHerdr(options.exec, options.cwd, "Split pane focus", [
		"pane",
		"focus",
		"--pane",
		options.parentPaneId,
		"--direction",
		"right",
	]);
}

async function closePane(exec: Exec, cwd: string, paneId: string): Promise<void> {
	await exec(process.env.HERDR_BIN || process.env.HERDR_BIN_PATH || "herdr", ["pane", "close", paneId], {
		cwd,
		timeout: HERDR_TIMEOUT_MS,
	});
}

/** Create the pane and start the persisted child in it, closing the pane when startup fails. */
export async function openSplitPane(options: SplitPaneOptions): Promise<string> {
	const childPaneId = await createSplitPane(options);
	try {
		await launchSplitSession({ ...options, childPaneId });
		return childPaneId;
	} catch (error) {
		await closePane(options.exec, options.cwd, childPaneId);
		throw error;
	}
}

/**
 * Progress for a split's background work: the footer counts elapsed time, and the split's pane
 * shows a live status screen until the session can start there. The screen is best-effort;
 * when Herdr refuses the command, the footer alone reports progress.
 */
export class SplitProgress {
	readonly #ui: Ui;
	readonly #file: string;
	readonly #state: ProgressState;
	readonly #ticker: ReturnType<typeof setInterval>;
	#named: string;

	constructor(
		ui: Ui,
		options: { named: string; sessionId: string; focus: string; handoff: boolean; naming: boolean; launcher: string },
	) {
		const now = Date.now();
		this.#ui = ui;
		this.#named = options.named;
		this.#file = path.join(os.tmpdir(), `pi-split-progress-${randomUUID()}.json`);
		this.#state = {
			title: options.named.trim() || "(named when ready)",
			sessionId: options.sessionId,
			focus: options.focus,
			handoff: options.handoff,
			naming: options.naming,
			step: options.handoff ? "handoff" : "naming",
			startedAt: now,
			stepStartedAt: now,
			launcher: options.launcher,
		};
		this.#renderFooter();
		this.#ticker = setInterval(() => this.#renderFooter(), FOOTER_TICK_MS);
		this.#ticker.unref?.();
	}

	async screen(): Promise<[string, string, string, string]> {
		await this.#write();
		return [process.execPath, PROGRESS_PANE_SCRIPT, this.#file, String(process.pid)];
	}

	/** Start the status screen in `paneId`; resolves false when it could not be shown. */
	async showIn(exec: Exec, cwd: string, paneId: string): Promise<boolean> {
		try {
			const command = `command ${shellQuote(await this.screen())}`;
			const result = await exec(process.env.HERDR_BIN || process.env.HERDR_BIN_PATH || "herdr", ["pane", "run", paneId, command], {
				cwd,
				timeout: HERDR_TIMEOUT_MS,
			});
			return result.code === 0;
		} catch {
			return false;
		}
	}

	async setStep(step: ProgressStep, named = this.#named): Promise<void> {
		this.#named = named;
		if (named.trim()) this.#state.title = named.trim();
		this.#state.step = step;
		this.#state.stepStartedAt = Date.now();
		this.#renderFooter();
		await this.#write().catch(() => undefined);
	}

	/** After the "opening" step: wait for the status screen to exit so the resume command reaches the shell. */
	async waitForScreenExit(required: boolean): Promise<void> {
		const deadline = Date.now() + (required ? HERDR_TIMEOUT_MS : PROGRESS_EXIT_WAIT_MS);
		while (Date.now() < deadline) {
			const code = await fs.readFile(`${this.#file}.done`, "utf8").catch(() => undefined);
			if (code !== undefined) {
				if (required && code.trim() !== "0") throw new Error("Split progress screen exited before handoff");
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		if (required) throw new Error("Split progress screen did not acknowledge handoff");
	}

	async dispose(): Promise<void> {
		clearInterval(this.#ticker);
		await Promise.all([fs.rm(this.#file, { force: true }), fs.rm(`${this.#file}.done`, { force: true })]).catch(() => undefined);
	}

	#renderFooter(): void {
		const elapsed = formatElapsed(Date.now() - this.#state.stepStartedAt);
		this.#ui.setStatus(SPLIT_STATUS_KEY, `Split${this.#named}: ${FOOTER_STEP_LABELS[this.#state.step]}… ${elapsed}`);
	}

	async #write(): Promise<void> {
		const pending = `${this.#file}.${process.pid}.tmp`;
		await fs.writeFile(pending, JSON.stringify(this.#state), { mode: 0o600 });
		await fs.rename(pending, this.#file);
	}
}

interface SplitJob {
	snapshot: SplitSnapshot;
	parent: SplitParent;
	cwd: string;
	sessionDir: string;
	request: SplitRequest;
	/** Text to name the split from; undefined keeps the name it already has. */
	titleSource?: string;
	/** Branch of the split, for the handoff. */
	branch: SessionEntry[];
	access: ModelAccess;
	ui: Ui;
	exec: Exec;
	launcher: Launcher;
}

type Settled<T> = { value: T } | { error: string };

const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
	promise.then(
		value => ({ value }),
		(error: unknown) => ({ error: displayError(error) }),
	);

/** Background work and pane launch; runs after the command returns so the parent stays usable. */
async function finishSplit(job: SplitJob): Promise<void> {
	const { snapshot, request, ui, cwd, exec, launcher, parent } = job;
	const parentPaneId = parent.pane;
	const paneOptions = { cwd, exec, parentPaneId, launcher, sessionFile: snapshot.sessionFile };
	let named = request.name ? ` "${request.name}"` : "";
	const saved = path.basename(snapshot.sessionFile);
	const hasFocus = request.focus !== undefined;
	const focus = request.focus?.trim() ?? "";
	// Both model calls start now and run while the pane opens.
	const handoffJob = hasFocus ? settle(generateHandoff(job.access, job.branch, focus)) : undefined;
	const nameJob = job.titleSource ? settle(generateSplitName(job.access, job.titleSource)) : undefined;
	let progress: SplitProgress | undefined;
	let childPaneId: string;
	try {
		if (!handoffJob && !nameJob) {
			ui.setStatus(SPLIT_STATUS_KEY, `Split${named}: opening pane…`);
			if (parent.backend === "app") await openAppPane(exec, cwd, parentPaneId, launcher, snapshot.sessionFile);
			else await openSplitPane(paneOptions);
			ui.notify(`Split${named} opened in an adjacent Herdr pane (${saved})`, "info");
			return;
		}
		progress = new SplitProgress(ui, {
			named,
			sessionId: snapshot.sessionId,
			focus,
			handoff: hasFocus,
			naming: nameJob !== undefined,
			launcher: path.basename(job.launcher.command),
		});
		// The pane opens first so the progress has a place to show.
		let shown = true;
		if (parent.backend === "app") {
			childPaneId = await openAppPane(exec, cwd, parentPaneId, launcher, snapshot.sessionFile, await progress.screen());
			// App splits focus the new pane. Leave the parent usable while the model works.
			await appPaneCommand(exec, cwd, "pane.focus", parentPaneId).catch(error => ui.notify(displayError(error), "warning"));
		} else {
			childPaneId = await createSplitPane(paneOptions);
			shown = await progress.showIn(exec, cwd, childPaneId);
		}
		ui.notify(
			shown
				? `Split${named} opened beside this pane; it shows progress and becomes the session when ready`
				: `Preparing split${named}; the pane beside this one becomes the session when ready`,
			"info",
		);
		const handoff = await handoffJob;
		if (nameJob) await progress.setStep("naming");
		const generated = await nameJob;
		let nameError = generated && "error" in generated ? generated.error : undefined;
		const handoffError = handoff && "error" in handoff ? handoff.error : undefined;
		try {
			// The pane has not started the session yet, so this is the file's only writer.
			applyToSplit(snapshot, job.sessionDir, job.cwd, {
				handoff: handoff && "value" in handoff ? handoff.value : undefined,
				name: generated && "value" in generated ? generated.value : undefined,
			});
			if (generated && "value" in generated) named = ` "${generated.value}"`;
		} catch (error) {
			nameError ??= displayError(error);
		}
		await progress.setStep("opening", named);
		if (parent.backend === "app") {
			// The child's argv execs Pi after the progress program exits successfully.
			try {
				await progress.waitForScreenExit(true);
			} catch (error) {
				await appPaneCommand(exec, cwd, "pane.close", childPaneId).catch(closeError => ui.notify(displayError(closeError), "warning"));
				throw error;
			}
			await appPaneCommand(exec, cwd, "pane.focus", childPaneId).catch(error => ui.notify(displayError(error), "warning"));
		} else {
			await progress.waitForScreenExit(false);
			try {
				await launchSplitSession({ ...paneOptions, childPaneId });
			} catch (error) {
				await closePane(exec, cwd, childPaneId);
				throw error;
			}
		}
		const resumeHint = `${path.basename(job.launcher.command)} --session ${snapshot.sessionId}`;
		if (handoffError !== undefined) {
			ui.notify(`Split${named} opened without a handoff: ${handoffError}. The pane has the full history; summarize there with /compact if needed.`, "warning");
		} else if (nameError !== undefined) {
			ui.notify(`Split${named} opened but kept its original name: ${nameError}. Run /name in that pane (${resumeHint}).`, "warning");
		} else {
			ui.notify(`Split${named} opened${hasFocus ? " on its handoff" : ""} in an adjacent Herdr pane`, "info");
		}
	} catch (error) {
		ui.notify(
			`${displayError(error)}. Split saved as ${saved}; open it with ${path.basename(job.launcher.command)} --session ${snapshot.sessionId}`,
			"error",
		);
	} finally {
		await progress?.dispose();
		ui.setStatus(SPLIT_STATUS_KEY, undefined);
	}
}

export default function herdrSplitExtension(pi: ExtensionAPI): void {
	let launching = false;
	pi.on("session_start", (_event, ctx) => installSplitGuidance(ctx));

	const splitIntoPane = async (ctx: ExtensionContext, rawArgs = ""): Promise<void> => {
		if (["--help", "-h"].includes(rawArgs.trim())) {
			ctx.ui.notify(splitHelp(SPLIT_SHORTCUT), "info");
			return;
		}
		if (launching) {
			ctx.ui.notify("A Herdr pane split is already starting", "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Split requires an interactive Herdr pane", "error");
			return;
		}
		let request: SplitRequest;
		try {
			request = parseSplitArgs(rawArgs);
		} catch (error) {
			ctx.ui.notify(`${displayError(error)}. Usage: ${SPLIT_USAGE}. Examples: /split --help`, "error");
			return;
		}
		launching = true;
		let handedOff = false;
		try {
			const exec: Exec = (command, args, options) => pi.exec(command, args, options);
			const parent = await resolveSplitParent(exec, ctx.cwd);
			const sourceFile = ctx.sessionManager.getSessionFile();
			const sourceId = ctx.sessionManager.getSessionId();
			const choice = await pickSplitPoint(ctx);
			if (!choice) return;
			if (ctx.sessionManager.getSessionFile() !== sourceFile || ctx.sessionManager.getSessionId() !== sourceId) {
				throw new Error("The conversation changed while the tree was open");
			}
			let focus = request.focus;
			if (choice.handoff && focus === undefined) {
				const typed = await askHandoffFocus(ctx);
				if (typed === undefined) return;
				focus = typed.trim();
			}
			const snapshot = await createDetachedSplit(ctx, choice.target, request.name);
			// Everything below reads the split's own path, not the live parent.
			const branch = SessionManager.open(snapshot.sessionFile, ctx.sessionManager.getSessionDir(), ctx.cwd).getBranch();
			const focusText = focus?.trim() ?? "";
			const titleSource = request.name
				? undefined
				: focusText || (branchName(branch) ? undefined : latestUserRequest(branch));
			handedOff = true;
			void finishSplit({
				snapshot,
				parent,
				cwd: ctx.cwd,
				sessionDir: ctx.sessionManager.getSessionDir(),
				request: { name: request.name, focus },
				titleSource,
				branch,
				access: { model: ctx.model, modelRegistry: ctx.modelRegistry },
				ui: ctx.ui,
				exec,
				launcher: resolveLauncher(),
			}).finally(() => {
				launching = false;
			});
		} catch (error) {
			ctx.ui.notify(displayError(error), "error");
		} finally {
			if (!handedOff) launching = false;
		}
	};

	pi.registerCommand("split", {
		description: 'Continue from a message in a new Herdr pane. /split --help for examples.',
		getArgumentCompletions: splitCompletions,
		handler: (args, ctx) => splitIntoPane(ctx, args),
	});
	pi.registerShortcut(SPLIT_SHORTCUT, {
		description: "Pick a point in the session tree and split from it into a new Herdr pane",
		handler: ctx => splitIntoPane(ctx),
	});
}

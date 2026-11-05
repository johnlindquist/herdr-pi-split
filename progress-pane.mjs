/**
 * Placeholder screen for a /split pane while its handoff is written. Runs under plain Node
 * (no pi imports): `node progress-pane.mjs <state-file> <parent-pid>`. `index.ts` owns the
 * state file. Herdr 2 starts Pi when this screen acknowledges "opening" and exits 0;
 * legacy Herdr receives a separate resume command.
 */
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;
/** The parent writes the state file before starting this screen; a missing file past this means it is gone. */
const MISSING_STATE_GRACE_MS = 3_000;

const dim = text => `\x1b[2m${text}\x1b[22m`;
const accent = text => `\x1b[36m${text}\x1b[39m`;
const success = text => `\x1b[32m${text}\x1b[39m`;

export function formatElapsed(ms) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function clip(text, width) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * @param {{ title: string; sessionId: string; focus: string; handoff: boolean; naming: boolean; step: string; startedAt: number; stepStartedAt: number; launcher?: string }} state
 */
export function renderProgress(state, now, frame, width) {
	const steps = [
		{ step: "saved", label: "Split saved" },
		...(state.handoff ? [{ step: "handoff", label: "Writing the handoff" }] : []),
		...(state.naming ? [{ step: "naming", label: "Naming the split" }] : []),
		{ step: "opening", label: "Opening the session" },
	];
	const activeIndex = steps.findIndex(entry => entry.step === state.step);
	const spinner = accent(FRAMES[frame % FRAMES.length]);
	const lines = ["", `  ${accent("Split")} ${clip(state.title, width - 10)}`, ""];
	steps.forEach((entry, index) => {
		if (index < activeIndex) lines.push(`  ${success("✓")} ${entry.label}`);
		else if (index === activeIndex) {
			lines.push(`  ${spinner} ${entry.label}  ${dim(formatElapsed(now - state.stepStartedAt))}`);
		} else lines.push(`  ${dim(`· ${entry.label}`)}`);
	});
	lines.push("");
	if (state.focus) lines.push(`  ${dim(`Focus: ${clip(state.focus, width - 11)}`)}`);
	lines.push(`  ${dim(`Elapsed ${formatElapsed(now - state.startedAt)} · the session opens here when it is ready`)}`);
	return lines;
}

function readState(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function parentAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function main() {
	const [stateFile, parentPidText, mode] = process.argv.slice(2);
	const parentPid = Number(parentPidText);
	if (!stateFile || !Number.isInteger(parentPid) || parentPid <= 0) {
		process.stderr.write("usage: node progress-pane.mjs <state-file> <parent-pid>\n");
		process.exit(2);
	}
	const started = Date.now();
	let frame = 0;
	let last;
	const finish = (message, code = message ? 1 : 0) => {
		process.stdout.write(`\x1b[2J\x1b[H\x1b[?25h${message ? `${message}\n` : ""}`);
		try {
			fs.writeFileSync(`${stateFile}.ack`, String(code), { mode: 0o600 });
			fs.renameSync(`${stateFile}.ack`, `${stateFile}.done`);
		} catch {
			if (mode === "--gate") process.exit(1);
		}
		process.exit(code);
	};
	process.on("SIGINT", () => finish(mode === "--gate" ? "Split launch canceled; the fork is saved." : "Progress screen closed; the split still opens here when its handoff is ready."));
	process.stdout.write("\x1b[?25l\x1b[2J");
	setInterval(() => {
		const state = readState(stateFile);
		if (state) last = state;
		if (state?.step === "opening") finish();
		if (!parentAlive(parentPid)) {
			const launcher = last?.launcher ?? "pi";
			finish(
				`The session that started this split exited before its handoff finished.${last ? ` Resume the split with: ${launcher} --session ${last.sessionId}` : ""}`,
			);
		}
		if (!state && (mode === "--gate" || !last)) {
			if (Date.now() - started > MISSING_STATE_GRACE_MS) finish("Split progress is unavailable.");
			return;
		}
		const lines = renderProgress(last, Date.now(), frame++, process.stdout.columns || 80);
		process.stdout.write(`\x1b[H${lines.map(line => `${line}\x1b[K`).join("\n")}\x1b[J`);
	}, TICK_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

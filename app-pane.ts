import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Exec = ExtensionAPI["exec"];
export type SplitParent = { backend: "app" | "legacy"; pane: string };

async function run(exec: Exec, command: string, args: string[], cwd: string): Promise<string> {
	const result = await exec(command, args, { cwd, timeout: 30_000 });
	if (result.code !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
	return result.stdout;
}

export async function resolveSplitParent(exec: Exec, cwd: string, env = process.env): Promise<SplitParent> {
	const terminal = env.HC_TERMINAL_ID;
	const legacy = env.HERDR_ENV === "1" ? env.HERDR_PANE_ID : undefined;
	if (legacy && !terminal) return { backend: "legacy", pane: legacy };
	if (!terminal) throw new Error("Split requires an interactive Herdr pane");
	if (legacy) {
		// Either multiplexer can be started inside the other and inherit its IDs.
		const table = await run(exec, "ps", ["-axo", "pid=,ppid=,comm="], cwd);
		const parents = new Map<number, { parent: number; name: string }>();
		for (const line of table.split("\n")) {
			const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
			if (row) parents.set(Number(row[1]), { parent: Number(row[2]), name: basename(row[3]) });
		}
		for (let pid = process.ppid; ; ) {
			const ancestor = parents.get(pid);
			if (!ancestor) throw new Error("Cannot tell which Herdr owns this terminal; no pane was split");
			if (ancestor.name === "herdr") return { backend: "legacy", pane: legacy };
			if (ancestor.name === "herdr-core" || ancestor.name === "hc") break;
			pid = ancestor.parent;
		}
	}
	// Terminal IDs are core-local. Match the owning space too: another core can have a t1.
	const record = JSON.parse(await run(exec, "hc", ["get", terminal], cwd)) as { address?: string; labels?: Record<string, string> };
	const spaceId = record?.labels?.["herdr.space"];
	if (record?.address !== terminal || !spaceId) throw new Error(`Terminal ${terminal} does not belong to a Herdr app space`);
	const listing = JSON.parse(await run(exec, "herdr-app", ["ls"], cwd)) as {
		spaces: { id: string; machine?: string | null; tabs: { terminals: { terminal: string; pane: string }[] }[] }[];
	};
	const matches = listing.spaces.filter(s => !s.machine && s.id === spaceId)
		.flatMap(s => s.tabs.flatMap(t => t.terminals.filter(p => p.terminal === terminal && typeof p.pane === "string" && p.pane)));
	if (matches.length !== 1) throw new Error(`No unique Herdr app pane for terminal ${terminal}; check HERDR_APP_HOME and open the terminal in that window`);
	return { backend: "app", pane: matches[0].pane };
}

export async function appPaneCommand(exec: Exec, cwd: string, command: "pane.focus" | "pane.close", pane: string): Promise<string> {
	return run(exec, "herdr-app", ["do", command, JSON.stringify({ pane })], cwd);
}

/** The app accepts argv at split time, not a later command typed into a shell. */
export async function openAppPane(
	exec: Exec, cwd: string, parent: string, launcher: { command: string; env: string[] }, file: string,
	screen?: [node: string, script: string, stateFile: string, parentPid: string],
): Promise<string> {
	// pane.split has no folder argument. Pass all paths as data, never as shell source.
	const start = screen ? 'cd "$1" && "$2" "$3" "$4" "$5" --gate && shift 5 && exec "$@"' : 'cd "$1" && shift && exec "$@"';
	const argv = ["/bin/sh", "-c", start, "split", cwd, ...(screen ?? []), "/usr/bin/env",
		`PATH=${process.env.PATH ?? ""}`, ...launcher.env, launcher.command, "--session", file];
	const result = JSON.parse(await run(exec, "herdr-app", ["do", "pane.split", JSON.stringify({ pane: parent, direction: "right", argv })], cwd));
	if (typeof result?.pane !== "string" || !result.pane || result.pane === parent || typeof result.terminal !== "string" || !result.terminal) {
		throw new Error("Herdr app returned no new terminal pane; inspect the window before retrying");
	}
	return result.pane;
}

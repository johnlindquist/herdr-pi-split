import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openAppPane, resolveSplitParent } from "../app-pane.ts";

const ok = (data: unknown) => ({ stdout: JSON.stringify(data), stderr: "", code: 0, killed: false });
const terminal = { terminal: "t7", pane: "parent" };
function listing(rows: typeof terminal[]): ExtensionAPI["exec"] {
	return async (cmd, args) => {
		if (cmd === "hc" && args.join(" ") === "get t7") return ok({ address: "t7", labels: { "herdr.space": "space1" } });
		if (cmd === "herdr-app" && args.join(" ") === "ls") return ok({ spaces: [
			{ id: "other-core", active: true, tabs: [{ terminals: [terminal] }] },
			{ id: "space1", tabs: [{ terminals: [{ terminal: "t3", pane: "focused" }, ...rows] }] },
		] });
		throw new Error(`Unexpected command: ${cmd} ${args}`);
	};
}

test("resolve the invoking terminal, independent of focus and same-numbered terminals in another space", async () => {
	expect(await resolveSplitParent(listing([terminal]), "/", { HC_TERMINAL_ID: "t7" })).toEqual({ backend: "app", pane: "parent" });
});

test("missing and ambiguous app panes do not fall back to the selected pane", async () => {
	for (const rows of [[], [terminal, { ...terminal, pane: "duplicate" }]]) {
		await expect(resolveSplitParent(listing(rows), "/", { HC_TERMINAL_ID: "t7" })).rejects.toThrow("No unique Herdr app pane");
	}
});

test("standalone legacy panes do not require the app", async () => {
	expect(await resolveSplitParent(() => { throw new Error("unexpected lookup"); }, "/", { HERDR_ENV: "1", HERDR_PANE_ID: "old" }))
		.toEqual({ backend: "legacy", pane: "old" });
});

test("nested multiplexers use the nearest owner, not the inherited pane ID", async () => {
	const mixed = { HC_TERMINAL_ID: "t7", HERDR_ENV: "1", HERDR_PANE_ID: "stale-or-nested" };
	for (const [name, backend] of [["herdr", "legacy"], ["herdr-core", "app"]]) {
		const resolve: ExtensionAPI["exec"] = (cmd, args, opts) => cmd === "ps"
			? Promise.resolve({ ...ok(null), stdout: `${process.ppid} 1 /bin/${name}` }) : listing([terminal])(cmd, args, opts);
		expect((await resolveSplitParent(resolve, "/", mixed)).backend).toBe(backend);
	}
});

test("split failures never retry against focus or accept the parent as the child", async () => {
	for (const reply of [ok({ pane: "parent", terminal: "t8" }), ok({ pane: "child" }), { ...ok(null), code: 1, stderr: "no pane" }]) {
		const calls: string[][] = [];
		const exec: ExtensionAPI["exec"] = async (cmd, args) => { calls.push([cmd, ...args]); return reply; };
		await expect(openAppPane(exec, "/", "parent", { command: "pi", env: [] }, "fork")).rejects.toThrow();
		expect(calls).toHaveLength(1);
		expect(calls[0].slice(0, 3)).toEqual(["herdr-app", "do", "pane.split"]);
		expect(JSON.parse(calls[0][3])).toMatchObject({ pane: "parent", direction: "right" });
	}
});

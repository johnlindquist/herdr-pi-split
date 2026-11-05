import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { createDetachedSplit, pendingToolCalls } from "../index.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-test", input: ["text", "image"] } as Model<"anthropic-messages">;

function call(id: string, stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "true" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}
const result = (toolCallId: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: Date.now(),
});
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

/** The providers' rule: every tool result answers a call of the assistant message right before it. */
function orphanedResults(messages: Message[]): string[] {
	const orphans: string[] = [];
	let open = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			open = new Set(message.content.flatMap(block => (block.type === "toolCall" ? [block.id] : [])));
		} else if (message.role === "toolResult") {
			if (!open.has(message.toolCallId)) orphans.push(message.toolCallId);
		} else {
			open = new Set();
		}
	}
	return orphans;
}

async function splitOf(build: (session: SessionManager) => void) {
	const dir = await mkdtemp(join(tmpdir(), "herdr-split-"));
	dirs.push(dir);
	const parent = SessionManager.create(dir, dir);
	build(parent);
	const snapshot = await createDetachedSplit({ cwd: dir, sessionManager: parent }, { kind: "current" });
	const child = SessionManager.open(snapshot.sessionFile, dir, dir);
	const appended = child
		.getBranch()
		.flatMap(entry => (entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError ? [entry.message.toolCallId] : []));
	const llm = transformMessages(convertToLlm(buildSessionContext(child.getEntries(), child.getLeafId()).messages), model);
	return { appended, orphans: orphanedResults(llm) };
}

describe("herdr-split pending tool calls", () => {
	test("an old interrupted tool call is not closed at the end of the split", async () => {
		// Real failure (2026-10-26 oracle session): an interrupted call from days earlier got a result
		// appended after the newest message; Anthropic and Codex rejected every later request.
		const split = await splitOf(s => {
			s.appendMessage(user("start"));
			s.appendMessage(call("old"));
			s.appendMessage(user("please continue"));
			s.appendMessage(call("done"));
			s.appendMessage(result("done"));
		});
		expect(split.appended).toEqual([]);
		expect(split.orphans).toEqual([]);
	});

	test("an aborted tool call is not closed", async () => {
		const split = await splitOf(s => {
			s.appendMessage(user("start"));
			s.appendMessage(call("aborted", "aborted"));
			s.appendMessage(user("next"));
			s.appendMessage(call("done"));
			s.appendMessage(result("done"));
		});
		expect(split.appended).toEqual([]);
		expect(split.orphans).toEqual([]);
	});

	test("a call still running at the split point is closed directly after it", async () => {
		const split = await splitOf(s => {
			s.appendMessage(user("start"));
			s.appendMessage(call("old"));
			s.appendMessage(user("please continue"));
			s.appendMessage(call("running"));
			s.appendModelChange("anthropic", "claude-test");
		});
		expect(split.appended).toEqual(["running"]);
		expect(split.orphans).toEqual([]);
	});

	test("only unanswered calls of the final assistant message are pending", () => {
		const s = SessionManager.inMemory();
		const both = call("a");
		both.content.push({ type: "toolCall", id: "b", name: "bash", arguments: {} });
		s.appendMessage(both);
		s.appendMessage(result("a"));
		expect(pendingToolCalls(s.getBranch())).toEqual([{ id: "b", name: "bash" }]);
		s.appendMessage(result("b"));
		expect(pendingToolCalls(s.getBranch())).toEqual([]);
	});
});

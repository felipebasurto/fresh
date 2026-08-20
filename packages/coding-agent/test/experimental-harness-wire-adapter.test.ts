import {
	Closed,
	type HarnessEvent,
	type LaneSnapshot as HarnessLaneSnapshot,
	type RunResult as HarnessRunResult,
	InvalidMessage,
	LaneBusy,
	UnknownSkill,
	UnknownTemplate,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	LaneEventSchema,
	LaneSnapshotSchema,
	type PromptArguments,
	type PromptMessage,
	RunResultSchema,
} from "@earendil-works/pi-protocol";
import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	toHarnessPromptArguments,
	toWireLaneEvent,
	toWireLaneSnapshot,
	toWireRunResult,
} from "../src/experimental/harness-wire-adapter.ts";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};

const finalMessage: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "answer", textSignature: "text-signature" },
		{ type: "thinking", thinking: "reason", thinkingSignature: "thinking-signature", redacted: false },
		{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp" }, namespace: "fs" },
	],
	api: "test",
	provider: "test",
	model: "test",
	diagnostics: [{ type: "retry", timestamp: 1, details: { attempt: 2 } }],
	usage,
	stopReason: "stop",
	timestamp: 2,
};

const wireFinalMessage = {
	role: "assistant",
	content: finalMessage.content,
	api: finalMessage.api,
	provider: finalMessage.provider,
	model: finalMessage.model,
	diagnostics: [{ type: "retry", timestamp: 1, details: { attempt: 2 } }],
	usage,
	stopReason: "stop",
	timestamp: 2,
} satisfies PromptMessage;

const promptCases: [label: string, prompt: PromptArguments][] = [
	["text", ["hello"]],
	["text with image", ["hello", [{ type: "image", data: "aW1n", mimeType: "image/png" }]]],
	["one message", [{ role: "user", content: "hello", timestamp: 1 }]],
];

describe("Harness wire adapter", () => {
	test("converts every closed wire prompt message role", () => {
		const prompt = toHarnessPromptArguments([
			[
				{ role: "user", content: "hello", timestamp: 1 },
				wireFinalMessage,
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "read",
					content: [{ type: "text", text: "result" }],
					details: { path: "/tmp" },
					isError: false,
					timestamp: 3,
				},
				{
					role: "bashExecution",
					command: "pwd",
					output: "/tmp",
					cancelled: false,
					truncated: false,
					timestamp: 4,
				},
				{
					role: "custom",
					customType: "notice",
					content: "notice",
					display: true,
					details: { visible: true },
					timestamp: 5,
				},
				{ role: "branchSummary", summary: "branch", fromId: "entry-1", timestamp: 6 },
				{ role: "compactionSummary", summary: "compact", tokensBefore: 100, timestamp: 7 },
			],
		]);

		expect(prompt[0]).toHaveLength(7);
		expect(prompt[0]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "bashExecution", exitCode: undefined }),
				expect.objectContaining({ role: "custom", details: { visible: true } }),
			]),
		);
	});

	test.each(promptCases)("converts %s prompt arguments", (_label, prompt) => {
		expect(toHarnessPromptArguments(prompt)).toEqual(prompt);
	});

	test.each([
		{
			ok: true,
			value: { operation: "run", kind: "completed", runId: "run-1", leafId: "leaf-1" },
		},
		{
			ok: true,
			value: {
				operation: "run",
				kind: "completed",
				runId: "run-1",
				leafId: "leaf-1",
				finalEntryId: "entry-1",
				finalMessage,
			},
		},
		{
			ok: true,
			value: { operation: "run", kind: "aborted", runId: "run-1", leafId: "leaf-1" },
		},
		{
			ok: true,
			value: {
				operation: "run",
				kind: "aborted",
				runId: "run-1",
				leafId: "leaf-1",
				finalEntryId: "entry-1",
				finalMessage,
			},
		},
		{
			ok: true,
			value: {
				operation: "run",
				kind: "failed",
				runId: "run-1",
				leafId: "leaf-1",
				error: { code: "provider", message: "failed", details: { status: 500 } },
			},
		},
		{
			ok: true,
			value: {
				operation: "run",
				kind: "failed",
				runId: "run-1",
				leafId: "leaf-1",
				error: { code: "provider", message: "failed" },
				finalEntryId: "entry-1",
				finalMessage,
			},
		},
		{
			ok: true,
			value: {
				operation: "run",
				kind: "suspended",
				reason: "deferred",
				runId: "run-1",
				leafId: "leaf-1",
				finalEntryId: "entry-1",
				deferred: { provider: "test", modelId: "model", api: "test", id: "deferred-1", data: { row: 1 } },
			},
		},
	] satisfies HarnessRunResult[])("projects every Run outcome %#", (result) => {
		const wire = toWireRunResult(result);
		expect(Check(RunResultSchema, wire)).toBe(true);
		if (!result.ok || !wire.ok) throw new Error("Expected successful run result");
		const { operation: _operation, ...expected } = result.value;
		expect(wire.value).toEqual(expected);
	});

	test.each([
		new LaneBusy({
			lane: "main",
			operationId: "operation-1",
			operationKind: "run",
			message: "busy",
		}),
		new InvalidMessage({ lane: "main", reason: "invalid", message: "invalid" }),
		new UnknownSkill({ name: "skill", message: "unknown" }),
		new UnknownTemplate({ name: "template", message: "unknown" }),
		new Closed({ message: "closed" }),
	])("projects Harness error %s without Error prototypes", (error) => {
		const wire = toWireRunResult({ ok: false, error });
		expect(Check(RunResultSchema, wire)).toBe(true);
		expect(wire).toMatchObject({ ok: false, error: { _tag: error._tag, message: error.message } });
		expect(wire.ok ? undefined : wire.error).not.toBeInstanceOf(Error);
	});

	test("projects lane snapshots through the closed wire schema", () => {
		const snapshot: HarnessLaneSnapshot = {
			lane: "main",
			transcript: [
				{
					id: "entry-1",
					parentId: null,
					seq: 1,
					timestamp: 1,
					type: "message",
					message: { role: "user", content: "hello", timestamp: 1 },
				},
			],
			leafId: "entry-1",
			operation: null,
			queues: { steer: [], followUp: [], nextRun: [] },
			pendingWrites: [],
			faulted: false,
		};
		const wire = toWireLaneSnapshot(snapshot);
		expect(Check(LaneSnapshotSchema, wire)).toBe(true);
		expect(wire).toMatchObject({ lane: "main", transcript: [{ id: "entry-1" }] });
	});

	test("projects assistant updates as compact frames", () => {
		const partial: AssistantMessage = {
			...finalMessage,
			content: [{ type: "text", text: "answer" }],
			stopReason: "pending",
		};
		const event: HarnessEvent = {
			type: "message_update",
			lane: "main",
			runId: "run-1",
			message: partial,
			event: { type: "text_delta", contentIndex: 0, delta: "swer", partial },
		};
		const wire = toWireLaneEvent(event);
		expect(Check(LaneEventSchema, wire)).toBe(true);
		expect(wire).toEqual({
			type: "message_update",
			lane: "main",
			runId: "run-1",
			frame: { type: "text_delta", contentIndex: 0, delta: "swer" },
		});
	});

	test("rejects non-JSON values in Harness output", () => {
		const unsafeMessage: AssistantMessage = {
			...finalMessage,
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { when: new Date(0) } }],
		};
		const result: HarnessRunResult = {
			ok: true,
			value: {
				operation: "run",
				kind: "completed",
				runId: "run-1",
				leafId: "leaf-1",
				finalEntryId: "entry-1",
				finalMessage: unsafeMessage,
			},
		};
		expect(() => toWireRunResult(result)).toThrow(/not JSON-serializable/);
	});
});

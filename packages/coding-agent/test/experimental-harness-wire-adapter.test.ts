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
	type JsonValue,
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
			value: {
				operationId: "run-1",
				kind: "run",
				status: "completed",
				fromTipId: null,
				tipId: "leaf-1",
				startedAt: 1,
				endedAt: 2,
			},
		},
		{
			ok: true,
			value: {
				operationId: "run-1",
				kind: "run",
				status: "aborted",
				fromTipId: "source",
				tipId: "leaf-1",
				startedAt: 1,
				endedAt: 2,
			},
		},
		{
			ok: true,
			value: {
				operationId: "run-1",
				kind: "run",
				status: "failed",
				error: { code: "provider", message: "failed", details: { status: 500 } },
				fromTipId: null,
				tipId: "leaf-1",
				startedAt: 1,
				endedAt: 2,
			},
		},
		{
			ok: true,
			value: {
				operationId: "run-1",
				status: "suspended",
				deferred: { provider: "test", modelId: "model", api: "test", id: "deferred-1", data: { row: 1 } },
			},
		},
	] satisfies HarnessRunResult[])("projects every Run outcome %#", (result) => {
		const wire = toWireRunResult(result);
		expect(Check(RunResultSchema, wire)).toBe(true);
		if (!result.ok || !wire.ok) throw new Error("Expected successful run result");
		expect(wire.value).toEqual(result.value);
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
			tipId: "entry-1",
			lastOperationId: null,
			operation: null,
			queues: { steer: [], followUp: [], nextRun: [] },
			pendingWrites: [],
			faulted: false,
		};
		const wire = toWireLaneSnapshot(snapshot);
		expect(Check(LaneSnapshotSchema, wire)).toBe(true);
		expect(wire).toMatchObject({ lane: "main", transcript: [{ id: "entry-1" }] });
	});

	test("projects family-neutral operation abort events", () => {
		const event: HarnessEvent = {
			type: "operation_abort",
			lane: "main",
			operationId: "operation-1",
			steer: [{ role: "user", content: "steer", timestamp: 1 }],
			followUp: [{ role: "user", content: "follow", timestamp: 2 }],
		};
		const wire = toWireLaneEvent(event);
		expect(Check(LaneEventSchema, wire)).toBe(true);
		expect(wire).toMatchObject({ type: "operation_abort", operationId: "operation-1" });
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
			frame: { type: "text_delta", contentIndex: 0, delta: "swer" },
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
		const details = { when: null } satisfies JsonValue;
		Object.defineProperty(details, "when", { value: new Date(0) });
		const result: HarnessRunResult = {
			ok: true,
			value: {
				operationId: "run-1",
				kind: "run",
				status: "failed",
				error: { code: "provider", message: "failed", details },
				fromTipId: null,
				tipId: "leaf-1",
				startedAt: 1,
				endedAt: 2,
			},
		};
		expect(() => toWireRunResult(result)).toThrow(/not JSON-serializable/);
	});
});

import type { HarnessEvent, LaneSnapshot as HarnessLaneSnapshot } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { LaneEventSchema, LaneSnapshotSchema } from "@earendil-works/pi-protocol";
import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import { toWireLaneEvent, toWireLaneSnapshot } from "../src/experimental/harness-wire-adapter.ts";

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

describe("Harness wire adapter", () => {
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
			configuration: {
				model: { provider: "faux", modelId: "faux-1" },
				thinkingLevel: "off",
				activeToolNames: [],
			},
			stats: { messageCount: 1, usage: finalMessage.usage },
			operation: null,
			queues: [],
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
			message: partial,
			frame: { type: "text_delta", contentIndex: 0, delta: "swer" },
		});
	});
});

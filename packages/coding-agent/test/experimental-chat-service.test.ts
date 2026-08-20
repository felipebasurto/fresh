import {
	type AgentHarness,
	BACKGROUND_CONTEXT,
	Closed,
	type RunResult as HarnessRunResult,
	InvalidMessage,
	LaneBusy,
	RemoteServiceProvider,
	ServiceSliceNotImplemented,
	UnknownSkill,
	UnknownTemplate,
} from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { Chat } from "../src/experimental/services/chat.ts";
import { provideChatService, toChatPromptResponse } from "../src/experimental/services/chat-provider.ts";

const admissionErrors = [
	[
		new LaneBusy({
			lane: "main",
			operationId: "operation-1",
			operationKind: "run",
			message: "busy",
		}),
		"lane_busy",
		"operation-1",
	],
	[new InvalidMessage({ lane: "main", reason: "invalid", message: "invalid" }), "invalid_message", null],
	[new UnknownSkill({ name: "skill", message: "unknown" }), "unknown_skill", null],
	[new UnknownTemplate({ name: "template", message: "unknown" }), "unknown_template", null],
	[new Closed({ message: "closed" }), "closed", null],
] as const satisfies readonly [Extract<HarnessRunResult, { ok: false }>["error"], string, string | null][];

describe("Chat service", () => {
	test("provides prompt and durable abort methods", async () => {
		const prompt = vi.fn(async () => ({
			ok: true as const,
			value: {
				operation: "run" as const,
				kind: "completed" as const,
				runId: "operation-1",
				leafId: "entry-1",
			},
		}));
		const requestAbort = vi.fn(async () => ({
			ok: true as const,
			value: {
				operationId: "operation-1",
				newlyRequested: true,
				steer: [],
				followUp: [],
			},
		}));
		const provider = new RemoteServiceProvider([Chat]);
		provideChatService(provider, { prompt, requestAbort } as unknown as AgentHarness);
		try {
			await expect(
				provider.invoke(
					{ serviceId: "chat", member: "prompt", args: [{ message: "hello", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ accepted: true, operationId: "operation-1", error: null });
			await expect(
				provider.invoke({ serviceId: "chat", member: "requestAbort", args: ["operation-1"] }, BACKGROUND_CONTEXT),
			).resolves.toBeUndefined();
			expect(prompt).toHaveBeenCalledWith("hello", undefined, BACKGROUND_CONTEXT);
			expect(requestAbort).toHaveBeenCalledWith("operation-1", BACKGROUND_CONTEXT);
			await expect(
				provider.invoke(
					{ serviceId: "chat", member: "steer", args: [{ message: "later", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);
		} finally {
			provider.dispose();
		}
	});

	test("reports accepted successful and failed operations", () => {
		expect(
			toChatPromptResponse({
				ok: true,
				value: { operation: "run", kind: "completed", runId: "operation-1", leafId: "entry-1" },
			}),
		).toEqual({ accepted: true, operationId: "operation-1", error: null });
		expect(
			toChatPromptResponse({
				ok: true,
				value: {
					operation: "run",
					kind: "failed",
					runId: "operation-2",
					leafId: "entry-1",
					error: { code: "provider", message: "failed", details: { status: 500 } },
				},
			}),
		).toEqual({
			accepted: true,
			operationId: "operation-2",
			error: { code: "provider", message: "failed" },
		});
	});

	test.each(admissionErrors)("maps admission error %# to a stable response", (error, code, operationId) => {
		expect(toChatPromptResponse({ ok: false, error })).toEqual({
			accepted: false,
			operationId,
			error: { code, message: error.message },
		});
	});
});

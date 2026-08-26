import {
	type AgentHarness,
	type AgentLane,
	BACKGROUND_CONTEXT,
	Closed,
	type RunResult as HarnessRunResult,
	InvalidMessage,
	LaneBusy,
	ServiceSliceNotImplemented,
	UnknownSkill,
	UnknownTemplate,
} from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { assembleFacetServices } from "../src/experimental/facets.ts";
import { chatServiceFacet, toChatPromptResponse } from "../src/experimental/services/chat-provider.ts";
import type { SessionFacetAttributes } from "../src/experimental/services/session-facet.ts";

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
				operationId: "operation-1",
				kind: "run" as const,
				status: "completed" as const,
				fromTipId: null,
				tipId: "entry-1",
				startedAt: 1,
				endedAt: 2,
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
		const lane = { prompt, requestAbort } as unknown as AgentLane;
		const generation = await assembleFacetServices<SessionFacetAttributes>({
			facets: [chatServiceFacet],
			attributes: { harness: {} as unknown as AgentHarness, lane, modelRuntime: undefined },
		});
		try {
			await expect(
				generation.provider.invoke(
					{ serviceId: "pi.chat", member: "prompt", args: [{ message: "hello", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ accepted: true, operationId: "operation-1", error: null });
			await expect(
				generation.provider.invoke(
					{ serviceId: "pi.chat", member: "requestAbort", args: ["operation-1"] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toBeUndefined();
			expect(prompt).toHaveBeenCalledWith("hello", undefined, BACKGROUND_CONTEXT);
			expect(requestAbort).toHaveBeenCalledWith("operation-1", BACKGROUND_CONTEXT);
			await expect(
				generation.provider.invoke(
					{ serviceId: "pi.chat", member: "steer", args: [{ message: "later", images: null }] },
					BACKGROUND_CONTEXT,
				),
			).rejects.toBeInstanceOf(ServiceSliceNotImplemented);
		} finally {
			await generation.dispose();
		}
	});

	test("reports accepted successful and failed operations", () => {
		expect(
			toChatPromptResponse({
				ok: true,
				value: {
					operationId: "operation-1",
					kind: "run",
					status: "completed",
					fromTipId: null,
					tipId: "entry-1",
					startedAt: 1,
					endedAt: 2,
				},
			}),
		).toEqual({ accepted: true, operationId: "operation-1", error: null });
		expect(
			toChatPromptResponse({
				ok: true,
				value: {
					operationId: "operation-2",
					kind: "run",
					status: "failed",
					error: { code: "provider", message: "failed", details: { status: 500 } },
					fromTipId: null,
					tipId: "entry-1",
					startedAt: 1,
					endedAt: 2,
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

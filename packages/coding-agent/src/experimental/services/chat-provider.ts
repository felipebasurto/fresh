import {
	type AgentLane,
	type RunResult as HarnessRunResult,
	ServiceSliceNotImplemented,
	SliceNotImplemented,
} from "@earendil-works/pi-agent-core";
import type { PromptArguments } from "@earendil-works/pi-protocol";
import { defineFacet } from "../facets.ts";
import { toHarnessPromptArguments } from "../harness-wire-adapter.ts";
import { Chat, type ChatPromptRequest, type ChatPromptResponse, type Chat as ChatService } from "./chat.ts";
import { Lane } from "./harness.ts";

export function createChatService(lane: AgentLane): ChatService {
	return {
		async prompt(request, context) {
			return mapHarnessSlice("Chat.prompt", async () => {
				const prompt = toHarnessPromptArguments(toPromptArguments(request));
				const result =
					typeof prompt[0] === "string"
						? await lane.prompt(prompt[0], prompt[1], context)
						: await lane.prompt(prompt[0], context);
				return toChatPromptResponse(result);
			});
		},
		async requestAbort(operationId, context) {
			await mapHarnessSlice("Chat.requestAbort", async () => {
				const result = await lane.requestAbort(operationId, context);
				if (!result.ok) throw new Error(result.error.message);
			});
		},
		async steer() {
			throw new ServiceSliceNotImplemented("Chat.steer");
		},
		async followUp() {
			throw new ServiceSliceNotImplemented("Chat.followUp");
		},
		async nextRun() {
			throw new ServiceSliceNotImplemented("Chat.nextRun");
		},
		async cancelQueued() {
			throw new ServiceSliceNotImplemented("Chat.cancelQueued");
		},
		async resume() {
			throw new ServiceSliceNotImplemented("Chat.resume");
		},
		async compact() {
			throw new ServiceSliceNotImplemented("Chat.compact");
		},
		async navigate() {
			throw new ServiceSliceNotImplemented("Chat.navigate");
		},
	};
}

async function mapHarnessSlice<T>(operation: string, callback: () => Promise<T>): Promise<T> {
	try {
		return await callback();
	} catch (error) {
		if (error instanceof SliceNotImplemented) throw new ServiceSliceNotImplemented(operation);
		throw error;
	}
}

export const chatServiceFacet = defineFacet({
	id: "@pi/chat",
	setup(env) {
		env.provide(Chat, createChatService(env.use(Lane)));
	},
});

export function toChatPromptResponse(result: HarnessRunResult): ChatPromptResponse {
	if (result.ok) {
		return {
			accepted: true,
			operationId: result.value.operationId,
			error:
				result.value.status === "failed" && result.value.error !== undefined
					? {
							code: result.value.error.code,
							message: result.value.error.message,
						}
					: null,
		};
	}
	const code = {
		LaneBusy: "lane_busy",
		InvalidMessage: "invalid_message",
		UnknownSkill: "unknown_skill",
		UnknownTemplate: "unknown_template",
		Closed: "closed",
	}[result.error._tag];
	return {
		accepted: false,
		operationId: result.error._tag === "LaneBusy" ? result.error.operationId : null,
		error: { code, message: result.error.message },
	};
}

function toPromptArguments(request: ChatPromptRequest): PromptArguments {
	return request.images === null ? [request.message] : [request.message, request.images];
}

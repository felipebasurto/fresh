import type { AgentHarness, RunResult as HarnessRunResult, RemoteServiceProvider } from "@earendil-works/pi-agent-core";
import type { PromptArguments } from "@earendil-works/pi-protocol";
import { toHarnessPromptArguments } from "../harness-wire-adapter.ts";
import { Chat, type ChatPromptRequest, type ChatPromptResponse } from "./chat.ts";

export function provideChatService(provider: RemoteServiceProvider, harness: AgentHarness): void {
	provider.provide(Chat, {
		async prompt(request, context) {
			const prompt = toHarnessPromptArguments(toPromptArguments(request));
			const result =
				typeof prompt[0] === "string"
					? await harness.prompt(prompt[0], prompt[1], context)
					: await harness.prompt(prompt[0], context);
			return toChatPromptResponse(result);
		},
		async requestAbort(operationId, context) {
			const result = await harness.requestAbort(operationId, context);
			if (!result.ok) throw new Error(result.error.message);
		},
	});
}

export function toChatPromptResponse(result: HarnessRunResult): ChatPromptResponse {
	if (result.ok) {
		return {
			accepted: true,
			operationId: result.value.runId,
			error:
				result.value.kind === "failed"
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

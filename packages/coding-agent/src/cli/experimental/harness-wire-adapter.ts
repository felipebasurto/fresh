import type {
	AgentMessage,
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	RunResult as HarnessRunResult,
} from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	type JsonValue,
	JsonValueSchema,
	type PromptArguments,
	type PromptImage,
	type PromptMessage,
	type RunResult,
} from "@earendil-works/pi-protocol";
import { Check } from "typebox/value";

type HarnessPromptArguments =
	| [text: string]
	| [text: string, images: ImageContent[]]
	| [message: AgentMessage | AgentMessage[]];
type WireAssistantMessage = Extract<PromptMessage, { role: "assistant" }>;
type WireUserMessage = Extract<PromptMessage, { role: "user" }>;
type WireToolResultMessage = Extract<PromptMessage, { role: "toolResult" }>;
type WireBashExecutionMessage = Extract<PromptMessage, { role: "bashExecution" }>;
type WireCustomMessage = Extract<PromptMessage, { role: "custom" }>;
type WireBranchSummaryMessage = Extract<PromptMessage, { role: "branchSummary" }>;
type WireCompactionSummaryMessage = Extract<PromptMessage, { role: "compactionSummary" }>;
type SameKeys<TLeft, TRight> = Exclude<keyof TLeft, keyof TRight> extends never
	? Exclude<keyof TRight, keyof TLeft> extends never
		? true
		: false
	: false;
type Assert<T extends true> = T;

/** Compile-time alarms for field additions on either side of each closed message adapter. */
export type HarnessWireAdapterCompatibility = [
	Assert<SameKeys<PromptImage, ImageContent>>,
	Assert<SameKeys<WireUserMessage, UserMessage>>,
	Assert<SameKeys<WireAssistantMessage, AssistantMessage>>,
	Assert<SameKeys<WireToolResultMessage, ToolResultMessage>>,
	Assert<SameKeys<WireBashExecutionMessage, BashExecutionMessage>>,
	Assert<SameKeys<WireCustomMessage, CustomMessage>>,
	Assert<SameKeys<WireBranchSummaryMessage, BranchSummaryMessage>>,
	Assert<SameKeys<WireCompactionSummaryMessage, CompactionSummaryMessage>>,
];
type WireRunValue = Extract<RunResult, { ok: true }>["value"];
type WireRunError = Extract<RunResult, { ok: false }>["error"];

export function toHarnessPromptArguments(prompt: PromptArguments): HarnessPromptArguments {
	if (typeof prompt[0] === "string") {
		return prompt.length === 1 ? [prompt[0]] : [prompt[0], prompt[1].map(toHarnessImage)];
	}
	return [Array.isArray(prompt[0]) ? prompt[0].map(toHarnessMessage) : toHarnessMessage(prompt[0])];
}

export function toWireRunResult(result: HarnessRunResult): RunResult {
	return result.ok
		? { ok: true, value: toWireRunValue(result.value) }
		: { ok: false, error: toWireRunError(result.error) };
}

function toHarnessImage(image: PromptImage): ImageContent {
	return { type: "image", data: image.data, mimeType: image.mimeType };
}

function toHarnessMessage(message: PromptMessage): AgentMessage {
	switch (message.role) {
		case "user":
			return {
				role: "user",
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((content) =>
								content.type === "text"
									? {
											type: "text",
											text: content.text,
											...(content.textSignature === undefined
												? {}
												: { textSignature: content.textSignature }),
										}
									: toHarnessImage(content),
							),
				timestamp: message.timestamp,
			} satisfies UserMessage;
		case "assistant":
			return {
				role: "assistant",
				content: message.content.map((content): TextContent | ThinkingContent | ToolCall => {
					switch (content.type) {
						case "text":
							return {
								type: "text",
								text: content.text,
								...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
							};
						case "thinking":
							return {
								type: "thinking",
								thinking: content.thinking,
								...(content.thinkingSignature === undefined
									? {}
									: { thinkingSignature: content.thinkingSignature }),
								...(content.redacted === undefined ? {} : { redacted: content.redacted }),
							};
						case "toolCall":
							return {
								type: "toolCall",
								id: content.id,
								name: content.name,
								arguments: content.arguments,
								...(content.thoughtSignature === undefined
									? {}
									: { thoughtSignature: content.thoughtSignature }),
								...(content.namespace === undefined ? {} : { namespace: content.namespace }),
							};
						default:
							return assertNever(content);
					}
				}),
				api: message.api,
				provider: message.provider,
				model: message.model,
				...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
				...(message.responseId === undefined ? {} : { responseId: message.responseId }),
				...(message.diagnostics === undefined ? {} : { diagnostics: message.diagnostics }),
				usage: toHarnessUsage(message.usage),
				stopReason: message.stopReason,
				...(message.deferred === undefined ? {} : { deferred: toHarnessDeferred(message.deferred) }),
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
				...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
				...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
				timestamp: message.timestamp,
			} satisfies AssistantMessage;
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content.map((content) =>
					content.type === "text"
						? {
								type: "text",
								text: content.text,
								...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
							}
						: toHarnessImage(content),
				),
				...(message.details === undefined ? {} : { details: message.details }),
				...(message.usage === undefined ? {} : { usage: toHarnessUsage(message.usage) }),
				...(message.addedToolNames === undefined ? {} : { addedToolNames: [...message.addedToolNames] }),
				isError: message.isError,
				timestamp: message.timestamp,
			} satisfies ToolResultMessage;
		case "bashExecution":
			return {
				role: "bashExecution",
				command: message.command,
				output: message.output,
				exitCode: message.exitCode,
				cancelled: message.cancelled,
				truncated: message.truncated,
				...(message.fullOutputPath === undefined ? {} : { fullOutputPath: message.fullOutputPath }),
				timestamp: message.timestamp,
				...(message.excludeFromContext === undefined ? {} : { excludeFromContext: message.excludeFromContext }),
			} satisfies BashExecutionMessage;
		case "custom":
			return {
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				...(message.details === undefined ? {} : { details: message.details }),
				timestamp: message.timestamp,
			} satisfies CustomMessage<JsonValue>;
		case "branchSummary":
			return {
				role: "branchSummary",
				summary: message.summary,
				fromId: message.fromId,
				timestamp: message.timestamp,
			} satisfies BranchSummaryMessage;
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: message.summary,
				tokensBefore: message.tokensBefore,
				timestamp: message.timestamp,
			} satisfies CompactionSummaryMessage;
		default:
			return assertNever(message);
	}
}

function toHarnessUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
		...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

function toHarnessDeferred(deferred: DeferredHandle): DeferredHandle {
	return {
		provider: deferred.provider,
		modelId: deferred.modelId,
		api: deferred.api,
		id: deferred.id,
		...(deferred.expiresAt === undefined ? {} : { expiresAt: deferred.expiresAt }),
		...(deferred.pollAfterMs === undefined ? {} : { pollAfterMs: deferred.pollAfterMs }),
		...(deferred.data === undefined ? {} : { data: deferred.data }),
	};
}

function toWireRunValue(value: Extract<HarnessRunResult, { ok: true }>["value"]): WireRunValue {
	switch (value.kind) {
		case "completed":
			return value.finalEntryId === undefined
				? { kind: "completed", runId: value.runId, leafId: value.leafId }
				: {
						kind: "completed",
						runId: value.runId,
						leafId: value.leafId,
						finalEntryId: value.finalEntryId,
						finalMessage: toWireAssistantMessage(value.finalMessage),
					};
		case "aborted":
			return value.finalEntryId === undefined
				? { kind: "aborted", runId: value.runId, leafId: value.leafId }
				: {
						kind: "aborted",
						runId: value.runId,
						leafId: value.leafId,
						finalEntryId: value.finalEntryId,
						finalMessage: toWireAssistantMessage(value.finalMessage),
					};
		case "failed": {
			const error = {
				code: value.error.code,
				message: value.error.message,
				...(value.error.details === undefined
					? {}
					: { details: toWireJsonValue(value.error.details, "operation error details") }),
			};
			return value.finalEntryId === undefined
				? { kind: "failed", runId: value.runId, leafId: value.leafId, error }
				: {
						kind: "failed",
						runId: value.runId,
						leafId: value.leafId,
						error,
						finalEntryId: value.finalEntryId,
						finalMessage: toWireAssistantMessage(value.finalMessage),
					};
		}
		case "suspended":
			if (value.reason === "deferred") {
				return {
					kind: "suspended",
					reason: "deferred",
					runId: value.runId,
					leafId: value.leafId,
					finalEntryId: value.finalEntryId,
					deferred: toWireDeferred(value.deferred),
				};
			}
			return {
				kind: "suspended",
				reason: "missing_identities",
				runId: value.runId,
				leafId: value.leafId,
				missing: { tools: [...value.missing.tools], models: [...value.missing.models] },
			};
		default:
			return assertNever(value);
	}
}

function toWireRunError(error: Extract<HarnessRunResult, { ok: false }>["error"]): WireRunError {
	switch (error._tag) {
		case "LaneBusy":
			return {
				_tag: "LaneBusy",
				lane: error.lane,
				operationId: error.operationId,
				operationKind: error.operationKind,
				message: error.message,
			};
		case "MissingIdentities":
			return {
				_tag: "MissingIdentities",
				lane: error.lane,
				tools: [...error.tools],
				models: [...error.models],
				message: error.message,
			};
		case "InvalidMessage":
			return { _tag: "InvalidMessage", lane: error.lane, reason: error.reason, message: error.message };
		case "UnknownSkill":
			return { _tag: "UnknownSkill", name: error.name, message: error.message };
		case "UnknownTemplate":
			return { _tag: "UnknownTemplate", name: error.name, message: error.message };
		case "Closed":
			return { _tag: "Closed", message: error.message };
		default:
			return assertNever(error);
	}
}

function toWireAssistantMessage(message: AssistantMessage): WireAssistantMessage {
	return {
		role: "assistant",
		content: message.content.map((content) => {
			switch (content.type) {
				case "text":
					return {
						type: "text" as const,
						text: content.text,
						...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
					};
				case "thinking":
					return {
						type: "thinking" as const,
						thinking: content.thinking,
						...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
						...(content.redacted === undefined ? {} : { redacted: content.redacted }),
					};
				case "toolCall":
					return {
						type: "toolCall" as const,
						id: content.id,
						name: content.name,
						arguments: Object.fromEntries(
							Object.entries(content.arguments).map(([key, value]) => [
								key,
								toWireJsonValue(value, `tool argument ${key}`),
							]),
						),
						...(content.thoughtSignature === undefined ? {} : { thoughtSignature: content.thoughtSignature }),
						...(content.namespace === undefined ? {} : { namespace: content.namespace }),
					};
				default:
					return assertNever(content);
			}
		}),
		api: message.api,
		provider: message.provider,
		model: message.model,
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		...(message.diagnostics === undefined
			? {}
			: {
					diagnostics: message.diagnostics.map((diagnostic) => ({
						type: diagnostic.type,
						timestamp: diagnostic.timestamp,
						...(diagnostic.error === undefined
							? {}
							: {
									error: {
										...(diagnostic.error.name === undefined ? {} : { name: diagnostic.error.name }),
										message: diagnostic.error.message,
										...(diagnostic.error.stack === undefined ? {} : { stack: diagnostic.error.stack }),
										...(diagnostic.error.code === undefined ? {} : { code: diagnostic.error.code }),
									},
								}),
						...(diagnostic.details === undefined
							? {}
							: {
									details: Object.fromEntries(
										Object.entries(diagnostic.details).map(([key, value]) => [
											key,
											toWireJsonValue(value, `diagnostic detail ${key}`),
										]),
									),
								}),
					})),
				}),
		usage: toHarnessUsage(message.usage),
		stopReason: message.stopReason,
		...(message.deferred === undefined ? {} : { deferred: toWireDeferred(message.deferred) }),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
		...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
		timestamp: message.timestamp,
	};
}

function toWireDeferred(deferred: DeferredHandle): WireAssistantMessage["deferred"] & object {
	return {
		provider: deferred.provider,
		modelId: deferred.modelId,
		api: deferred.api,
		id: deferred.id,
		...(deferred.expiresAt === undefined ? {} : { expiresAt: deferred.expiresAt }),
		...(deferred.pollAfterMs === undefined ? {} : { pollAfterMs: deferred.pollAfterMs }),
		...(deferred.data === undefined ? {} : { data: toWireJsonValue(deferred.data, "deferred data") }),
	};
}

function toWireJsonValue(value: unknown, field: string): JsonValue {
	if (!Check(JsonValueSchema, value)) throw new TypeError(`Harness ${field} is not JSON-serializable`);
	return value;
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported Harness value: ${String(value)}`);
}

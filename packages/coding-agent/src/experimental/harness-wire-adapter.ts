import type {
	AgentMessage,
	AgentToolResult,
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
	Entry,
	HarnessEvent,
	LaneSnapshot as HarnessLaneSnapshot,
} from "@earendil-works/pi-agent-core";
import type {
	AssistantMessageFrame as AiAssistantMessageFrame,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessageFrame,
	JsonValue,
	LaneEntry,
	LaneEvent,
	LaneSnapshot,
	OperationResultRecord,
	ToolOutput,
	WireAgentMessage,
	WireImageContent,
} from "@earendil-works/pi-protocol";

type WireAssistantMessage = Extract<WireAgentMessage, { role: "assistant" }>;
type WireUserMessage = Extract<WireAgentMessage, { role: "user" }>;
type WireToolResultMessage = Extract<WireAgentMessage, { role: "toolResult" }>;
type WireBashExecutionMessage = Extract<WireAgentMessage, { role: "bashExecution" }>;
type WireCustomMessage = Extract<WireAgentMessage, { role: "custom" }>;
type WireBranchSummaryMessage = Extract<WireAgentMessage, { role: "branchSummary" }>;
type WireCompactionSummaryMessage = Extract<WireAgentMessage, { role: "compactionSummary" }>;
type SameKeys<TLeft, TRight> = Exclude<keyof TLeft, keyof TRight> extends never
	? Exclude<keyof TRight, keyof TLeft> extends never
		? true
		: false
	: false;
type Assert<T extends true> = T;

/** Compile-time alarms for field additions on either side of each closed message adapter. */
export type HarnessWireAdapterCompatibility = [
	Assert<SameKeys<WireImageContent, ImageContent>>,
	Assert<SameKeys<WireUserMessage, UserMessage>>,
	Assert<SameKeys<WireAssistantMessage, AssistantMessage>>,
	Assert<SameKeys<WireToolResultMessage, ToolResultMessage>>,
	Assert<SameKeys<WireBashExecutionMessage, BashExecutionMessage>>,
	Assert<SameKeys<WireCustomMessage, CustomMessage>>,
	Assert<SameKeys<WireBranchSummaryMessage, BranchSummaryMessage>>,
	Assert<SameKeys<WireCompactionSummaryMessage, CompactionSummaryMessage>>,
];
function toWireUsage(usage: Usage): Usage {
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

function toWireOperationResult(value: NonNullable<HarnessLaneSnapshot["lastResult"]>): OperationResultRecord {
	const base = {
		operationId: value.operationId,
		kind: value.kind,
		fromTipId: value.fromTipId,
		tipId: value.tipId,
		startedAt: value.startedAt,
		endedAt: value.endedAt,
	};
	if (value.status !== "failed") return { ...base, status: value.status };
	if (value.error === undefined) throw new TypeError("Failed harness result is missing its error");
	return {
		...base,
		status: "failed",
		error: {
			code: value.error.code,
			message: value.error.message,
			...(value.error.details === undefined ? {} : { details: toWireJsonValue(value.error.details) }),
		},
	};
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
							Object.entries(content.arguments).map(([key, value]) => [key, toWireJsonValue(value)]),
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
										Object.entries(diagnostic.details).map(([key, value]) => [key, toWireJsonValue(value)]),
									),
								}),
					})),
				}),
		usage: toWireUsage(message.usage),
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
		...(deferred.data === undefined ? {} : { data: toWireJsonValue(deferred.data) }),
	};
}

function toWireJsonValue(value: unknown): JsonValue {
	return value as JsonValue;
}

function toWireMessage(message: AgentMessage): WireAgentMessage {
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
											type: "text" as const,
											text: content.text,
											...(content.textSignature === undefined
												? {}
												: { textSignature: content.textSignature }),
										}
									: { type: "image" as const, data: content.data, mimeType: content.mimeType },
							),
				timestamp: message.timestamp,
			};
		case "assistant":
			return toWireAssistantMessage(message);
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content.map((content) =>
					content.type === "text"
						? {
								type: "text" as const,
								text: content.text,
								...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
							}
						: { type: "image" as const, data: content.data, mimeType: content.mimeType },
				),
				...(message.details === undefined ? {} : { details: toWireJsonValue(message.details) }),
				...(message.usage === undefined ? {} : { usage: toWireUsage(message.usage) }),
				...(message.addedToolNames === undefined ? {} : { addedToolNames: [...message.addedToolNames] }),
				isError: message.isError,
				timestamp: message.timestamp,
			};
		case "bashExecution":
			return {
				role: "bashExecution",
				command: message.command,
				output: message.output,
				...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
				cancelled: message.cancelled,
				truncated: message.truncated,
				...(message.fullOutputPath === undefined ? {} : { fullOutputPath: message.fullOutputPath }),
				timestamp: message.timestamp,
				...(message.excludeFromContext === undefined ? {} : { excludeFromContext: message.excludeFromContext }),
			};
		case "custom":
			return {
				role: "custom",
				customType: message.customType,
				content:
					typeof message.content === "string"
						? message.content
						: message.content.map((content) =>
								content.type === "text"
									? {
											type: "text" as const,
											text: content.text,
											...(content.textSignature === undefined
												? {}
												: { textSignature: content.textSignature }),
										}
									: { type: "image" as const, data: content.data, mimeType: content.mimeType },
							),
				display: message.display,
				...(message.details === undefined ? {} : { details: toWireJsonValue(message.details) }),
				timestamp: message.timestamp,
			};
		case "branchSummary":
			return {
				role: "branchSummary",
				summary: message.summary,
				fromId: message.fromId,
				timestamp: message.timestamp,
			};
		case "compactionSummary":
			return {
				role: "compactionSummary",
				summary: message.summary,
				tokensBefore: message.tokensBefore,
				timestamp: message.timestamp,
			};
		default:
			return assertNever(message);
	}
}

function toWireEntry(entry: Entry): LaneEntry {
	const base = { id: entry.id, parentId: entry.parentId, seq: entry.seq, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return {
				...base,
				type: "message",
				message: toWireMessage(entry.message),
				...(entry.terminate === undefined ? {} : { terminate: entry.terminate }),
			};
		case "compaction":
			return {
				...base,
				type: "compaction",
				summary: entry.summary,
				retainedTail: entry.retainedTail.map(toWireMessage),
				tokensBefore: entry.tokensBefore,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: toWireUsage(entry.usage) }),
				fromHook: entry.fromHook,
			};
		case "branch_summary":
			return {
				...base,
				type: "branch_summary",
				fromId: entry.fromId,
				summary: entry.summary,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: toWireUsage(entry.usage) }),
				fromHook: entry.fromHook,
			};
		case "custom":
			return {
				...base,
				type: "custom",
				customType: entry.customType,
				...(entry.data === undefined ? {} : { data: entry.data }),
			};
		default:
			return assertNever(entry);
	}
}

function toWireToolOutput(result: AgentToolResult<unknown>): ToolOutput {
	return {
		content: result.content.map((content) =>
			content.type === "text"
				? {
						type: "text" as const,
						text: content.text,
						...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }),
					}
				: { type: "image" as const, data: content.data, mimeType: content.mimeType },
		),
		...(result.details === undefined ? {} : { details: toWireJsonValue(result.details) }),
		...(result.usage === undefined ? {} : { usage: toWireUsage(result.usage) }),
	};
}

function toWireFrame(frame: AiAssistantMessageFrame): AssistantMessageFrame {
	switch (frame.type) {
		case "start":
			return { type: "start", partial: toWireAssistantMessage(frame.partial) };
		case "text_start":
			return { type: "text_start", contentIndex: frame.contentIndex, content: { ...frame.content } };
		case "text_delta":
		case "thinking_delta":
		case "toolcall_checkpoint":
		case "toolcall_delta":
			return { ...frame };
		case "text_end":
			return { ...frame };
		case "thinking_start":
			return { type: "thinking_start", contentIndex: frame.contentIndex, content: { ...frame.content } };
		case "thinking_end":
			return { ...frame };
		case "toolcall_start":
			return {
				type: "toolcall_start",
				contentIndex: frame.contentIndex,
				toolCall: {
					...frame.toolCall,
					arguments: Object.fromEntries(
						Object.entries(frame.toolCall.arguments).map(([key, value]) => [key, toWireJsonValue(value)]),
					),
				},
			};
		case "toolcall_end":
			return {
				...frame,
				arguments: Object.fromEntries(
					Object.entries(frame.arguments).map(([key, value]) => [key, toWireJsonValue(value)]),
				),
			};
		default:
			return assertNever(frame);
	}
}

function toWireQueuedItem(item: HarnessLaneSnapshot["queues"][number]): LaneSnapshot["queues"][number] {
	return item.type === "message"
		? { entryId: item.entryId, kind: item.kind, type: "message", message: toWireMessage(item.message) }
		: {
				entryId: item.entryId,
				kind: "write",
				type: "custom",
				customType: item.customType,
				...(item.data === undefined ? {} : { data: item.data }),
			};
}

export function toWireLaneSnapshot(snapshot: HarnessLaneSnapshot): LaneSnapshot {
	return {
		lane: snapshot.lane,
		transcript: snapshot.transcript.map(toWireEntry),
		tipId: snapshot.tipId,
		...(snapshot.lastResult === undefined ? {} : { lastResult: toWireOperationResult(snapshot.lastResult) }),
		configuration: {
			model: { ...snapshot.configuration.model },
			thinkingLevel: snapshot.configuration.thinkingLevel,
			activeToolNames: [...snapshot.configuration.activeToolNames],
		},
		stats: { messageCount: snapshot.stats.messageCount, usage: toWireUsage(snapshot.stats.usage) },
		operation:
			snapshot.operation === null
				? null
				: {
						id: snapshot.operation.id,
						kind: snapshot.operation.kind,
						status: snapshot.operation.status,
						startedAt: snapshot.operation.startedAt,
						fromTipId: snapshot.operation.fromTipId,
						...(snapshot.operation.deferred === undefined
							? {}
							: {
									deferred: {
										handle: toWireDeferred(snapshot.operation.deferred.handle),
										poll: snapshot.operation.deferred.poll,
									},
								}),
						...(snapshot.operation.streamingMessage === undefined
							? {}
							: { streamingMessage: toWireAssistantMessage(snapshot.operation.streamingMessage) }),
						runningTools: snapshot.operation.runningTools.map((tool) => ({
							toolCallId: tool.toolCallId,
							toolName: tool.toolName,
							args: toWireJsonValue(tool.args),
							...(tool.partialResult === undefined
								? {}
								: { partialResult: toWireToolOutput(tool.partialResult) }),
						})),
						...(snapshot.operation.retry === undefined ? {} : { retry: { ...snapshot.operation.retry } }),
					},
		queues: snapshot.queues.map(toWireQueuedItem),
		faulted: snapshot.faulted,
	};
}

function toWireOperationError(error: Extract<HarnessEvent, { type: "run_end" }>["error"]) {
	if (error === undefined) return undefined;
	return {
		code: error.code,
		message: error.message,
		...(error.details === undefined ? {} : { details: toWireJsonValue(error.details) }),
	};
}

export function toWireLaneEvent(event: HarnessEvent): LaneEvent | undefined {
	const lane = "lane" in event && typeof event.lane === "string" ? event.lane : undefined;
	const base = lane === undefined ? {} : { lane, ...(event.recovery === true ? { recovery: true as const } : {}) };
	switch (event.type) {
		case "run_start":
			return { type: "run_start", runId: event.runId, startedAt: event.startedAt, ...base, lane: event.lane };
		case "run_resume":
			return { type: "run_resume", runId: event.runId, ...base, lane: event.lane };
		case "run_suspend":
			return {
				type: "run_suspend",
				runId: event.runId,
				reason: "deferred",
				deferred: toWireDeferred(event.deferred),
				poll: event.poll,
				...base,
				lane: event.lane,
			};
		case "operation_abort":
			return {
				type: "operation_abort",
				operationId: event.operationId,
				steer: event.steer.map(toWireMessage),
				followUp: event.followUp.map(toWireMessage),
				...base,
				lane: event.lane,
			};
		case "run_end":
			return event.status === "failed"
				? { ...event, error: toWireOperationError(event.error)!, ...base, lane: event.lane }
				: { ...event, ...base, lane: event.lane };
		case "message_start":
		case "message_end":
			return { ...event, message: toWireMessage(event.message), ...base, lane: event.lane };
		case "message_update":
			if (event.message.role !== "assistant") {
				throw new TypeError("Harness message_update did not carry an assistant message");
			}
			return {
				type: "message_update",
				runId: event.runId,
				message: toWireAssistantMessage(event.message),
				...(event.frame === undefined ? {} : { frame: toWireFrame(event.frame) }),
				...base,
				lane: event.lane,
			};
		case "tool_start":
			return {
				...event,
				args: toWireJsonValue(event.args),
				...base,
				lane: event.lane,
			};
		case "tool_update":
			return { ...event, partialResult: toWireToolOutput(event.partialResult), ...base, lane: event.lane };
		case "tool_end":
			return { ...event, result: toWireToolOutput(event.result), ...base, lane: event.lane };
		case "entry_added":
			return { type: "entry_added", entry: toWireEntry(event.entry), ...base, lane: event.lane };
		case "queue_update":
			return { type: "queue_update", queues: event.queues.map(toWireQueuedItem), ...base, lane: event.lane };
		case "retry_scheduled":
		case "retry_start":
		case "retry_end":
		case "compaction_start":
		case "navigation_start":
			return { ...event, ...base, lane: event.lane };
		case "compaction_end":
		case "navigation_end":
			return event.status === "failed"
				? { ...event, error: toWireOperationError(event.error)!, ...base, lane: event.lane }
				: { ...event, ...base, lane: event.lane };
		case "usage":
			return {
				type: "usage",
				lane: event.lane,
				row: {
					...event.row,
					usage: toWireUsage(event.row.usage),
					...(event.row.details === undefined ? {} : { details: toWireJsonValue(event.row.details) }),
				},
				totals: toWireUsage(event.totals),
			};
		case "config_update":
			switch (event.property) {
				case "tools":
				case "resources":
					return { type: "config_update", property: event.property };
				case "model":
				case "thinkingLevel":
				case "activeTools":
					return {
						type: "config_update",
						property: event.property,
						value: toWireJsonValue(event.value),
						previous: toWireJsonValue(event.previous),
						...base,
						lane: event.lane,
					};
				case "streamOptions":
				case "retryPolicy":
				case "compactionSettings":
				case "steeringMode":
				case "followUpMode":
					return {
						type: "config_update",
						property: event.property,
						value: toWireJsonValue(event.value),
						previous: toWireJsonValue(event.previous),
					};
				default:
					return assertNever(event);
			}
		case "fault":
			return { type: "fault", code: event.code, message: event.message };
		case "handler_error":
		case "turn_start":
		case "turn_end":
		case "value_update":
		case "lane_created":
			return undefined;
		default:
			return assertNever(event);
	}
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported Harness value: ${String(value)}`);
}

import Type, { type Static } from "typebox";
import { JsonValueSchema } from "./json-value.ts";

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const PromptImageSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
export type PromptImage = Static<typeof PromptImageSchema>;

export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
	textSignature: Type.Optional(Type.String()),
});
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	thinkingSignature: Type.Optional(Type.String()),
	redacted: Type.Optional(Type.Boolean()),
});
export const ToolCallSchema = StrictObject({
	type: Type.Literal("toolCall"),
	id: Type.String(),
	name: Type.String(),
	arguments: Type.Record(Type.String(), JsonValueSchema),
	thoughtSignature: Type.Optional(Type.String()),
	namespace: Type.Optional(Type.String()),
});
export const UsageSchema = StrictObject({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	cacheWrite1h: Type.Optional(Type.Number()),
	reasoning: Type.Optional(Type.Number()),
	totalTokens: Type.Number(),
	cost: StrictObject({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
const DeferredHandleSchema = StrictObject({
	provider: Type.String(),
	modelId: Type.String(),
	api: Type.String(),
	id: Type.String(),
	expiresAt: Type.Optional(Type.Number()),
	pollAfterMs: Type.Optional(Type.Number()),
	data: Type.Optional(JsonValueSchema),
});
const DiagnosticErrorSchema = StrictObject({
	name: Type.Optional(Type.String()),
	message: Type.String(),
	stack: Type.Optional(Type.String()),
	code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
});
const AssistantMessageDiagnosticSchema = StrictObject({
	type: Type.String(),
	timestamp: TimestampSchema,
	error: Type.Optional(DiagnosticErrorSchema),
	details: Type.Optional(Type.Record(Type.String(), JsonValueSchema)),
});
export const AssistantMessageSchema = StrictObject({
	role: Type.Literal("assistant"),
	content: Type.Array(Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
	api: Type.String(),
	provider: Type.String(),
	model: Type.String(),
	responseModel: Type.Optional(Type.String()),
	responseId: Type.Optional(Type.String()),
	diagnostics: Type.Optional(Type.Array(AssistantMessageDiagnosticSchema)),
	usage: UsageSchema,
	stopReason: Type.Union([
		Type.Literal("pending"),
		Type.Literal("stop"),
		Type.Literal("length"),
		Type.Literal("toolUse"),
		Type.Literal("error"),
		Type.Literal("aborted"),
		Type.Literal("deferred"),
	]),
	deferred: Type.Optional(DeferredHandleSchema),
	errorMessage: Type.Optional(Type.String()),
	rawStopReason: Type.Optional(Type.String()),
	endTurn: Type.Optional(Type.Boolean()),
	timestamp: TimestampSchema,
});
const UserMessageSchema = StrictObject({
	role: Type.Literal("user"),
	content: Type.Union([Type.String(), Type.Array(Type.Union([TextContentSchema, PromptImageSchema]))]),
	timestamp: TimestampSchema,
});
const ToolResultMessageSchema = StrictObject({
	role: Type.Literal("toolResult"),
	toolCallId: Type.String(),
	toolName: Type.String(),
	content: Type.Array(Type.Union([TextContentSchema, PromptImageSchema])),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	addedToolNames: Type.Optional(Type.Array(Type.String())),
	isError: Type.Boolean(),
	timestamp: TimestampSchema,
});
const BashExecutionMessageSchema = StrictObject({
	role: Type.Literal("bashExecution"),
	command: Type.String(),
	output: Type.String(),
	exitCode: Type.Optional(Type.Number()),
	cancelled: Type.Boolean(),
	truncated: Type.Boolean(),
	fullOutputPath: Type.Optional(Type.String()),
	timestamp: TimestampSchema,
	excludeFromContext: Type.Optional(Type.Boolean()),
});
const CustomMessageSchema = StrictObject({
	role: Type.Literal("custom"),
	customType: Type.String(),
	content: Type.Union([Type.String(), Type.Array(Type.Union([TextContentSchema, PromptImageSchema]))]),
	display: Type.Boolean(),
	details: Type.Optional(JsonValueSchema),
	timestamp: TimestampSchema,
});
const BranchSummaryMessageSchema = StrictObject({
	role: Type.Literal("branchSummary"),
	summary: Type.String(),
	fromId: Type.String(),
	timestamp: TimestampSchema,
});
const CompactionSummaryMessageSchema = StrictObject({
	role: Type.Literal("compactionSummary"),
	summary: Type.String(),
	tokensBefore: Type.Number(),
	timestamp: TimestampSchema,
});

/** Closed set of built-in AgentMessage shapes supported by the wire protocol. */
export const PromptMessageSchema = Type.Union([
	UserMessageSchema,
	AssistantMessageSchema,
	ToolResultMessageSchema,
	BashExecutionMessageSchema,
	CustomMessageSchema,
	BranchSummaryMessageSchema,
	CompactionSummaryMessageSchema,
]);
export type PromptMessage = Static<typeof PromptMessageSchema>;

/** Serializable AgentLane.prompt() arguments, kept as one value across RPC boundaries. */
export const PromptArgumentsSchema = Type.Union([
	Type.Tuple([Type.String()]),
	Type.Tuple([Type.String(), Type.Array(PromptImageSchema)]),
	Type.Tuple([PromptMessageSchema]),
	Type.Tuple([Type.Array(PromptMessageSchema)]),
]);
export type PromptArguments = Static<typeof PromptArgumentsSchema>;

const OperationErrorSchema = StrictObject({
	code: Type.String(),
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
const ActionInfoSchema = StrictObject({
	kind: Type.String(),
	description: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
const RunValueSchema = Type.Union([
	StrictObject({ kind: Type.Literal("completed"), runId: IdSchema, leafId: IdSchema }),
	StrictObject({
		kind: Type.Literal("completed"),
		runId: IdSchema,
		leafId: IdSchema,
		finalEntryId: IdSchema,
		finalMessage: AssistantMessageSchema,
	}),
	StrictObject({ kind: Type.Literal("aborted"), runId: IdSchema, leafId: IdSchema }),
	StrictObject({
		kind: Type.Literal("aborted"),
		runId: IdSchema,
		leafId: IdSchema,
		finalEntryId: IdSchema,
		finalMessage: AssistantMessageSchema,
	}),
	StrictObject({
		kind: Type.Literal("failed"),
		runId: IdSchema,
		leafId: IdSchema,
		error: OperationErrorSchema,
	}),
	StrictObject({
		kind: Type.Literal("failed"),
		runId: IdSchema,
		leafId: IdSchema,
		error: OperationErrorSchema,
		finalEntryId: IdSchema,
		finalMessage: AssistantMessageSchema,
	}),
	StrictObject({
		kind: Type.Literal("suspended"),
		reason: Type.Literal("deferred"),
		runId: IdSchema,
		leafId: IdSchema,
		finalEntryId: IdSchema,
		deferred: DeferredHandleSchema,
	}),
	StrictObject({
		kind: Type.Literal("action_required"),
		runId: IdSchema,
		action: ActionInfoSchema,
	}),
]);
const RunErrorSchema = Type.Union([
	StrictObject({
		_tag: Type.Literal("LaneBusy"),
		lane: Type.String(),
		operationId: IdSchema,
		operationKind: Type.Union([Type.Literal("run"), Type.Literal("compaction"), Type.Literal("navigation")]),
		message: Type.String(),
	}),
	StrictObject({
		_tag: Type.Literal("InvalidMessage"),
		lane: Type.String(),
		reason: Type.String(),
		message: Type.String(),
	}),
	StrictObject({ _tag: Type.Literal("UnknownSkill"), name: Type.String(), message: Type.String() }),
	StrictObject({ _tag: Type.Literal("UnknownTemplate"), name: Type.String(), message: Type.String() }),
	StrictObject({ _tag: Type.Literal("Closed"), message: Type.String() }),
]);

/** Wire-safe structural equivalent of AgentLane.prompt()'s RunResult. */
export const RunResultSchema = Type.Union([
	StrictObject({ ok: Type.Literal(true), value: RunValueSchema }),
	StrictObject({ ok: Type.Literal(false), error: RunErrorSchema }),
]);
export type RunResult = Static<typeof RunResultSchema>;

export const ToolOutputSchema = StrictObject({
	content: Type.Array(Type.Union([TextContentSchema, PromptImageSchema])),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
});
export type ToolOutput = Static<typeof ToolOutputSchema>;

export const AssistantMessageFrameSchema = Type.Union([
	StrictObject({ type: Type.Literal("start"), partial: AssistantMessageSchema }),
	StrictObject({
		type: Type.Literal("text_start"),
		contentIndex: Type.Integer({ minimum: 0 }),
		content: TextContentSchema,
	}),
	StrictObject({ type: Type.Literal("text_delta"), contentIndex: Type.Integer({ minimum: 0 }), delta: Type.String() }),
	StrictObject({
		type: Type.Literal("text_end"),
		contentIndex: Type.Integer({ minimum: 0 }),
		content: Type.String(),
		textSignature: Type.Optional(Type.String()),
	}),
	StrictObject({
		type: Type.Literal("thinking_start"),
		contentIndex: Type.Integer({ minimum: 0 }),
		content: ThinkingContentSchema,
	}),
	StrictObject({
		type: Type.Literal("thinking_delta"),
		contentIndex: Type.Integer({ minimum: 0 }),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("thinking_end"),
		contentIndex: Type.Integer({ minimum: 0 }),
		content: Type.String(),
		thinkingSignature: Type.Optional(Type.String()),
		redacted: Type.Optional(Type.Boolean()),
	}),
	StrictObject({
		type: Type.Literal("toolcall_start"),
		contentIndex: Type.Integer({ minimum: 0 }),
		toolCall: ToolCallSchema,
	}),
	StrictObject({
		type: Type.Literal("toolcall_delta"),
		contentIndex: Type.Integer({ minimum: 0 }),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("toolcall_end"),
		contentIndex: Type.Integer({ minimum: 0 }),
		id: Type.String(),
		name: Type.String(),
		arguments: Type.Record(Type.String(), JsonValueSchema),
		thoughtSignature: Type.Optional(Type.String()),
		namespace: Type.Optional(Type.String()),
	}),
]);
export type AssistantMessageFrame = Static<typeof AssistantMessageFrameSchema>;

const MessageEntrySchema = StrictObject({
	id: IdSchema,
	parentId: Type.Union([IdSchema, Type.Null()]),
	seq: Type.Integer({ minimum: 1 }),
	timestamp: TimestampSchema,
	type: Type.Literal("message"),
	message: PromptMessageSchema,
	terminate: Type.Optional(Type.Literal(true)),
});
const CompactionEntrySchema = StrictObject({
	id: IdSchema,
	parentId: Type.Union([IdSchema, Type.Null()]),
	seq: Type.Integer({ minimum: 1 }),
	timestamp: TimestampSchema,
	type: Type.Literal("compaction"),
	summary: Type.String(),
	retainedTail: Type.Array(PromptMessageSchema),
	tokensBefore: Type.Number(),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	fromHook: Type.Boolean(),
});
const BranchSummaryEntrySchema = StrictObject({
	id: IdSchema,
	parentId: Type.Union([IdSchema, Type.Null()]),
	seq: Type.Integer({ minimum: 1 }),
	timestamp: TimestampSchema,
	type: Type.Literal("branch_summary"),
	fromId: IdSchema,
	summary: Type.String(),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	fromHook: Type.Boolean(),
});
const CustomEntrySchema = StrictObject({
	id: IdSchema,
	parentId: Type.Union([IdSchema, Type.Null()]),
	seq: Type.Integer({ minimum: 1 }),
	timestamp: TimestampSchema,
	type: Type.Literal("custom"),
	customType: Type.String({ minLength: 1 }),
	data: Type.Optional(JsonValueSchema),
});
export const LaneEntrySchema = Type.Union([
	MessageEntrySchema,
	CompactionEntrySchema,
	BranchSummaryEntrySchema,
	CustomEntrySchema,
]);
export type LaneEntry = Static<typeof LaneEntrySchema>;

const QueuedItemSchema = StrictObject({ entryId: IdSchema, message: PromptMessageSchema });
const RunningToolSchema = StrictObject({
	toolCallId: Type.String(),
	toolName: Type.String(),
	args: JsonValueSchema,
	partialResult: Type.Optional(ToolOutputSchema),
});
const LaneOperationSchema = StrictObject({
	id: IdSchema,
	kind: Type.Union([Type.Literal("run"), Type.Literal("compaction"), Type.Literal("navigation")]),
	status: Type.Union([Type.Literal("running"), Type.Literal("open"), Type.Literal("aborting")]),
	startedAt: TimestampSchema,
	action: Type.Optional(ActionInfoSchema),
	deferred: Type.Optional(StrictObject({ handle: DeferredHandleSchema, poll: Type.Integer({ minimum: 0 }) })),
	drained: Type.Optional(
		StrictObject({ steer: Type.Array(QueuedItemSchema), followUp: Type.Array(QueuedItemSchema) }),
	),
	streamingMessage: Type.Optional(AssistantMessageSchema),
	runningTools: Type.Array(RunningToolSchema),
	retry: Type.Optional(
		StrictObject({
			attempt: Type.Integer({ minimum: 1 }),
			maxAttempts: Type.Integer({ minimum: 1 }),
			nextAttemptAt: TimestampSchema,
		}),
	),
});
export const LaneSnapshotSchema = StrictObject({
	lane: Type.String(),
	transcript: Type.Array(LaneEntrySchema),
	leafId: Type.Union([IdSchema, Type.Null()]),
	operation: Type.Union([LaneOperationSchema, Type.Null()]),
	queues: StrictObject({
		steer: Type.Array(QueuedItemSchema),
		followUp: Type.Array(QueuedItemSchema),
		nextRun: Type.Array(QueuedItemSchema),
	}),
	pendingWrites: Type.Array(
		StrictObject({
			entryId: IdSchema,
			type: Type.Union([
				Type.Literal("message"),
				Type.Literal("compaction"),
				Type.Literal("branch_summary"),
				Type.Literal("custom"),
			]),
			customType: Type.Optional(Type.String()),
			message: Type.Optional(PromptMessageSchema),
			data: Type.Optional(JsonValueSchema),
		}),
	),
	faulted: Type.Boolean(),
});
export type LaneSnapshot = Static<typeof LaneSnapshotSchema>;

const LaneEventBase = {
	lane: Type.String(),
	recovery: Type.Optional(Type.Literal(true)),
};
const RunEndBase = {
	type: Type.Literal("run_end"),
	runId: IdSchema,
	leafId: Type.Union([IdSchema, Type.Null()]),
	...LaneEventBase,
};
export const LaneEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("run_start"), runId: IdSchema, ...LaneEventBase }),
	StrictObject({ type: Type.Literal("run_resume"), runId: IdSchema, ...LaneEventBase }),
	StrictObject({
		type: Type.Literal("run_suspend"),
		runId: IdSchema,
		reason: Type.Literal("deferred"),
		deferred: DeferredHandleSchema,
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("run_abort"),
		runId: IdSchema,
		steer: Type.Array(PromptMessageSchema),
		followUp: Type.Array(PromptMessageSchema),
		...LaneEventBase,
	}),
	StrictObject({
		...RunEndBase,
		outcome: Type.Union([Type.Literal("completed"), Type.Literal("aborted")]),
	}),
	StrictObject({
		...RunEndBase,
		outcome: Type.Union([Type.Literal("completed"), Type.Literal("aborted")]),
		finalEntryId: IdSchema,
		finalMessage: AssistantMessageSchema,
	}),
	StrictObject({ ...RunEndBase, outcome: Type.Literal("failed"), error: OperationErrorSchema }),
	StrictObject({
		...RunEndBase,
		outcome: Type.Literal("failed"),
		error: OperationErrorSchema,
		finalEntryId: IdSchema,
		finalMessage: AssistantMessageSchema,
	}),
	StrictObject({
		type: Type.Literal("message_start"),
		runId: Type.Optional(IdSchema),
		message: PromptMessageSchema,
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("message_update"),
		runId: IdSchema,
		frame: AssistantMessageFrameSchema,
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("message_end"),
		runId: Type.Optional(IdSchema),
		message: PromptMessageSchema,
		entryId: Type.Optional(IdSchema),
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("tool_start"),
		runId: IdSchema,
		turnId: IdSchema,
		toolCallId: Type.String(),
		toolName: Type.String(),
		args: JsonValueSchema,
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("tool_update"),
		runId: IdSchema,
		turnId: IdSchema,
		toolCallId: Type.String(),
		toolName: Type.String(),
		partialResult: ToolOutputSchema,
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("tool_end"),
		runId: IdSchema,
		turnId: IdSchema,
		toolCallId: Type.String(),
		toolName: Type.String(),
		result: ToolOutputSchema,
		isError: Type.Boolean(),
		terminate: Type.Boolean(),
		...LaneEventBase,
	}),
	StrictObject({ type: Type.Literal("entry_added"), entry: LaneEntrySchema, ...LaneEventBase }),
	StrictObject({
		type: Type.Literal("queue_update"),
		steer: Type.Array(QueuedItemSchema),
		followUp: Type.Array(QueuedItemSchema),
		nextRun: Type.Array(QueuedItemSchema),
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("retry_scheduled"),
		runId: IdSchema,
		step: IdSchema,
		attempt: Type.Integer({ minimum: 1 }),
		maxAttempts: Type.Integer({ minimum: 1 }),
		delayMs: Type.Integer({ minimum: 0 }),
		errorMessage: Type.String(),
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("retry_start"),
		runId: IdSchema,
		step: IdSchema,
		attempt: Type.Integer({ minimum: 1 }),
		...LaneEventBase,
	}),
	StrictObject({
		type: Type.Literal("retry_end"),
		runId: IdSchema,
		step: IdSchema,
		attempt: Type.Integer({ minimum: 1 }),
		success: Type.Boolean(),
		finalError: Type.Optional(Type.String()),
		...LaneEventBase,
	}),
	StrictObject({ type: Type.Literal("fault"), code: Type.String(), message: Type.String() }),
]);
export type LaneEvent = Static<typeof LaneEventSchema>;

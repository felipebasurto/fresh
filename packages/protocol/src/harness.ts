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

const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
	textSignature: Type.Optional(Type.String()),
});
const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	thinkingSignature: Type.Optional(Type.String()),
	redacted: Type.Optional(Type.Boolean()),
});
const ToolCallSchema = StrictObject({
	type: Type.Literal("toolCall"),
	id: Type.String(),
	name: Type.String(),
	arguments: Type.Record(Type.String(), JsonValueSchema),
	thoughtSignature: Type.Optional(Type.String()),
	namespace: Type.Optional(Type.String()),
});
const UsageSchema = StrictObject({
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
const AssistantMessageSchema = StrictObject({
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
const MissingIdentityListSchema = StrictObject({
	tools: Type.Array(Type.String()),
	models: Type.Array(Type.String()),
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
		kind: Type.Literal("suspended"),
		reason: Type.Literal("missing_identities"),
		runId: IdSchema,
		leafId: IdSchema,
		missing: MissingIdentityListSchema,
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
		_tag: Type.Literal("MissingIdentities"),
		lane: Type.String(),
		tools: Type.Array(Type.String()),
		models: Type.Array(Type.String()),
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

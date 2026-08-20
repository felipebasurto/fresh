import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { LaneEventSchema, LaneSnapshotSchema, PromptArgumentsSchema, RunResultSchema } from "./harness.ts";
import { type JsonValue, JsonValueSchema } from "./json-value.ts";
import {
	createRpcCallSchema,
	createRpcResultSchema,
	defineRpc,
	type RpcArgs,
	type RpcCall,
	type RpcMethodName,
	type RpcResult,
	type RpcResultUnion,
} from "./rpc.ts";

export const PROTOCOL_VERSION = 3 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const ServerIdSchema = Type.String({
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const SessionIdSchema = IdSchema;
export type ServerId = Static<typeof ServerIdSchema>;
export type SessionId = Static<typeof SessionIdSchema>;

export function isServerId(value: unknown): value is ServerId {
	return Check(ServerIdSchema, value);
}

/** Presentation-safe Session directory record. */
export const SessionSummarySchema = StrictObject({
	serverId: ServerIdSchema,
	sessionId: SessionIdSchema,
	createdAt: TimestampSchema,
});
export type SessionSummary = Static<typeof SessionSummarySchema>;

export const SessionCreateOptionsSchema = StrictObject({
	id: Type.Optional(SessionIdSchema),
});
export type SessionCreateOptions = Static<typeof SessionCreateOptionsSchema>;

/** Temporary typed facade for the pre-plugin Session operations. */
export const ServiceRpc = defineRpc({
	list: {
		args: Type.Tuple([]),
		result: Type.Array(SessionSummarySchema),
	},
	create: {
		args: Type.Tuple([SessionCreateOptionsSchema]),
		result: SessionSummarySchema,
	},
	attach: {
		args: Type.Tuple([SessionIdSchema]),
		result: StrictObject({ sessionId: SessionIdSchema, attachmentId: IdSchema }),
	},
	prompt: {
		args: Type.Tuple([PromptArgumentsSchema]),
		result: RunResultSchema,
	},
	watch: {
		args: Type.Tuple([]),
		result: StrictObject({ watchId: IdSchema, snapshot: LaneSnapshotSchema }),
	},
	startWatch: {
		args: Type.Tuple([IdSchema]),
		result: StrictObject({ watchId: IdSchema }),
	},
	stopWatch: {
		args: Type.Tuple([IdSchema]),
		result: StrictObject({ watchId: IdSchema }),
	},
});
export type ServiceRpcManifest = typeof ServiceRpc;
export type ServiceRpcMethod = RpcMethodName<ServiceRpcManifest>;
export type ServiceRpcArgs<TMethod extends ServiceRpcMethod> = RpcArgs<ServiceRpcManifest, TMethod>;
export type ServiceRpcResult<TMethod extends ServiceRpcMethod> = RpcResult<ServiceRpcManifest, TMethod>;
export type ServiceRpcCall = RpcCall<ServiceRpcManifest>;
export type ServiceRpcResultUnion = RpcResultUnion<ServiceRpcManifest>;
export const ServiceRpcCallSchema = Type.Unsafe<ServiceRpcCall>(createRpcCallSchema(ServiceRpc));
export const ServiceRpcResultSchema = Type.Unsafe<ServiceRpcResultUnion>(createRpcResultSchema(ServiceRpc));

export const ServiceModeSchema = Type.Union([Type.Literal("singleton"), Type.Literal("keyed")]);
export type ServiceMode = Static<typeof ServiceModeSchema>;

export const ServiceInstanceAddressSchema = StrictObject({
	key: IdSchema,
	generation: Type.Integer({ minimum: 1 }),
});
export type ServiceInstanceAddress = Static<typeof ServiceInstanceAddressSchema>;

/** Contract-agnostic service/member invocation carried by the transport. */
export const ProtocolRpcCallSchema = StrictObject({
	serviceId: Type.String({ minLength: 1 }),
	instance: Type.Optional(ServiceInstanceAddressSchema),
	member: Type.String({ minLength: 1 }),
	args: Type.Array(JsonValueSchema),
});
export type ProtocolRpcCall = Static<typeof ProtocolRpcCallSchema>;
export type ProtocolRpcResult = JsonValue | undefined;

export const ServiceMemberDescriptionSchema = StrictObject({
	name: IdSchema,
	kind: Type.Union([Type.Literal("method"), Type.Literal("state"), Type.Literal("events")]),
});
export type ServiceMemberDescription = Static<typeof ServiceMemberDescriptionSchema>;

export const ServiceStateSnapshotSchema = StrictObject({
	sequence: Type.Integer({ minimum: 0 }),
	value: JsonValueSchema,
});
export type ServiceStateSnapshot = Static<typeof ServiceStateSnapshotSchema>;

export const ServiceInstanceSnapshotSchema = StrictObject({
	instance: Type.Optional(ServiceInstanceAddressSchema),
	members: Type.Array(ServiceMemberDescriptionSchema),
	states: Type.Record(Type.String(), ServiceStateSnapshotSchema),
});
export type ServiceInstanceSnapshot = Static<typeof ServiceInstanceSnapshotSchema>;

export const ServiceSubscriptionSnapshotSchema = StrictObject({
	serviceId: Type.String({ minLength: 1 }),
	mode: ServiceModeSchema,
	instances: Type.Array(ServiceInstanceSnapshotSchema),
});
export type ServiceSubscriptionSnapshot = Static<typeof ServiceSubscriptionSnapshotSchema>;

export function parseServiceSubscriptionSnapshot(value: unknown): ServiceSubscriptionSnapshot {
	if (!Check(ServiceSubscriptionSnapshotSchema, value)) {
		throw new TypeError("Invalid service subscription snapshot");
	}
	return value;
}

export const ServiceProviderUpdateSchema = Type.Union([
	StrictObject({
		type: Type.Literal("state"),
		instance: Type.Optional(ServiceInstanceAddressSchema),
		member: IdSchema,
		sequence: Type.Integer({ minimum: 1 }),
		value: JsonValueSchema,
	}),
	StrictObject({
		type: Type.Literal("spawned"),
		instance: ServiceInstanceSnapshotSchema,
	}),
	StrictObject({
		type: Type.Literal("closed"),
		instance: ServiceInstanceAddressSchema,
	}),
]);
export type ServiceProviderUpdate = Static<typeof ServiceProviderUpdateSchema>;

export const SERVICE_CONTROL_ID = "$pi.service";
export const SERVICE_SUBSCRIBE_MEMBER = "subscribe";
export const SERVICE_UNSUBSCRIBE_MEMBER = "unsubscribe";

export type ServiceControlCall =
	| {
			readonly type: "subscribe";
			readonly subscriptionId: string;
			readonly serviceId: string;
			readonly mode: ServiceMode;
	  }
	| { readonly type: "unsubscribe"; readonly subscriptionId: string };

export function createServiceSubscribeCall(
	subscriptionId: string,
	serviceId: string,
	mode: ServiceMode,
): ProtocolRpcCall {
	return { serviceId: SERVICE_CONTROL_ID, member: SERVICE_SUBSCRIBE_MEMBER, args: [subscriptionId, serviceId, mode] };
}

export function createServiceUnsubscribeCall(subscriptionId: string): ProtocolRpcCall {
	return { serviceId: SERVICE_CONTROL_ID, member: SERVICE_UNSUBSCRIBE_MEMBER, args: [subscriptionId] };
}

export function decodeServiceControlCall(call: ProtocolRpcCall): ServiceControlCall | undefined {
	if (call.serviceId !== SERVICE_CONTROL_ID || call.instance !== undefined) return undefined;
	if (
		call.member === SERVICE_SUBSCRIBE_MEMBER &&
		call.args.length === 3 &&
		typeof call.args[0] === "string" &&
		typeof call.args[1] === "string" &&
		(call.args[2] === "singleton" || call.args[2] === "keyed")
	) {
		return {
			type: "subscribe",
			subscriptionId: call.args[0],
			serviceId: call.args[1],
			mode: call.args[2],
		};
	}
	if (call.member === SERVICE_UNSUBSCRIBE_MEMBER && call.args.length === 1 && typeof call.args[0] === "string") {
		return { type: "unsubscribe", subscriptionId: call.args[0] };
	}
	return undefined;
}

const ServiceRpcAddresses = {
	list: { serviceId: "session-directory", member: "list" },
	create: { serviceId: "session-management", member: "create" },
	attach: { serviceId: "session-management", member: "attach" },
	prompt: { serviceId: "chat", member: "prompt" },
	watch: { serviceId: "transcript", member: "watch" },
	startWatch: { serviceId: "transcript", member: "startWatch" },
	stopWatch: { serviceId: "transcript", member: "stopWatch" },
} as const satisfies Record<ServiceRpcMethod, { serviceId: string; member: string }>;

/** Translate the current built-in contract to its generic service envelope. */
export function encodeServiceRpcCall(call: ServiceRpcCall): ProtocolRpcCall {
	return { ...ServiceRpcAddresses[call.method], args: call.args };
}

/** Validate and decode one generic envelope against the current built-in contract. */
export function decodeServiceRpcCall(call: ProtocolRpcCall): ServiceRpcCall | undefined {
	if (call.instance !== undefined) return undefined;
	for (const [method, address] of Object.entries(ServiceRpcAddresses)) {
		if (call.serviceId !== address.serviceId || call.member !== address.member) continue;
		const candidate = { method, args: call.args };
		return Check(ServiceRpcCallSchema, candidate) ? (candidate as ServiceRpcCall) : undefined;
	}
	return undefined;
}

export const ServiceErrorCodeSchema = Type.Union([
	Type.Literal("service_not_allowed"),
	Type.Literal("service_not_found"),
	Type.Literal("service_mode_mismatch"),
	Type.Literal("service_member_not_found"),
	Type.Literal("service_member_mismatch"),
	Type.Literal("service_instance_not_found"),
	Type.Literal("service_stale_instance"),
	Type.Literal("service_invalid_value"),
	Type.Literal("service_not_implemented"),
]);
export type ServiceErrorCode = Static<typeof ServiceErrorCodeSchema>;

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("wrong_server"),
	Type.Literal("session_not_found"),
	Type.Literal("session_ambiguous"),
	Type.Literal("session_not_attached"),
	Type.Literal("watch_not_found"),
	Type.Literal("watch_in_use"),
	Type.Literal("not_supported"),
	Type.Literal("server_draining"),
	ServiceErrorCodeSchema,
	Type.Literal("invalid_request"),
	Type.Literal("cancelled"),
	Type.Literal("internal_error"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/** Must be the first frame sent by a client. */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

/** A server-wide call, fenced to one logical server. */
export const ServerTargetSchema = StrictObject({
	serverId: ServerIdSchema,
});
export type ServerTarget = Static<typeof ServerTargetSchema>;

/** Durable Session identity, unique within the addressed logical server. */
export const SessionAddressSchema = StrictObject({
	serverId: ServerIdSchema,
	sessionId: SessionIdSchema,
});
export type SessionAddress = Static<typeof SessionAddressSchema>;

/** A session call, fenced to one logical server, durable session, and live attachment. */
export const SessionTargetSchema = StrictObject({
	serverId: ServerIdSchema,
	sessionId: SessionIdSchema,
	attachmentId: IdSchema,
});
export type SessionTarget = Static<typeof SessionTargetSchema>;
export const RpcTargetSchema = Type.Union([ServerTargetSchema, SessionTargetSchema]);
export type RpcTarget = Static<typeof RpcTargetSchema>;

export function isSessionTarget(target: RpcTarget): target is SessionTarget {
	return "sessionId" in target;
}

export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	target: RpcTargetSchema,
	call: ProtocolRpcCallSchema,
});
export const CancelEnvelopeSchema = StrictObject({
	type: Type.Literal("cancel"),
	id: IdSchema,
	target: RpcTargetSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export type CancelEnvelope = Static<typeof CancelEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, CancelEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	serverId: ServerIdSchema,
});
export const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
export const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: Type.Optional(JsonValueSchema),
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
export const EventEnvelopeSchema = StrictObject({
	type: Type.Literal("event"),
	watchId: IdSchema,
	event: LaneEventSchema,
});
export const ServiceEventEnvelopeSchema = StrictObject({
	type: Type.Literal("service_event"),
	subscriptionId: IdSchema,
	update: ServiceProviderUpdateSchema,
});
/** Out-of-band update to this presentation's selected Session route. */
export const AttachmentEnvelopeSchema = StrictObject({
	type: Type.Literal("attachment"),
	attachment: Type.Union([SessionTargetSchema, Type.Null()]),
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	EventEnvelopeSchema,
	ServiceEventEnvelopeSchema,
	AttachmentEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
export type ServiceEventEnvelope = Static<typeof ServiceEventEnvelopeSchema>;
export type AttachmentEnvelope = Static<typeof AttachmentEnvelopeSchema>;
export type ServerEventEnvelope = EventEnvelope | ServiceEventEnvelope;
export type ServerMessage = Static<typeof ServerMessageSchema>;

import { isJsonValue } from "@earendil-works/chord";
import type { WireOp } from "@earendil-works/chord/delta";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { type JsonValue, JsonValueSchema } from "./json-value.ts";

export const PROTOCOL_VERSION = 8 as const;

const IdSchema = Type.String({ minLength: 1 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const ServerIdSchema = Type.String({
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export type ServerId = Static<typeof ServerIdSchema>;

export function isServerId(value: unknown): value is ServerId {
	return Check(ServerIdSchema, value);
}

const ServiceModeSchema = Type.Union([Type.Literal("singleton"), Type.Literal("keyed")]);
export type ServiceMode = Static<typeof ServiceModeSchema>;

const ServiceCatalogueEntrySchema = StrictObject({
	serviceId: IdSchema,
	mode: ServiceModeSchema,
});
const ServiceCatalogueSchema = Type.Array(ServiceCatalogueEntrySchema);
export type ServiceCatalogueEntry = Static<typeof ServiceCatalogueEntrySchema>;

export function parseServiceCatalogue(value: unknown): readonly ServiceCatalogueEntry[] {
	if (!Check(ServiceCatalogueSchema, value)) throw new TypeError("Invalid service catalogue");
	const ids = value.map(({ serviceId }) => serviceId);
	if (new Set(ids).size !== ids.length) throw new TypeError("Service catalogue contains duplicate IDs");
	return value;
}

const ServiceInstanceAddressSchema = StrictObject({
	key: IdSchema,
	generation: Type.Integer({ minimum: 1 }),
});
/** Contract-agnostic service/member invocation carried by the transport. */
export const ProtocolRpcCallSchema = StrictObject({
	serviceId: Type.String({ minLength: 1 }),
	instance: Type.Optional(ServiceInstanceAddressSchema),
	member: Type.String({ minLength: 1 }),
	args: Type.Array(JsonValueSchema),
});
export type ProtocolRpcCall = Static<typeof ProtocolRpcCallSchema>;
export type ProtocolRpcResult = JsonValue | undefined;

const DeltaPathSegmentSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);
const DeltaPathSchema = Type.Array(DeltaPathSegmentSchema);
const DeltaNonEmptyPathSchema = Type.Array(DeltaPathSegmentSchema, { minItems: 1 });
const DeltaPathRefSchema = Type.Union([DeltaPathSchema, Type.Integer({ minimum: 0 })]);
const DeltaNonEmptyPathRefSchema = Type.Union([DeltaNonEmptyPathSchema, Type.Integer({ minimum: 0 })]);
const DeltaOpsSchema = Type.Array(
	Type.Unsafe<WireOp>(
		Type.Union([
			Type.Tuple([Type.Literal("r"), JsonValueSchema]),
			Type.Tuple([Type.Literal("#"), Type.Integer({ minimum: 0 }), DeltaPathSchema]),
			Type.Tuple([Type.Literal("s"), DeltaNonEmptyPathRefSchema, JsonValueSchema]),
			Type.Tuple([Type.Literal("s"), JsonValueSchema]),
			Type.Tuple([Type.Literal("d"), DeltaNonEmptyPathRefSchema]),
			Type.Tuple([Type.Literal("d")]),
			Type.Tuple([Type.Literal("a"), DeltaNonEmptyPathRefSchema, Type.String()]),
			Type.Tuple([Type.Literal("a"), Type.String()]),
			Type.Tuple([Type.Literal("t"), DeltaNonEmptyPathRefSchema, Type.Integer({ minimum: 0 })]),
			Type.Tuple([Type.Literal("t"), Type.Integer({ minimum: 0 })]),
			Type.Tuple([
				Type.Literal("p"),
				DeltaPathRefSchema,
				Type.Integer({ minimum: 0 }),
				Type.Integer({ minimum: 0 }),
				Type.Array(JsonValueSchema),
			]),
			Type.Tuple([
				Type.Literal("p"),
				Type.Integer({ minimum: 0 }),
				Type.Integer({ minimum: 0 }),
				Type.Array(JsonValueSchema),
			]),
		]),
	),
);

const ServiceMemberSnapshotSchema = Type.Union([
	StrictObject({
		name: IdSchema,
		kind: Type.Literal("method"),
	}),
	StrictObject({
		name: IdSchema,
		kind: Type.Literal("state"),
		sequence: Type.Integer({ minimum: 0 }),
		ops: DeltaOpsSchema,
	}),
]);
const ServiceInstanceSnapshotSchema = StrictObject({
	instance: Type.Optional(ServiceInstanceAddressSchema),
	members: Type.Array(ServiceMemberSnapshotSchema),
});
const ServiceSubscriptionSnapshotSchema = StrictObject({
	serviceId: Type.String({ minLength: 1 }),
	mode: ServiceModeSchema,
	instances: Type.Array(ServiceInstanceSnapshotSchema),
});
export type ServiceSubscriptionSnapshot = Static<typeof ServiceSubscriptionSnapshotSchema>;

export function parseServiceSubscriptionSnapshot(value: unknown): ServiceSubscriptionSnapshot {
	if (!Check(ServiceSubscriptionSnapshotSchema, value) || !isJsonValue(value)) {
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
		ops: DeltaOpsSchema,
	}),
	StrictObject({
		type: Type.Literal("unavailable"),
	}),
	StrictObject({
		type: Type.Literal("replaced"),
		snapshot: ServiceInstanceSnapshotSchema,
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

// TODO: check if this should be part of Chord.
const SERVICE_CONTROL_ID = "$chord.service";
const SERVICE_CATALOGUE_MEMBER = "catalogue";
const SERVICE_SUBSCRIBE_MEMBER = "subscribe";
const SERVICE_UNSUBSCRIBE_MEMBER = "unsubscribe";

type ServiceControlCall =
	| { readonly type: "catalogue" }
	| {
			readonly type: "subscribe";
			readonly subscriptionId: string;
			readonly serviceId: string;
			readonly mode: ServiceMode;
	  }
	| { readonly type: "unsubscribe"; readonly subscriptionId: string };

export function createServiceCatalogueCall(): ProtocolRpcCall {
	return { serviceId: SERVICE_CONTROL_ID, member: SERVICE_CATALOGUE_MEMBER, args: [] };
}

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
	if (call.member === SERVICE_CATALOGUE_MEMBER && call.args.length === 0) return { type: "catalogue" };
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

export const ServiceErrorCodeSchema = Type.Union([
	Type.Literal("service_not_allowed"),
	Type.Literal("service_not_found"),
	Type.Literal("service_mode_mismatch"),
	Type.Literal("service_member_not_found"),
	Type.Literal("service_member_mismatch"),
	Type.Literal("service_instance_not_found"),
	Type.Literal("service_stale_instance"),
	Type.Literal("service_invalid_value"),
]);
export type ServiceErrorCode = Static<typeof ServiceErrorCodeSchema>;

const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("wrong_server"),
	Type.Literal("session_not_found"),
	Type.Literal("session_ambiguous"),
	Type.Literal("session_not_attached"),
	Type.Literal("not_supported"),
	Type.Literal("server_draining"),
	ServiceErrorCodeSchema,
	Type.Literal("invalid_request"),
	Type.Literal("cancelled"),
	Type.Literal("internal_error"),
]);
const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/** Must be the first frame sent by a client. */
const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

/** A server-wide call, fenced to one logical server. */
const ServerTargetSchema = StrictObject({
	serverId: ServerIdSchema,
});
/** A session call, fenced to one logical server, durable session, and live attachment. */
const SessionTargetSchema = StrictObject({
	serverId: ServerIdSchema,
	sessionId: IdSchema,
	attachmentId: IdSchema,
});
export type SessionTarget = Static<typeof SessionTargetSchema>;
const RpcTargetSchema = Type.Union([ServerTargetSchema, SessionTargetSchema]);
export type RpcTarget = Static<typeof RpcTargetSchema>;

const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	target: RpcTargetSchema,
	call: ProtocolRpcCallSchema,
});
const CancelEnvelopeSchema = StrictObject({
	type: Type.Literal("cancel"),
	id: IdSchema,
	target: RpcTargetSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export type CancelEnvelope = Static<typeof CancelEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema, CancelEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	serverId: ServerIdSchema,
});
const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
const ResponseEnvelopeSchema = Type.Union([
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
const ServiceEventEnvelopeSchema = StrictObject({
	type: Type.Literal("service_update"),
	subscriptionId: IdSchema,
	update: ServiceProviderUpdateSchema,
});
/** Out-of-band update to this presentation's selected Session route. */
const AttachmentEnvelopeSchema = StrictObject({
	type: Type.Literal("attachment"),
	attachment: Type.Union([SessionTargetSchema, Type.Null()]),
});
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	ServiceEventEnvelopeSchema,
	AttachmentEnvelopeSchema,
]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type ServiceEventEnvelope = Static<typeof ServiceEventEnvelopeSchema>;
export type AttachmentEnvelope = Static<typeof AttachmentEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;

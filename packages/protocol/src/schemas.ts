import type { SessionMetadata as AgentSessionMetadata } from "@earendil-works/pi-agent-core";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
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

export const PROTOCOL_VERSION = 1 as const;

const IdSchema = Type.String({ minLength: 1 });
const TimestampSchema = Type.Integer({ minimum: 0 });
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const ServiceIdSchema = Type.String({ pattern: "^[0-9a-f]{32}$" });
export const SessionIdSchema = IdSchema;
export type ServiceId = Static<typeof ServiceIdSchema>;
export type SessionId = Static<typeof SessionIdSchema>;

export function isServiceId(value: unknown): value is ServiceId {
	return Check(ServiceIdSchema, value);
}

/** The durable metadata returned directly by SessionRepo.list(). */
export type SessionMetadata = AgentSessionMetadata;
export const SessionMetadataSchema = Type.Unsafe<SessionMetadata>(
	StrictObject({
		id: SessionIdSchema,
		createdAt: TimestampSchema,
		storageVersion: Type.Integer({ minimum: 1 }),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		parentSessionId: Type.Optional(SessionIdSchema),
		legacyParentSessionPath: Type.Optional(Type.String({ minLength: 1 })),
	}),
);

/** Remote methods available on a Pi service in protocol v1. */
export const ServiceRpc = defineRpc({
	list: {
		args: Type.Tuple([]),
		result: Type.Array(SessionMetadataSchema),
	},
	attach: {
		args: Type.Tuple([SessionIdSchema]),
		result: StrictObject({ sessionId: SessionIdSchema }),
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

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("wrong_service"),
	Type.Literal("session_not_found"),
	Type.Literal("session_locked"),
	Type.Literal("server_busy"),
	Type.Literal("server_restarting"),
	Type.Literal("invalid_request"),
	Type.Literal("internal_error"),
]);
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/** Must be the first frame sent by a client. */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
});
export type ClientHello = Static<typeof ClientHelloSchema>;

export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	serviceId: ServiceIdSchema,
	call: ServiceRpcCallSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema]);
export type ClientMessage = Static<typeof ClientMessageSchema>;

export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	connectionId: IdSchema,
	serviceId: ServiceIdSchema,
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
		result: ServiceRpcResultSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
export const ServerMessageSchema = Type.Union([ServerHelloSchema, ServerHelloErrorSchema, ResponseEnvelopeSchema]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;

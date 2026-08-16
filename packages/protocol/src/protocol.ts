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

export const ServerIdSchema = Type.String({
	pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const SessionIdSchema = IdSchema;
export type ServerId = Static<typeof ServerIdSchema>;
export type SessionId = Static<typeof SessionIdSchema>;

export function isServerId(value: unknown): value is ServerId {
	return Check(ServerIdSchema, value);
}

/** Durable Session metadata exposed by the wire protocol. */
export const SessionMetadataSchema = StrictObject({
	id: SessionIdSchema,
	createdAt: TimestampSchema,
	storageVersion: Type.Integer({ minimum: 1 }),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	parentSessionId: Type.Optional(SessionIdSchema),
	legacyParentSessionPath: Type.Optional(Type.String({ minLength: 1 })),
});
export type SessionMetadata = Static<typeof SessionMetadataSchema>;

/** Session operations available to normal Pi clients in protocol v1. */
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

export type ProtocolRpcCall = ServiceRpcCall;
export type ProtocolRpcResult = ServiceRpcResultUnion;
const ProtocolRpcCallSchema = ServiceRpcCallSchema;
const ProtocolRpcResultSchema = ServiceRpcResultSchema;

export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("version"),
	Type.Literal("wrong_server"),
	Type.Literal("session_not_found"),
	Type.Literal("session_ambiguous"),
	Type.Literal("session_in_use"),
	Type.Literal("server_draining"),
	Type.Literal("invalid_request"),
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

export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	serverId: ServerIdSchema,
	call: ProtocolRpcCallSchema,
});
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema]);
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
		result: ProtocolRpcResultSchema,
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

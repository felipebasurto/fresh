import { describe, expect, test } from "vitest";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	createRpcClient,
	createRpcDispatcher,
	decodeCbor,
	encodeCbor,
	encodeClientMessage,
	encodeFrame,
	encodeServerMessage,
	FrameDecoder,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
	ServiceRpc,
} from "../src/index.ts";

const clientHello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
const serverHello: ServerHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
	connectionId: "connection-1",
	serviceId: "service-1",
};

const metadata = {
	id: "session-1",
	createdAt: 1,
	storageVersion: 1,
	cwd: "/workspace",
	parentSessionId: "parent-1",
} as const;

describe("RPC manifest", () => {
	test("creates typed client methods from the manifest", async () => {
		const calls: unknown[] = [];
		const client = createRpcClient(ServiceRpc, async (call) => {
			calls.push(call);
			return call.method === "list" ? [metadata] : { sessionId: call.args[0] };
		});

		await expect(client.list()).resolves.toEqual([metadata]);
		await expect(client.attach("session-1")).resolves.toEqual({ sessionId: "session-1" });
		expect(calls).toEqual([
			{ method: "list", args: [] },
			{ method: "attach", args: ["session-1"] },
		]);
	});

	test("dispatches only methods and values allowed by the manifest", async () => {
		const dispatch = createRpcDispatcher(ServiceRpc, {
			list: () => [metadata],
			attach: (_context, sessionId) => ({ sessionId }),
		});
		await expect(dispatch({ method: "list", args: [] }, undefined)).resolves.toEqual([metadata]);
		await expect(dispatch({ method: "attach", args: ["session-1"] }, undefined)).resolves.toEqual({
			sessionId: "session-1",
		});
		await expect(dispatch({ method: "attach", args: [] } as never, undefined)).rejects.toThrow(/Invalid arguments/);
	});
});

describe("protocol validation", () => {
	test("negotiates protocol version 1", () => {
		expect(PROTOCOL_VERSION).toBe(1);
		expect(isSupportedProtocolVersion(1)).toBe(true);
		expect(isSupportedProtocolVersion(2)).toBe(false);
		expect(isSupportedProtocolVersion(2.5)).toBe(false);
	});

	test.each([0, PROTOCOL_VERSION, PROTOCOL_VERSION + 1])(
		"accepts integer client hello version %s for negotiation",
		(version) => expect(parseClientMessage({ ...clientHello, version })).toEqual({ ...clientHello, version }),
	);

	test.each([
		{ type: "hello", version: String(PROTOCOL_VERSION) },
		{ type: "hello", version: PROTOCOL_VERSION + 0.5 },
		{ type: "hello", version: PROTOCOL_VERSION, extra: true },
	])("rejects an invalid client hello", (message) => {
		expect(() => parseClientMessage(message)).toThrow(ProtocolValidationError);
	});

	test("validates list and attach RPC calls with logical targets", () => {
		const list: ClientMessage = {
			type: "request",
			id: "request-1",
			serviceId: "service-1",
			call: { method: "list", args: [] },
		};
		const attach: ClientMessage = {
			type: "request",
			id: "request-2",
			serviceId: "service-1",
			call: { method: "attach", args: ["session-1"] },
		};
		expect(parseClientMessage(list)).toEqual(list);
		expect(parseClientMessage(attach)).toEqual(attach);
		expect(() => parseClientMessage({ ...attach, call: { method: "attach", args: [] } })).toThrow(
			ProtocolValidationError,
		);
		expect(() => parseClientMessage({ ...attach, call: { method: "unknown", args: [] } })).toThrow(
			ProtocolValidationError,
		);
	});

	test("validates SessionRepo metadata without a presentation projection", () => {
		const message: ServerMessage = {
			type: "response",
			id: "request-1",
			ok: true,
			result: [metadata],
		};
		expect(parseServerMessage(message)).toEqual(message);
		expect(() => parseServerMessage({ ...message, result: [{ id: "session-1", createdAt: 1 }] })).toThrow(
			ProtocolValidationError,
		);
	});

	test("validates attach results", () => {
		const message: ServerMessage = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { sessionId: "session-1" },
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test.each([
		"wrong_service",
		"session_not_found",
		"session_locked",
		"server_busy",
		"server_restarting",
		"internal_error",
	] as const)("accepts the %s error code", (code) => {
		const message: ServerMessage = {
			type: "response",
			id: "request-1",
			ok: false,
			error: { code, message: "safe" },
		};
		expect(parseServerMessage(message)).toEqual(message);
	});

	test("rejects unknown messages and fields", () => {
		expect(() => parseServerMessage({ ...serverHello, snapshot: {} })).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage({ type: "event", event: {} })).toThrow(ProtocolValidationError);
	});

	test("does not parse JSON strings as messages", () => {
		expect(() => parseClientMessage(JSON.stringify(clientHello))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(JSON.stringify(serverHello))).toThrow(ProtocolValidationError);
	});

	test("rejects cyclic JSON error details without retaining the payload", () => {
		const details: Record<string, unknown> = {};
		details.self = details;
		let thrown: unknown;
		try {
			parseServerMessage({
				type: "response",
				id: "request-1",
				ok: false,
				error: { code: "invalid_request", message: "invalid", details },
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ProtocolValidationError);
		expect(Object.hasOwn(thrown as object, "value")).toBe(false);
	});
});

describe("validated framed protocol APIs", () => {
	test("encodes complete client and server frames", () => {
		const clientFrames = new FrameDecoder().push(encodeClientMessage(clientHello));
		expect(parseClientMessage(decodeCbor(clientFrames[0]!))).toEqual(clientHello);
		const serverFrames = new FrameDecoder().push(encodeServerMessage(serverHello));
		expect(parseServerMessage(decodeCbor(serverFrames[0]!))).toEqual(serverHello);
	});

	test("enforces outbound frame limits", () => {
		expect(() => encodeClientMessage(clientHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
		expect(() => encodeServerMessage(serverHello, { maxFrameLength: 8 })).toThrow(ProtocolValidationError);
	});

	test("incrementally decodes fragmented and coalesced client messages", () => {
		const request: ClientMessage = {
			type: "request",
			id: "request-1",
			serviceId: "service-1",
			call: { method: "list", args: [] },
		};
		const first = encodeClientMessage(clientHello);
		const second = encodeClientMessage(request);
		const wire = new Uint8Array(first.byteLength + second.byteLength);
		wire.set(first);
		wire.set(second, first.byteLength);

		for (let split = 0; split <= wire.byteLength; split++) {
			const decoder = new ClientMessageDecoder();
			const messages = [...decoder.push(wire.subarray(0, split)), ...decoder.push(wire.subarray(split))];
			decoder.end();
			expect(messages).toEqual([clientHello, request]);
		}
	});

	test.each([
		["empty CBOR payload", encodeFrame(new Uint8Array())],
		["malformed CBOR", encodeFrame(new Uint8Array([0xff]))],
		["schema-invalid CBOR", encodeFrame(encodeCbor({ type: "hello", version: 1, extra: true }))],
	] as const)("rejects invalid framed input: %s", (_label, wire) => {
		const decoder = new ClientMessageDecoder();
		expect(() => decoder.push(wire)).toThrow(ProtocolValidationError);
		expect(() => decoder.push(encodeClientMessage(clientHello))).toThrow(/failed/i);
	});

	test("rejects truncated and oversized framing", () => {
		const truncated = new ServerMessageDecoder();
		expect(truncated.push(new Uint8Array([0, 0, 0, 2, 1]))).toEqual([]);
		expect(() => truncated.end()).toThrow(ProtocolValidationError);
		const oversized = new ClientMessageDecoder({ maxFrameLength: 3 });
		expect(() => oversized.push(new Uint8Array([0, 0, 0, 4]))).toThrow(ProtocolValidationError);
	});
});

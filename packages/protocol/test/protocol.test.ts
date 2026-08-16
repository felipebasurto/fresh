import { describe, expect, test } from "vitest";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	createRpcClient,
	createRpcDispatcher,
	decodeCbor,
	defineRpc,
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
	serverId: "00000000-0000-4000-8000-000000000001",
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
			if (call.method === "list") return [metadata];
			return { sessionId: call.args[0] };
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

	test("rejects invalid results on both client and dispatcher boundaries", async () => {
		const client = createRpcClient(ServiceRpc, async () => ({ sessionId: 1 }));
		await expect(client.attach("session-1")).rejects.toThrow(/Invalid result.*attach/);

		const dispatch = createRpcDispatcher(ServiceRpc, {
			list: () => [{ id: "session-1" }],
			attach: (_context: undefined, sessionId: string) => ({ sessionId }),
		} as never);
		await expect(dispatch({ method: "list", args: [] }, undefined)).rejects.toThrow(/Invalid result.*list/);
	});

	test("rejects empty manifests instead of creating unusable RPC clients", () => {
		expect(() => defineRpc({})).toThrow(/at least one method/);
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

	test.each([
		"",
		"server-1",
		"00000000-0000-7000-8000-000000000001",
		"00000000-0000-4000-7000-000000000001",
		"00000000-0000-4000-8000-00000000000A",
	])("rejects non-canonical UUIDv4 server ID %j", (serverId) => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "request-1",
				serverId,
				call: { method: "list", args: [] },
			}),
		).toThrow(ProtocolValidationError);
	});

	test("validates service RPC calls with logical targets", () => {
		const list: ClientMessage = {
			type: "request",
			id: "request-1",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "list", args: [] },
		};
		const attach: ClientMessage = {
			type: "request",
			id: "request-2",
			serverId: "00000000-0000-4000-8000-000000000001",
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
		[
			"empty request id",
			{
				type: "request",
				id: "",
				serverId: "00000000-0000-4000-8000-000000000001",
				call: { method: "list", args: [] },
			},
		],
		[
			"empty session id",
			{
				type: "request",
				id: "request-1",
				serverId: "00000000-0000-4000-8000-000000000001",
				call: { method: "attach", args: [""] },
			},
		],
		[
			"extra call field",
			{
				type: "request",
				id: "request-1",
				serverId: "00000000-0000-4000-8000-000000000001",
				call: { method: "list", args: [], extra: true },
			},
		],
	] as const)("rejects malformed request boundaries: %s", (_label, message) => {
		expect(() => parseClientMessage(message)).toThrow(ProtocolValidationError);
	});

	test.each([
		["invalid server id", { ...serverHello, serverId: "server-1" }],
		["missing response result", { type: "response", id: "request-1", ok: true }],
		["extra response field", { type: "response", id: "request-1", ok: true, result: [], extra: true }],
	] as const)("rejects malformed server boundaries: %s", (_label, message) => {
		expect(() => parseServerMessage(message)).toThrow(ProtocolValidationError);
	});

	test.each(["wrong_server", "session_not_found", "session_in_use", "server_draining", "internal_error"] as const)(
		"accepts the %s error code",
		(code) => {
			const message: ServerMessage = {
				type: "response",
				id: "request-1",
				ok: false,
				error: { code, message: "safe" },
			};
			expect(parseServerMessage(message)).toEqual(message);
		},
	);

	test("rejects unknown messages and fields", () => {
		expect(() => parseServerMessage({ ...serverHello, snapshot: {} })).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage({ type: "event", event: {} })).toThrow(ProtocolValidationError);
	});

	test("does not parse JSON strings as messages", () => {
		expect(() => parseClientMessage(JSON.stringify(clientHello))).toThrow(ProtocolValidationError);
		expect(() => parseServerMessage(JSON.stringify(serverHello))).toThrow(ProtocolValidationError);
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
			serverId: "00000000-0000-4000-8000-000000000001",
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

	test("incrementally decodes fragmented and coalesced server messages", () => {
		const response: ServerMessage = { type: "response", id: "request-1", ok: true, result: [] };
		const first = encodeServerMessage(serverHello);
		const second = encodeServerMessage(response);
		const wire = new Uint8Array(first.byteLength + second.byteLength);
		wire.set(first);
		wire.set(second, first.byteLength);

		const split = first.byteLength + Math.floor(second.byteLength / 2);
		const decoder = new ServerMessageDecoder();
		expect(decoder.push(wire.subarray(0, split))).toEqual([serverHello]);
		expect(decoder.push(wire.subarray(split))).toEqual([response]);
		decoder.end();
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

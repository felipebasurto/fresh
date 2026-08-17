import { Check } from "typebox/value";
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
	type JsonValue,
	JsonValueSchema,
	type LaneSnapshot,
	PROTOCOL_VERSION,
	PromptArgumentsSchema,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	type RunResult,
	RunResultSchema,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
	ServiceRpc,
	type SessionMetadata,
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
} as const satisfies SessionMetadata;

const laneSnapshot = {
	lane: "main",
	transcript: [],
	leafId: null,
	operation: null,
	queues: { steer: [], followUp: [], nextRun: [] },
	pendingWrites: [],
	faulted: false,
} satisfies LaneSnapshot;

const completedRunResult = {
	ok: true,
	value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
} as const satisfies RunResult;

describe("RPC manifest", () => {
	test("creates typed client methods from the manifest", async () => {
		const calls: unknown[] = [];
		const client = createRpcClient(ServiceRpc, async (call) => {
			calls.push(call);
			switch (call.method) {
				case "list":
					return [metadata];
				case "create":
					return metadata;
				case "attach":
					return { sessionId: call.args[0] };
				case "prompt":
					return completedRunResult;
				case "watch":
					return { watchId: "watch-1", snapshot: laneSnapshot };
				case "startWatch":
				case "stopWatch":
					return { watchId: call.args[1] };
			}
		});

		await expect(client.list()).resolves.toEqual([metadata]);
		await expect(client.create({ cwd: "/workspace" })).resolves.toEqual(metadata);
		await expect(client.attach("session-1")).resolves.toEqual({ sessionId: "session-1" });
		await expect(client.prompt("session-1", ["Hello"])).resolves.toEqual(completedRunResult);
		await expect(client.watch("session-1")).resolves.toEqual({ watchId: "watch-1", snapshot: laneSnapshot });
		await expect(client.startWatch("session-1", "watch-1")).resolves.toEqual({ watchId: "watch-1" });
		await expect(client.stopWatch("session-1", "watch-1")).resolves.toEqual({ watchId: "watch-1" });
		expect(calls).toEqual([
			{ method: "list", args: [] },
			{ method: "create", args: [{ cwd: "/workspace" }] },
			{ method: "attach", args: ["session-1"] },
			{ method: "prompt", args: ["session-1", ["Hello"]] },
			{ method: "watch", args: ["session-1"] },
			{ method: "startWatch", args: ["session-1", "watch-1"] },
			{ method: "stopWatch", args: ["session-1", "watch-1"] },
		]);
	});

	test("dispatches only methods and values allowed by the manifest", async () => {
		const dispatch = createRpcDispatcher(ServiceRpc, {
			list: () => [metadata],
			create: () => metadata,
			attach: (_context, sessionId) => ({ sessionId }),
			prompt: () => completedRunResult,
			watch: () => ({ watchId: "watch-1", snapshot: laneSnapshot }),
			startWatch: (_context, _sessionId, watchId) => ({ watchId }),
			stopWatch: (_context, _sessionId, watchId) => ({ watchId }),
		});
		await expect(dispatch({ method: "list", args: [] }, undefined)).resolves.toEqual([metadata]);
		await expect(dispatch({ method: "create", args: [{ cwd: "/workspace" }] }, undefined)).resolves.toEqual(metadata);
		await expect(dispatch({ method: "attach", args: ["session-1"] }, undefined)).resolves.toEqual({
			sessionId: "session-1",
		});
		await expect(dispatch({ method: "prompt", args: ["session-1", ["Hello"]] }, undefined)).resolves.toEqual(
			completedRunResult,
		);
		await expect(dispatch({ method: "watch", args: ["session-1"] }, undefined)).resolves.toEqual({
			watchId: "watch-1",
			snapshot: laneSnapshot,
		});
		await expect(dispatch({ method: "attach", args: [] } as never, undefined)).rejects.toThrow(/Invalid arguments/);
		await expect(dispatch({ method: "prompt", args: ["session-1", []] } as never, undefined)).rejects.toThrow(
			/Invalid arguments/,
		);
	});

	test("rejects invalid results on both client and dispatcher boundaries", async () => {
		const client = createRpcClient(ServiceRpc, async () => ({ sessionId: 1 }));
		await expect(client.attach("session-1")).rejects.toThrow(/Invalid result.*attach/);

		const dispatch = createRpcDispatcher(ServiceRpc, {
			list: () => [{ id: "session-1" }],
			create: () => metadata,
			attach: (_context: undefined, sessionId: string) => ({ sessionId }),
			prompt: () => completedRunResult,
			watch: () => ({ watchId: "watch-1", snapshot: laneSnapshot }),
			startWatch: (_context: undefined, _sessionId: string, watchId: string) => ({ watchId }),
			stopWatch: (_context: undefined, _sessionId: string, watchId: string) => ({ watchId }),
		} as never);
		await expect(dispatch({ method: "list", args: [] }, undefined)).rejects.toThrow(/Invalid result.*list/);

		const invalidPromptClient = createRpcClient(ServiceRpc, async () => ({ ok: true, value: {} }));
		await expect(invalidPromptClient.prompt("session-1", ["Hello"])).rejects.toThrow(/Invalid result.*prompt/);
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
		const create: ClientMessage = {
			type: "request",
			id: "request-2",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "create", args: [{ cwd: "/workspace" }] },
		};
		const attach: ClientMessage = {
			type: "request",
			id: "request-3",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "attach", args: ["session-1"] },
		};
		const prompt: ClientMessage = {
			type: "request",
			id: "request-4",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "prompt", args: ["session-1", ["Hello"]] },
		};
		expect(parseClientMessage(list)).toEqual(list);
		expect(parseClientMessage(create)).toEqual(create);
		expect(parseClientMessage(attach)).toEqual(attach);
		expect(parseClientMessage(prompt)).toEqual(prompt);
		expect(() => parseClientMessage({ ...create, call: { method: "create", args: [{ cwd: "" }] } })).toThrow(
			ProtocolValidationError,
		);
		expect(() => parseClientMessage({ ...attach, call: { method: "attach", args: [] } })).toThrow(
			ProtocolValidationError,
		);
		expect(() => parseClientMessage({ ...attach, call: { method: "unknown", args: [] } })).toThrow(
			ProtocolValidationError,
		);
		expect(() => parseClientMessage({ ...prompt, call: { method: "prompt", args: ["session-1", []] } })).toThrow(
			ProtocolValidationError,
		);
	});

	test("validates recursively nested JSON values", () => {
		const values = [
			null,
			true,
			1,
			"value",
			[1, { nested: [false] }],
			{ nested: { value: "ok" } },
		] satisfies JsonValue[];
		for (const value of values) expect(Check(JsonValueSchema, value)).toBe(true);
	});

	test.each([undefined, 1n, Symbol("value"), () => {}])("rejects non-JSON value %s", (value) => {
		expect(Check(JsonValueSchema, value)).toBe(false);
	});

	test.each([
		["CBOR byte array", decodeCbor(encodeCbor(new Uint8Array([1, 2, 3])))],
		["date", new Date(0)],
		["map", new Map([["key", "value"]])],
		["class instance", new (class JsonValueTestClass {})()],
		["nested class instance", { nested: new (class JsonValueTestClass {})() }],
	] as const)("rejects non-plain JSON value: %s", (_label, value) => {
		expect(Check(JsonValueSchema, value)).toBe(false);
	});

	test("rejects cyclic JSON values", () => {
		const value: { self?: unknown } = {};
		value.self = value;
		expect(Check(JsonValueSchema, value)).toBe(false);
	});

	test.each([
		["text", ["Hello"]],
		["text and images", ["Describe", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]]],
		["one message", [{ role: "user", content: "Hello", timestamp: 1 }]],
		[
			"multiple messages",
			[
				[
					{ role: "user", content: "Question", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "text", text: "Answer" }],
						api: "test",
						provider: "test",
						model: "test",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 2,
					},
				],
			],
		],
	] as const)("validates %s prompt arguments", (_label, promptArguments) => {
		expect(Check(PromptArgumentsSchema, promptArguments)).toBe(true);
	});

	test.each([
		["empty prompt tuple", []],
		["missing image data", ["Describe", [{ type: "image", mimeType: "image/png" }]]],
		["unknown message role", [{ role: "extension", content: "Hello", timestamp: 1 }]],
		["extra text argument", ["Hello", [], "extra"]],
	] as const)("rejects malformed prompt arguments: %s", (_label, promptArguments) => {
		expect(Check(PromptArgumentsSchema, promptArguments)).toBe(false);
	});

	test("validates protocol Session metadata", () => {
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

	test("validates lane watch snapshots and events", () => {
		const snapshotMessage: ServerMessage = {
			type: "response",
			id: "request-1",
			ok: true,
			result: { watchId: "watch-1", snapshot: laneSnapshot },
		};
		const eventMessage: ServerMessage = {
			type: "event",
			watchId: "watch-1",
			event: { type: "run_start", lane: "main", runId: "run-1" },
		};
		expect(parseServerMessage(snapshotMessage)).toEqual(snapshotMessage);
		expect(parseServerMessage(eventMessage)).toEqual(eventMessage);
		expect(
			parseServerMessage({
				type: "event",
				watchId: "watch-1",
				event: {
					type: "message_update",
					lane: "main",
					runId: "run-1",
					frame: { type: "text_delta", contentIndex: 0, delta: "hello" },
				},
			}),
		).toMatchObject({ event: { frame: { delta: "hello" } } });
		expect(() => parseServerMessage({ ...eventMessage, event: { ...eventMessage.event, unknown: true } })).toThrow(
			ProtocolValidationError,
		);
		expect(() =>
			parseServerMessage({
				type: "event",
				watchId: "watch-1",
				event: {
					type: "run_end",
					lane: "main",
					runId: "run-1",
					leafId: "leaf-1",
					outcome: "completed",
					finalEntryId: "entry-1",
				},
			}),
		).toThrow(ProtocolValidationError);
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
		{ ok: true, value: { kind: "completed", runId: "run-1", leafId: "leaf-1" } },
		{ ok: true, value: { kind: "aborted", runId: "run-1", leafId: "leaf-1" } },
		{
			ok: true,
			value: {
				kind: "failed",
				runId: "run-1",
				leafId: "leaf-1",
				error: { code: "provider", message: "provider failed" },
			},
		},
		{
			ok: true,
			value: {
				kind: "suspended",
				reason: "missing_identities",
				runId: "run-1",
				leafId: "leaf-1",
				missing: { tools: ["tool"], models: [] },
			},
		},
		{
			ok: false,
			error: {
				_tag: "LaneBusy",
				lane: "main",
				operationId: "operation-1",
				operationKind: "run",
				message: "lane busy",
			},
		},
		{ ok: false, error: { _tag: "Closed", message: "closed" } },
	] satisfies RunResult[])("validates structural Harness RunResult", (result) => {
		expect(Check(RunResultSchema, result)).toBe(true);
	});

	test.each([
		{ ok: true, value: { kind: "failed", runId: "run-1", leafId: "leaf-1" } },
		{ ok: true, value: { kind: "completed", runId: "run-1", leafId: "leaf-1", finalEntryId: "entry-1" } },
		{ ok: false, error: { _tag: "Closed", message: "closed", extra: true } },
	] as const)("rejects malformed structural Harness RunResult", (result) => {
		expect(Check(RunResultSchema, result)).toBe(false);
	});

	test.each([
		["bigint", 1n],
		["byte array", new Uint8Array([1, 2, 3])],
		["date", new Date(0)],
	] as const)("rejects non-protocol %s nested in Harness DTOs", (_label, details) => {
		expect(
			Check(RunResultSchema, {
				ok: true,
				value: {
					kind: "failed",
					runId: "run-1",
					leafId: "leaf-1",
					error: { code: "provider", message: "failed", details },
				},
			}),
		).toBe(false);
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

	test.each([
		"wrong_server",
		"session_not_found",
		"session_in_use",
		"session_not_attached",
		"watch_not_found",
		"watch_in_use",
		"not_supported",
		"server_draining",
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

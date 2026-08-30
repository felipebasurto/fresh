import { Check } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	createRpcClient,
	createRpcDispatcher,
	createServiceCatalogueCall,
	createServiceSubscribeCall,
	createServiceUnsubscribeCall,
	decodeCbor,
	decodeLaneWatchRpcCall,
	decodeServiceControlCall,
	defineRpc,
	encodeCbor,
	encodeClientMessage,
	encodeFrame,
	encodeLaneWatchRpcCall,
	encodeServerMessage,
	FrameDecoder,
	isSupportedProtocolVersion,
	type LaneSnapshot,
	LaneWatchRpc,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	parseClientMessage,
	parseServerMessage,
	parseServiceCatalogue,
	parseServiceSubscriptionSnapshot,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
	type SessionSummary,
	SessionSummarySchema,
} from "../src/index.ts";

const clientHello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
const serverHello: ServerHello = {
	type: "hello",
	version: PROTOCOL_VERSION,
	serverId: "00000000-0000-4000-8000-000000000001",
};

const summary = {
	serverId: "00000000-0000-4000-8000-000000000001",
	sessionId: "session-1",
	createdAt: 1,
} as const satisfies SessionSummary;

const laneSnapshot = {
	lane: "main",
	transcript: [],
	tipId: null,
	configuration: {
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		activeToolNames: [],
	},
	stats: {
		messageCount: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
	operation: null,
	queues: [],
	faulted: false,
} satisfies LaneSnapshot;

describe("RPC manifest", () => {
	test("creates typed lane-watch client methods from the manifest", async () => {
		const calls: unknown[] = [];
		const client = createRpcClient(LaneWatchRpc, async (call) => {
			calls.push(call);
			switch (call.method) {
				case "watch":
					return { watchId: "watch-1", snapshot: laneSnapshot };
				case "startWatch":
				case "stopWatch":
					return { watchId: call.args[0] };
				case "resnapshotWatch":
					return { watchId: call.args[0], snapshot: laneSnapshot };
			}
		});

		await expect(client.watch()).resolves.toEqual({ watchId: "watch-1", snapshot: laneSnapshot });
		await expect(client.startWatch("watch-1")).resolves.toEqual({ watchId: "watch-1" });
		await expect(client.resnapshotWatch("watch-1")).resolves.toEqual({
			watchId: "watch-1",
			snapshot: laneSnapshot,
		});
		await expect(client.stopWatch("watch-1")).resolves.toEqual({ watchId: "watch-1" });
		expect(calls).toEqual([
			{ method: "watch", args: [] },
			{ method: "startWatch", args: ["watch-1"] },
			{ method: "resnapshotWatch", args: ["watch-1"] },
			{ method: "stopWatch", args: ["watch-1"] },
		]);
	});

	test("maps lane-watch contracts onto generic service/member envelopes", () => {
		const encoded = encodeLaneWatchRpcCall({ method: "startWatch", args: ["watch-1"] });
		expect(encoded).toEqual({ serviceId: "pi.transcript", member: "startWatch", args: ["watch-1"] });
		expect(decodeLaneWatchRpcCall(encoded)).toEqual({ method: "startWatch", args: ["watch-1"] });
		expect(decodeLaneWatchRpcCall({ serviceId: "pi.transcript", member: "startWatch", args: [] })).toBeUndefined();
		expect(decodeLaneWatchRpcCall({ serviceId: "unknown", member: "method", args: [] })).toBeUndefined();
	});

	test("dispatches only methods and values allowed by the manifest", async () => {
		const dispatch = createRpcDispatcher(LaneWatchRpc, {
			watch: () => ({ watchId: "watch-1", snapshot: laneSnapshot }),
			startWatch: (_context, watchId) => ({ watchId }),
			resnapshotWatch: (_context, watchId) => ({ watchId, snapshot: laneSnapshot }),
			stopWatch: (_context, watchId) => ({ watchId }),
		});
		await expect(dispatch({ method: "watch", args: [] }, undefined)).resolves.toEqual({
			watchId: "watch-1",
			snapshot: laneSnapshot,
		});
		await expect(dispatch({ method: "resnapshotWatch", args: ["watch-1"] }, undefined)).resolves.toEqual({
			watchId: "watch-1",
			snapshot: laneSnapshot,
		});
		await expect(dispatch({ method: "startWatch", args: [] } as never, undefined)).rejects.toThrow(
			/Invalid arguments/,
		);
	});

	test("rejects invalid results on client boundaries", async () => {
		const client = createRpcClient(LaneWatchRpc, async () => ({ watchId: 1 }));
		await expect(client.watch()).rejects.toThrow(/Invalid result.*watch/);
	});

	test("rejects empty manifests instead of creating unusable RPC clients", () => {
		expect(() => defineRpc({})).toThrow(/at least one method/);
	});
});

describe("protocol validation", () => {
	test("negotiates protocol version 6", () => {
		expect(PROTOCOL_VERSION).toBe(6);
		expect(isSupportedProtocolVersion(6)).toBe(true);
		expect(isSupportedProtocolVersion(5)).toBe(false);
		expect(isSupportedProtocolVersion(6.5)).toBe(false);
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

	test("encodes service control and keyed instance addresses", () => {
		expect(decodeServiceControlCall(createServiceCatalogueCall())).toEqual({ type: "catalogue" });
		expect(
			parseServiceCatalogue([
				{ serviceId: "pi.models", mode: "singleton" },
				{ serviceId: "pi.dialogs", mode: "keyed" },
			]),
		).toEqual([
			{ serviceId: "pi.models", mode: "singleton" },
			{ serviceId: "pi.dialogs", mode: "keyed" },
		]);
		const subscribe = createServiceSubscribeCall("subscription-1", "pi.models", "singleton");
		expect(decodeServiceControlCall(subscribe)).toEqual({
			type: "subscribe",
			subscriptionId: "subscription-1",
			serviceId: "pi.models",
			mode: "singleton",
		});
		expect(decodeServiceControlCall(createServiceUnsubscribeCall("subscription-1"))).toEqual({
			type: "unsubscribe",
			subscriptionId: "subscription-1",
		});
		expect(
			parseServiceSubscriptionSnapshot({
				serviceId: "pi.models",
				mode: "singleton",
				instances: [
					{
						members: [{ name: "state", kind: "state", sequence: 0, value: { revision: 1 } }],
					},
				],
			}),
		).toEqual({
			serviceId: "pi.models",
			mode: "singleton",
			instances: [
				{
					members: [{ name: "state", kind: "state", sequence: 0, value: { revision: 1 } }],
				},
			],
		});
		expect(
			parseServerMessage({
				type: "service_update",
				subscriptionId: "subscription-1",
				update: {
					type: "state",
					member: "state",
					sequence: 1,
					value: { revision: 2 },
				},
			}),
		).toMatchObject({ update: { type: "state", member: "state" } });
		expect(
			parseServerMessage({
				type: "service_update",
				subscriptionId: "subscription-1",
				update: { type: "unavailable" },
			}),
		).toMatchObject({ update: { type: "unavailable" } });
		expect(
			parseServerMessage({
				type: "service_update",
				subscriptionId: "subscription-1",
				update: {
					type: "replaced",
					snapshot: { members: [{ name: "select", kind: "method" }] },
				},
			}),
		).toMatchObject({ update: { type: "replaced", snapshot: { members: [{ name: "select" }] } } });
		const keyed: ClientMessage = {
			type: "request",
			id: "request-1",
			target: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				attachmentId: "attachment-1",
			},
			call: {
				serviceId: "pi.question-dialog",
				instance: { key: "invocation-1", generation: 2 },
				member: "submit",
				args: [{ outcome: "selected", index: 0 }],
			},
		};
		expect(parseClientMessage(keyed)).toEqual(keyed);
	});

	test("keeps transport RPC calls untyped while validating their envelope", () => {
		const list: ClientMessage = {
			type: "request",
			id: "request-1",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-directory", member: "list", args: [] },
		};
		const create: ClientMessage = {
			type: "request",
			id: "request-2",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-management", member: "create", args: [{}] },
		};
		const attach: ClientMessage = {
			type: "request",
			id: "request-3",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-management", member: "attach", args: ["session-1"] },
		};
		const prompt: ClientMessage = {
			type: "request",
			id: "request-4",
			target: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				attachmentId: "attachment-1",
			},
			call: { serviceId: "pi.chat", member: "prompt", args: [["Hello"]] },
		};
		expect(parseClientMessage(list)).toEqual(list);
		expect(parseClientMessage(create)).toEqual(create);
		expect(parseClientMessage(attach)).toEqual(attach);
		expect(parseClientMessage(prompt)).toEqual(prompt);
		expect(parseClientMessage({ ...create, call: { ...create.call, args: [{ cwd: "" }] } })).toMatchObject({
			call: { serviceId: "pi.session-management", member: "create" },
		});
		expect(parseClientMessage({ ...attach, call: { ...attach.call, args: [] } })).toMatchObject({
			call: { serviceId: "pi.session-management", member: "attach", args: [] },
		});
		expect(
			parseClientMessage({
				...attach,
				call: { serviceId: "unknown", member: "method", args: [{ arbitrary: true }] },
			}),
		).toMatchObject({ call: { serviceId: "unknown", member: "method" } });
		expect(parseClientMessage({ ...prompt, call: { ...prompt.call, args: ["session-1", []] } })).toMatchObject({
			call: { serviceId: "pi.chat", member: "prompt" },
		});
	});

	test("validates request cancellation envelopes", () => {
		const cancel: ClientMessage = {
			type: "cancel",
			id: "request-1",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
		};
		expect(parseClientMessage(cancel)).toEqual(cancel);
		expect(() => parseClientMessage({ ...cancel, id: "" })).toThrow(ProtocolValidationError);
		expect(() => parseClientMessage({ ...cancel, extra: true })).toThrow(ProtocolValidationError);
	});

	test("keeps presentation-safe Session summary validation at the typed service boundary", () => {
		expect(Check(SessionSummarySchema, summary)).toBe(true);
		expect(Check(SessionSummarySchema, { ...summary, cwd: "/private" })).toBe(false);
		const message: ServerMessage = {
			type: "response",
			id: "request-1",
			ok: true,
			result: [summary],
		};
		expect(parseServerMessage(message)).toEqual(message);
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
			event: { type: "run_start", lane: "main", runId: "run-1", startedAt: 1 },
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
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						api: "test",
						provider: "test",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "pending",
						timestamp: 1,
					},
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
					fromTipId: null,
					tipId: "leaf-1",
					status: "completed",
					finalEntryId: "entry-1",
				},
			}),
		).toThrow(ProtocolValidationError);
	});

	test("validates attachment route updates", () => {
		const attached: ServerMessage = {
			type: "attachment",
			attachment: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				attachmentId: "attachment-1",
			},
		};
		const detached: ServerMessage = { type: "attachment", attachment: null };
		expect(parseServerMessage(attached)).toEqual(attached);
		expect(parseServerMessage(detached)).toEqual(detached);
		expect(() => parseServerMessage({ ...attached, attachment: { sessionId: "session-1" } })).toThrow(
			ProtocolValidationError,
		);
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

	test("accepts a successful void response without a result field", () => {
		expect(parseServerMessage({ type: "response", id: "request-1", ok: true })).toEqual({
			type: "response",
			id: "request-1",
			ok: true,
		});
	});

	test.each([
		["invalid server id", { ...serverHello, serverId: "server-1" }],
		["extra response field", { type: "response", id: "request-1", ok: true, result: [], extra: true }],
	] as const)("rejects malformed server boundaries: %s", (_label, message) => {
		expect(() => parseServerMessage(message)).toThrow(ProtocolValidationError);
	});

	test.each([
		"wrong_server",
		"session_not_found",
		"session_not_attached",
		"watch_not_found",
		"watch_in_use",
		"not_supported",
		"server_draining",
		"cancelled",
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
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-directory", member: "list", args: [] },
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

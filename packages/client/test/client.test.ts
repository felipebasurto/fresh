import {
	encodeCbor,
	encodeFrame,
	encodeServerMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
} from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { type ByteTransportFactory, PiClient, PiClientDisposedError, PiDisconnectedError } from "../src/index.ts";
import { MemoryByteServer } from "./support.ts";

async function connectClient(
	server: MemoryByteServer,
	serverId = "00000000-0000-4000-8000-000000000001",
): Promise<PiClient> {
	return PiClient.connect({ serverId, transportFactory: (handlers) => server.connect(handlers) });
}

test("requires a canonical UUIDv4 server identity", () => {
	expect(() => new PiClient({ serverId: "invalid-server", transportFactory: () => Promise.reject() })).toThrow(
		/serverId/,
	);
});

describe("PiClient service operations", () => {
	test("connects only to the expected logical server", async () => {
		const matching = new MemoryByteServer();
		const client = await connectClient(matching);
		expect(client.hello).toMatchObject({ serverId: "00000000-0000-4000-8000-000000000001" });
		await client.dispose();

		const wrong = new MemoryByteServer("00000000-0000-4000-8000-000000000002");
		await expect(connectClient(wrong)).rejects.toBeInstanceOf(ProtocolValidationError);
	});

	test("rejects a Session address belonging to another server", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		await expect(
			client.attachSession({
				serverId: "00000000-0000-4000-8000-000000000002",
				sessionId: "session-1",
			}),
		).rejects.toMatchObject({ code: "wrong_server" });
		expect(server.messages).toHaveLength(1);
		await client.dispose();
	});

	test("addresses Session operations to the configured server", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const listing = client.listSessions();
		await server.waitForMessages(2);
		expect(server.messages[1]).toEqual({
			type: "request",
			id: "request-1",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "session-directory", member: "list", args: [] },
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: [
				{
					serverId: "00000000-0000-4000-8000-000000000001",
					sessionId: "session-1",
					createdAt: 1,
				},
			],
		});
		await expect(listing).resolves.toEqual([
			{
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				createdAt: 1,
			},
		]);

		const creating = client.createSession({});
		await server.waitForMessages(3);
		expect(server.messages[2]).toMatchObject({
			type: "request",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "session-management", member: "create", args: [{}] },
		});
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-2",
				createdAt: 2,
			},
		});
		await expect(creating).resolves.toEqual({
			serverId: "00000000-0000-4000-8000-000000000001",
			sessionId: "session-2",
			createdAt: 2,
		});

		const attaching = client.attachSession("session-1");
		await server.waitForMessages(4);
		expect(server.messages[3]).toMatchObject({
			type: "request",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "session-management", member: "attach", args: ["session-1"] },
		});
		server.send({
			type: "response",
			id: "request-3",
			ok: true,
			result: { sessionId: "session-1", attachmentId: "attachment-1" },
		});
		await expect(attaching).resolves.toEqual({ sessionId: "session-1", attachmentId: "attachment-1" });

		const prompting = client.promptSession("session-1", "Hello");
		await server.waitForMessages(5);
		expect(server.messages[4]).toMatchObject({
			type: "request",
			target: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				attachmentId: "attachment-1",
			},
			call: { serviceId: "chat", member: "prompt", args: [["Hello"]] },
		});
		server.send({
			type: "response",
			id: "request-4",
			ok: true,
			result: { ok: true, value: { kind: "completed", runId: "run-1", leafId: "leaf-1" } },
		});
		await expect(prompting).resolves.toEqual({
			ok: true,
			value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
		});
		await client.dispose();
	});

	test("serializes every supported prompt overload as one argument tuple", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const attaching = client.attachSession("session-1");
		await server.waitForMessages(2);
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: { sessionId: "session-1", attachmentId: "attachment-1" },
		});
		await attaching;
		const calls = [
			client.promptSession("session-1", "text"),
			client.promptSession("session-1", "image", [{ type: "image", data: "aW1n", mimeType: "image/png" }]),
			client.promptSession("session-1", { role: "user", content: "message", timestamp: 1 }),
			client.promptSession("session-1", [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "user", content: "second", timestamp: 2 },
			]),
		];
		await server.waitForMessages(6);
		expect(
			server.messages.slice(2).map((message) => (message.type === "request" ? message.call : undefined)),
		).toEqual([
			{ serviceId: "chat", member: "prompt", args: [["text"]] },
			{
				serviceId: "chat",
				member: "prompt",
				args: [["image", [{ type: "image", data: "aW1n", mimeType: "image/png" }]]],
			},
			{ serviceId: "chat", member: "prompt", args: [[{ role: "user", content: "message", timestamp: 1 }]] },
			{
				serviceId: "chat",
				member: "prompt",
				args: [
					[
						[
							{ role: "user", content: "first", timestamp: 1 },
							{ role: "user", content: "second", timestamp: 2 },
						],
					],
				],
			},
		]);
		for (let index = 0; index < calls.length; index++) {
			server.send({
				type: "response",
				id: `request-${index + 2}`,
				ok: true,
				result: { ok: false, error: { _tag: "Closed", message: "closed" } },
			});
		}
		await expect(Promise.all(calls)).resolves.toHaveLength(4);
		await client.dispose();
	});

	test("starts lane event delivery only after receiving the authoritative snapshot", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const attaching = client.attachSession("session-1");
		await server.waitForMessages(2);
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: { sessionId: "session-1", attachmentId: "attachment-1" },
		});
		await attaching;
		const opening = client.watchSession("session-1");
		await server.waitForMessages(3);
		expect(server.messages[2]).toMatchObject({ call: { serviceId: "transcript", member: "watch", args: [] } });
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: {
				watchId: "watch-1",
				snapshot: {
					lane: "main",
					transcript: [],
					leafId: null,
					operation: null,
					queues: { steer: [], followUp: [], nextRun: [] },
					pendingWrites: [],
					faulted: false,
				},
			},
		});
		const watch = await opening;
		expect(watch.snapshot).toMatchObject({ lane: "main", transcript: [] });

		const events: string[] = [];
		let releaseEvent!: () => void;
		const eventGate = new Promise<void>((resolve) => {
			releaseEvent = resolve;
		});
		const starting = watch.start(async (event) => {
			await eventGate;
			events.push(event.type);
		});
		await server.waitForMessages(4);
		expect(server.messages[3]).toMatchObject({
			call: { serviceId: "transcript", member: "startWatch", args: ["watch-1"] },
		});
		server.send({
			type: "event",
			watchId: "watch-1",
			event: { type: "run_start", lane: "main", runId: "run-1" },
		});
		await Promise.resolve();
		expect(events).toEqual([]);
		server.send({ type: "response", id: "request-3", ok: true, result: { watchId: "watch-1" } });
		await starting;

		let disposed = false;
		const disposing = watch.dispose().then(() => {
			disposed = true;
		});
		await server.waitForMessages(5);
		expect(server.messages[4]).toMatchObject({
			call: { serviceId: "transcript", member: "stopWatch", args: ["watch-1"] },
		});
		server.send({ type: "response", id: "request-4", ok: true, result: { watchId: "watch-1" } });
		await Promise.resolve();
		expect(disposed).toBe(false);
		releaseEvent();
		await disposing;
		expect(events).toEqual(["run_start"]);
		server.send({
			type: "event",
			watchId: "watch-1",
			event: { type: "run_resume", lane: "main", runId: "run-1" },
		});
		expect(events).toEqual(["run_start"]);
		await client.dispose();
	});

	test("correlates out-of-order responses", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const first = client.listSessions();
		const second = client.attachSession("session-1");
		await server.waitForMessages(3);
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: { sessionId: "session-1", attachmentId: "attachment-1" },
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: [],
		});
		await expect(Promise.all([first, second])).resolves.toEqual([
			[],
			{ sessionId: "session-1", attachmentId: "attachment-1" },
		]);
		await client.dispose();
	});

	test("exposes bounded server errors", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const attaching = client.attachSession("missing");
		await server.waitForMessages(2);
		server.send({
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "session_not_found", message: "Unknown session" },
		});
		await expect(attaching).rejects.toMatchObject({ code: "session_not_found" });
		await client.dispose();
	});

	test("does not send a pre-aborted untyped RPC request", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);

		await expect(
			client.request(
				{ serverId: "00000000-0000-4000-8000-000000000001" },
				{ serviceId: "test", member: "noop", args: [] },
				controller.signal,
			),
		).rejects.toBe(reason);
		expect(server.messages).toHaveLength(1);
		await client.dispose();
	});

	test("cancels one untyped RPC request without disconnecting", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const controller = new AbortController();
		const reason = new Error("stop this request");
		const target = { serverId: "00000000-0000-4000-8000-000000000001" } as const;
		const pending = client.request(
			target,
			{ serviceId: "test", member: "mutate", args: [{ value: 42 }] },
			controller.signal,
		);
		await server.waitForMessages(2);
		expect(server.messages[1]).toMatchObject({
			type: "request",
			id: "request-1",
			target,
			call: { serviceId: "test", member: "mutate", args: [{ value: 42 }] },
		});

		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		await server.waitForMessages(3);
		expect(server.messages[2]).toEqual({
			type: "cancel",
			id: "request-1",
			target,
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: false,
			error: { code: "cancelled", message: "cancelled" },
		});
		expect(client.connected).toBe(true);
		await client.dispose();
	});

	test("rejects pending requests after disconnect or disposal", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const listing = client.listSessions();
		server.disconnect();
		await expect(listing).rejects.toBeInstanceOf(PiDisconnectedError);
		await client.dispose();
		await expect(client.listSessions()).rejects.toBeInstanceOf(PiClientDisposedError);
	});
});

describe("PiClient connection lifecycle", () => {
	test("rejects server data delivered before the client hello is sent", async () => {
		let closeCount = 0;
		let sendCount = 0;
		const client = new PiClient({
			serverId: "00000000-0000-4000-8000-000000000001",
			transportFactory: (handlers) => {
				handlers.onData(
					encodeServerMessage({
						type: "hello",
						version: PROTOCOL_VERSION,
						serverId: "00000000-0000-4000-8000-000000000001",
					}),
				);
				return {
					async send() {
						sendCount += 1;
					},
					close() {
						closeCount += 1;
					},
				};
			},
		});

		await expect(client.connect()).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: "Received server data before the client hello was sent",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(sendCount).toBe(0);
		expect(closeCount).toBe(1);
	});

	test("rejects typed handshake errors and closes the transport", async () => {
		let handlers: Parameters<ByteTransportFactory>[0];
		let closeCount = 0;
		const client = new PiClient({
			serverId: "00000000-0000-4000-8000-000000000001",
			transportFactory: (createdHandlers) => {
				handlers = createdHandlers;
				return {
					async send() {
						handlers.onData(
							encodeServerMessage({
								type: "hello_error",
								error: { code: "version", message: "Unsupported protocol version" },
							}),
						);
					},
					close() {
						closeCount += 1;
					},
				};
			},
		});

		await expect(client.connect()).rejects.toMatchObject({
			name: "PiServerError",
			code: "version",
			message: "Unsupported protocol version",
		});
		expect(client.connectionState).toBe("disconnected");
		expect(closeCount).toBe(1);
	});

	test("rejects pending requests and reconnects through a fresh transport", async () => {
		const first = new MemoryByteServer();
		const second = new MemoryByteServer();
		let connection = 0;
		const transportFactory: ByteTransportFactory = (handlers) =>
			(connection++ === 0 ? first : second).connect(handlers);
		const client = new PiClient({
			serverId: "00000000-0000-4000-8000-000000000001",
			transportFactory,
		});
		const states: string[] = [];
		client.onConnectionStateChange(({ state }) => states.push(state));
		await client.connect();
		const attaching = client.attachSession("session-1");
		await first.waitForMessages(2);
		first.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: { sessionId: "session-1", attachmentId: "attachment-1" },
		});
		await attaching;
		const pending = client.promptSession("session-1", "Hello");
		await first.waitForMessages(3);
		expect(first.messages[2]).toMatchObject({ call: { serviceId: "chat", member: "prompt" } });
		first.disconnect();

		await expect(pending).rejects.toBeInstanceOf(PiDisconnectedError);
		await expect(client.reconnect()).resolves.toMatchObject({
			serverId: "00000000-0000-4000-8000-000000000001",
		});
		expect(connection).toBe(2);
		expect(client.connected).toBe(true);
		expect(second.messages).toHaveLength(1);
		expect(states).toEqual(["connecting", "connected", "disconnected", "connecting", "connected"]);
		await client.dispose();
	});

	test("reports transport failures without leaving requests pending", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const pending = client.listSessions();
		await server.waitForMessages(2);
		server.error(new Error("read failed"));

		await expect(pending).rejects.toMatchObject({
			name: "PiDisconnectedError",
			message: "read failed",
			cause: expect.objectContaining({ message: "read failed" }),
		});
		expect(client.connectionState).toBe("disconnected");
	});

	test("disconnects on invalid or truncated server framing", async () => {
		const invalidServer = new MemoryByteServer();
		const invalidClient = await connectClient(invalidServer);
		invalidServer.sendRaw(encodeFrame(encodeCbor({ type: "response", id: "unknown", ok: true, result: 1 })));
		expect(invalidClient.connectionState).toBe("disconnected");

		const truncatedServer = new MemoryByteServer();
		const truncatedClient = await connectClient(truncatedServer);
		const pending = truncatedClient.listSessions();
		await truncatedServer.waitForMessages(2);
		truncatedServer.sendRaw(new Uint8Array([0, 0, 0, 2, 1]));
		truncatedServer.disconnect();

		await expect(pending).rejects.toMatchObject({
			name: "ProtocolValidationError",
			message: expect.stringMatching(/truncated/i),
		});
		expect(truncatedClient.connectionState).toBe("disconnected");
	});

	test("disconnects when a response has no matching request", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		server.send({
			type: "response",
			id: "unknown-request",
			ok: true,
			result: [],
		});

		expect(client.connectionState).toBe("disconnected");
		expect(server.clientCloseCount).toBe(1);
	});
});

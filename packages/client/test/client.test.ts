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

	test("addresses Session operations to the configured server", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const listing = client.listSessions();
		await server.waitForMessages(2);
		expect(server.messages[1]).toEqual({
			type: "request",
			id: "request-1",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "list", args: [] },
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: [{ id: "session-1", createdAt: 1, storageVersion: 1 }],
		});
		await expect(listing).resolves.toEqual([{ id: "session-1", createdAt: 1, storageVersion: 1 }]);

		const attaching = client.attachSession("session-1");
		await server.waitForMessages(3);
		expect(server.messages[2]).toMatchObject({
			type: "request",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "attach", args: ["session-1"] },
		});
		server.send({
			type: "response",
			id: "request-2",
			ok: true,
			result: { sessionId: "session-1" },
		});
		await expect(attaching).resolves.toEqual({ sessionId: "session-1" });

		const prompting = client.promptSession("session-1", "Hello");
		await server.waitForMessages(4);
		expect(server.messages[3]).toMatchObject({
			type: "request",
			serverId: "00000000-0000-4000-8000-000000000001",
			call: { method: "prompt", args: ["session-1", ["Hello"]] },
		});
		server.send({
			type: "response",
			id: "request-3",
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
		const calls = [
			client.promptSession("session-1", "text"),
			client.promptSession("session-1", "image", [{ type: "image", data: "aW1n", mimeType: "image/png" }]),
			client.promptSession("session-1", { role: "user", content: "message", timestamp: 1 }),
			client.promptSession("session-1", [
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "user", content: "second", timestamp: 2 },
			]),
		];
		await server.waitForMessages(5);
		expect(
			server.messages.slice(1).map((message) => (message.type === "request" ? message.call : undefined)),
		).toEqual([
			{ method: "prompt", args: ["session-1", ["text"]] },
			{
				method: "prompt",
				args: ["session-1", ["image", [{ type: "image", data: "aW1n", mimeType: "image/png" }]]],
			},
			{ method: "prompt", args: ["session-1", [{ role: "user", content: "message", timestamp: 1 }]] },
			{
				method: "prompt",
				args: [
					"session-1",
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
				id: `request-${index + 1}`,
				ok: true,
				result: { ok: false, error: { _tag: "Closed", message: "closed" } },
			});
		}
		await expect(Promise.all(calls)).resolves.toHaveLength(4);
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
			result: { sessionId: "session-1" },
		});
		server.send({
			type: "response",
			id: "request-1",
			ok: true,
			result: [],
		});
		await expect(Promise.all([first, second])).resolves.toEqual([[], { sessionId: "session-1" }]);
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
		const pending = client.promptSession("session-1", "Hello");
		await first.waitForMessages(2);
		expect(first.messages[1]).toMatchObject({ call: { method: "prompt" } });
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

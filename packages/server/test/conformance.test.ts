import { afterEach, describe, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { PiServer } from "../src/server.ts";
import { ProtocolTestClient, TestServerService, type WireChannel } from "../src/testing/index.ts";

const servers = new Set<PiServer>();

function createServer(service: TestServerService, serviceId = "00000000000000000000000000000001"): PiServer {
	const server = new PiServer(service, { listeners: [], serviceId });
	servers.add(server);
	return server;
}

function connect(server: PiServer): ProtocolTestClient {
	let handler: ByteConnectionHandler;
	let client: ProtocolTestClient;
	let closed = false;
	const connection: ByteConnection = {
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close(finalChunk) {
			if (finalChunk) client.receive(finalChunk);
			closed = true;
			client.markClosed();
		},
	};
	const channel: WireChannel = {
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			if (closed) return;
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	};
	client = new ProtocolTestClient(channel);
	handler = server.accept(connection);
	return client;
}

afterEach(async () => {
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
});

describe("list and attach protocol", () => {
	test("handshake identifies the logical service without listing sessions", async () => {
		const service = new TestServerService();
		await service.seed();
		const client = connect(createServer(service));

		expect(await client.hello()).toMatchObject({ type: "hello", serviceId: "00000000000000000000000000000001" });
		expect(service.harnesses.size).toBe(0);
	});

	test("list returns SessionRepo metadata without opening a session", async () => {
		const service = new TestServerService();
		const metadata = await service.seed("session-1", "parent-1");
		const client = connect(createServer(service));
		await client.hello();

		await expect(client.request("00000000000000000000000000000001", { method: "list", args: [] })).resolves.toEqual({
			type: "response",
			id: "request-1",
			ok: true,
			result: [metadata],
		});
		expect(service.harnesses.size).toBe(0);
	});

	test("attach opens the Session and creates one hosted Harness", async () => {
		const service = new TestServerService();
		await service.seed("session-1");
		const server = createServer(service);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);

		const delay = service.delayNextList();
		const firstAttach = first.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] });
		await delay.entered.promise;
		const secondAttach = second.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		delay.release.resolve(undefined);

		await expect(Promise.all([firstAttach, secondAttach])).resolves.toMatchObject([
			{ ok: true, result: { sessionId: "session-1" } },
			{ ok: true, result: { sessionId: "session-1" } },
		]);
		expect(service.harnesses.get("session-1")).toHaveLength(1);
		expect(server.hostedSessions.map(({ sessionId }) => sessionId)).toEqual(["session-1"]);
	});

	test("rejects requests addressed to another service before repository access", async () => {
		const service = new TestServerService();
		await service.seed("session-1");
		const client = connect(createServer(service));
		await client.hello();

		await expect(
			client.request("00000000000000000000000000000002", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "wrong_service" },
		});
		expect(service.harnesses.size).toBe(0);
	});

	test("reports an unknown session without creating a Harness", async () => {
		const service = new TestServerService();
		const client = connect(createServer(service));
		await client.hello();

		await expect(
			client.request("00000000000000000000000000000001", { method: "attach", args: ["missing"] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "session_not_found" },
		});
		expect(service.harnesses.size).toBe(0);
	});

	test("connection loss does not close a hosted Harness, but server shutdown does", async () => {
		const service = new TestServerService();
		await service.seed("session-1");
		const server = createServer(service);
		const client = connect(server);
		await client.hello();
		await client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] });
		const harness = service.latestHarness("session-1");

		await client.close();
		expect(harness.closeCount).toBe(0);
		await server.close();
		expect(harness.closeCount).toBe(1);
	});
});

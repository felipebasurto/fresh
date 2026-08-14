import { afterEach, describe, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { PiServer } from "../src/server.ts";
import { ProtocolTestClient, TestServerHost, type WireChannel } from "../src/testing/index.ts";

const servers = new Set<PiServer>();

function createServer(host: TestServerHost, serviceId = "00000000000000000000000000000001"): PiServer {
	const server = new PiServer(host, { listeners: [], serviceId });
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
		const host = new TestServerHost();
		await host.seed();
		const client = connect(createServer(host));

		expect(await client.hello()).toMatchObject({ type: "hello", serviceId: "00000000000000000000000000000001" });
		expect(host.harnesses.size).toBe(0);
	});

	test("list returns SessionRepo metadata without opening a session", async () => {
		const host = new TestServerHost();
		const metadata = await host.seed("session-1", "parent-1");
		const client = connect(createServer(host));
		await client.hello();

		await expect(client.request("00000000000000000000000000000001", { method: "list", args: [] })).resolves.toEqual({
			type: "response",
			id: "request-1",
			ok: true,
			result: [metadata],
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("attach opens the Session and creates one hosted Harness", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);

		const delay = host.delayNextList();
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
		expect(host.harnesses.get("session-1")).toHaveLength(1);
	});

	test("rejects requests addressed to another service before repository access", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();

		await expect(
			client.request("00000000000000000000000000000002", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "wrong_service" },
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("reports an unknown session without creating a Harness", async () => {
		const host = new TestServerHost();
		const client = connect(createServer(host));
		await client.hello();

		await expect(
			client.request("00000000000000000000000000000001", { method: "attach", args: ["missing"] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "session_not_found" },
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("invalidates a terminated Harness handle and allows a later attach", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] });
		const firstHarness = host.latestHarness("session-1");

		await firstHarness.terminate(new Error("worker crashed"));
		await firstHarness.terminated;

		await expect(
			client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.harnesses.get("session-1")).toHaveLength(2);
	});

	test("connection loss does not close a hosted Harness, but server shutdown does", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] });
		const harness = host.latestHarness("session-1");

		await client.close();
		expect(harness.closeCount).toBe(0);
		await server.close();
		expect(harness.closeCount).toBe(1);
	});
});

describe("server draining", () => {
	test("drains hosted sessions, acknowledges, and closes", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		const harness = host.latestHarness("session-1");

		await expect(
			client.request("00000000000000000000000000000001", { method: "drain", args: [] }),
		).resolves.toMatchObject({ ok: true, result: {} });
		await client.waitForClose();
		await server.closed;

		expect(harness.closeCount).toBe(1);
	});

	test("rejects a drain addressed to another service", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});

		await expect(
			client.request("00000000000000000000000000000002", { method: "drain", args: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: "wrong_service" } });

		expect(host.latestHarness("session-1").closeCount).toBe(0);
	});

	test("only the drain owner schedules shutdown", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const owner = connect(server);
		const concurrent = connect(server);
		await Promise.all([owner.hello(), concurrent.hello()]);
		await owner.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		const gate = host.latestHarness("session-1").gateNextClose();

		const draining = owner.request("00000000000000000000000000000001", { method: "drain", args: [] });
		await gate.entered.promise;
		await expect(
			concurrent.request("00000000000000000000000000000001", { method: "drain", args: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: "server_draining" } });
		expect(owner.closed).toBe(false);

		gate.release.resolve(undefined);
		await expect(draining).resolves.toMatchObject({ ok: true, result: {} });
		await server.closed;
	});

	test("rejects drain acknowledgement when any hosted Harness fails to close", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		await host.seed("session-2");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] });
		await client.request("00000000000000000000000000000001", { method: "attach", args: ["session-2"] });
		const failedHarness = host.latestHarness("session-1");
		const closedHarness = host.latestHarness("session-2");
		failedHarness.failClose = new Error("close failed");

		await expect(
			client.request("00000000000000000000000000000001", { method: "drain", args: [] }),
		).resolves.toMatchObject({ ok: false, error: { code: "internal_error" } });
		await expect(server.closed).rejects.toThrow(/Failed to close hosted Harnesses/);
		expect(failedHarness.closeCount).toBe(1);
		expect(closedHarness.closeCount).toBe(1);

		servers.delete(server);
		await failedHarness.close();
	});
});

describe("hosted Harness acquisition failures", () => {
	test("shares an opening failure and allows a later retry", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		host.failNextOpen = new Error("open failed");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);
		const gate = host.gateNextOpen();

		const firstAttach = first.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await gate.entered.promise;
		const secondAttach = second.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		gate.release.resolve(undefined);

		await expect(Promise.all([firstAttach, secondAttach])).resolves.toMatchObject([
			{ ok: false, error: { code: "internal_error" } },
			{ ok: false, error: { code: "internal_error" } },
		]);
		expect(host.openCount).toBe(1);

		await expect(
			first.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.openCount).toBe(2);
		expect(host.harnesses.get("session-1")).toHaveLength(1);
	});

	test("releases the opened Session when Harness creation fails", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		host.failNextHarness = new Error("harness failed");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();

		await expect(
			client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: false, error: { code: "internal_error" } });

		await expect(
			client.request("00000000000000000000000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.openCount).toBe(2);
		expect(host.harnesses.get("session-1")).toHaveLength(1);
	});

	test("closes a Harness acquired while server shutdown is in progress", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const gate = host.gateNextOpen();
		const attach = client.request("00000000000000000000000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await gate.entered.promise;
		const closing = server.close();
		gate.release.resolve(undefined);

		await closing;
		await expect(attach).rejects.toThrow(/closed/i);
		expect(host.latestHarness("session-1").closeCount).toBe(1);
	});
});

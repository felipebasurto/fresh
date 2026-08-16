import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { PiServer } from "../src/server.ts";
import { ProtocolTestClient, TestServerHost, type WireChannel } from "../src/testing/index.ts";
import type { PiServerHost } from "../src/types.ts";

const servers = new Set<PiServer>();

function createServer(host: TestServerHost, serverId = "00000000-0000-4000-8000-000000000001"): PiServer {
	const server = new PiServer(host, { listeners: [], serverId });
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

describe("Session protocol", () => {
	test("handshake identifies the logical server without listing sessions", async () => {
		const host = new TestServerHost();
		await host.seed();
		const client = connect(createServer(host));

		expect(await client.hello()).toMatchObject({ type: "hello", serverId: "00000000-0000-4000-8000-000000000001" });
		expect(host.harnesses.size).toBe(0);
	});

	test("list returns SessionRepo metadata without opening a session", async () => {
		const host = new TestServerHost();
		const metadata = await host.seed("session-1", "parent-1");
		const client = connect(createServer(host));
		await client.hello();

		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "list", args: [] }),
		).resolves.toEqual({
			type: "response",
			id: "request-1",
			ok: true,
			result: [metadata],
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("attach passes concrete repository metadata to the Harness host", async () => {
		type BackendMetadata = SessionMetadata & { path: string; modifiedAt: number };
		const metadata: BackendMetadata = {
			id: "session-1",
			createdAt: 1,
			storageVersion: 1,
			cwd: "/workspace",
			path: "/sessions/session-1.jsonl",
			modifiedAt: 2,
		};
		let received: BackendMetadata | undefined;
		const host: PiServerHost<BackendMetadata> = {
			sessions: { list: async () => [metadata] },
			createHarness: async (candidate) => {
				received = candidate;
				return {
					prompt: async () => ({
						ok: true,
						value: { kind: "completed", runId: "run-1", leafId: "leaf-1" },
					}),
					close: async () => {},
				};
			},
		};
		const server = new PiServer(host, {
			listeners: [],
			serverId: "00000000-0000-4000-8000-000000000001",
		});
		servers.add(server);
		const client = connect(server);
		await client.hello();

		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "list", args: [] }),
		).resolves.toEqual({
			type: "response",
			id: "request-1",
			ok: true,
			result: [
				{
					id: "session-1",
					createdAt: 1,
					storageVersion: 1,
					cwd: "/workspace",
				},
			],
		});
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(received).toBe(metadata);
	});

	test("permits only one client attachment per Session", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);

		await expect(
			first.request("00000000-0000-4000-8000-000000000001", {
				method: "attach",
				args: ["session-1"],
			}),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		await expect(
			first.request("00000000-0000-4000-8000-000000000001", {
				method: "attach",
				args: ["session-1"],
			}),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.latestHarness("session-1").attachedClients).toBe(1);
		await expect(
			second.request("00000000-0000-4000-8000-000000000001", {
				method: "attach",
				args: ["session-1"],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "session_in_use" } });
		expect(host.harnesses.get("session-1")).toHaveLength(1);
		expect(host.latestHarness("session-1").attachedClients).toBe(1);

		await first.close();
		await expect.poll(() => host.latestHarness("session-1").attachedClients).toBe(0);
		await expect(
			second.request("00000000-0000-4000-8000-000000000001", {
				method: "attach",
				args: ["session-1"],
			}),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
	});

	test("requires the requesting client to hold the targeted Session attachment", async () => {
		const host = new TestServerHost();
		await Promise.all([host.seed("session-1"), host.seed("session-2")]);
		const server = createServer(host);
		const attached = connect(server);
		const unattached = connect(server);
		await Promise.all([attached.hello(), unattached.hello()]);

		await expect(
			unattached.request("00000000-0000-4000-8000-000000000001", {
				method: "prompt",
				args: ["session-1", ["Hello"]],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "session_not_attached" } });
		await attached.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await expect(
			attached.request("00000000-0000-4000-8000-000000000001", {
				method: "prompt",
				args: ["session-2", ["Hello"]],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "session_not_attached" } });

		await expect(
			attached.request("00000000-0000-4000-8000-000000000001", {
				method: "prompt",
				args: ["session-1", ["Hello"]],
			}),
		).resolves.toEqual({
			type: "response",
			id: "request-3",
			ok: true,
			result: { ok: true, value: { kind: "completed", runId: "run-1", leafId: "leaf-1" } },
		});
		expect(host.latestHarness("session-1").promptCalls).toEqual([["Hello"]]);
	});

	test("preserves structural Harness failures and bounds adapter defects", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		const harness = host.latestHarness("session-1");
		harness.nextPromptResult = { ok: false, error: { _tag: "Closed", message: "Harness closed" } };
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", {
				method: "prompt",
				args: ["session-1", ["Hello"]],
			}),
		).resolves.toMatchObject({
			ok: true,
			result: { ok: false, error: { _tag: "Closed", message: "Harness closed" } },
		});

		harness.nextPromptError = new Error("private adapter detail");
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", {
				method: "prompt",
				args: ["session-1", ["Hello"]],
			}),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "internal_error", message: "Internal server error" },
		});
	});

	test("admits concurrent prompts so the Harness owns lane-busy semantics", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		const harness = host.latestHarness("session-1");
		const gate = harness.gateNextPrompt();
		const first = client.request("00000000-0000-4000-8000-000000000001", {
			method: "prompt",
			args: ["session-1", ["first"]],
		});
		await gate.entered.promise;
		const second = client.request("00000000-0000-4000-8000-000000000001", {
			method: "prompt",
			args: ["session-1", ["second"]],
		});

		await expect(second).resolves.toMatchObject({ ok: true, result: { ok: true } });
		expect(harness.promptCalls).toEqual([["first"], ["second"]]);
		gate.release.resolve(undefined);
		await expect(first).resolves.toMatchObject({ ok: true, result: { ok: true } });
	});

	test("keeps attachment demand until an accepted prompt settles after disconnect", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		const harness = host.latestHarness("session-1");
		const gate = harness.gateNextPrompt();
		const prompting = client.request("00000000-0000-4000-8000-000000000001", {
			method: "prompt",
			args: ["session-1", ["Hello"]],
		});
		const disconnectedPrompt = expect(prompting).rejects.toThrow(/closed/i);
		await gate.entered.promise;

		await client.close();
		expect(harness.attachedClients).toBe(1);
		gate.release.resolve(undefined);
		await disconnectedPrompt;
		await expect.poll(() => harness.attachedClients).toBe(0);
		expect(harness.promptCalls).toEqual([["Hello"]]);
	});

	test("rejects requests addressed to another server before repository access", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();

		await expect(
			client.request("00000000-0000-4000-8000-000000000002", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "wrong_server" },
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("reports an unknown session without creating a Harness", async () => {
		const host = new TestServerHost();
		const client = connect(createServer(host));
		await client.hello();

		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["missing"] }),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "session_not_found" },
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("rejects an ambiguous session ID without creating a Harness", async () => {
		type BackendMetadata = SessionMetadata & { path: string };
		const host: PiServerHost<BackendMetadata> = {
			sessions: {
				list: async () => [
					{ id: "duplicate", createdAt: 1, storageVersion: 1, cwd: "/one", path: "/one/session.jsonl" },
					{ id: "duplicate", createdAt: 2, storageVersion: 1, cwd: "/two", path: "/two/session.jsonl" },
				],
			},
			createHarness: async () => {
				throw new Error("must not create a Harness for an ambiguous session");
			},
		};
		const server = new PiServer(host, {
			listeners: [],
			serverId: "00000000-0000-4000-8000-000000000001",
		});
		servers.add(server);
		const client = connect(server);
		await client.hello();

		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["duplicate"] }),
		).resolves.toMatchObject({ ok: false, error: { code: "session_ambiguous" } });
	});

	test("invalidates a terminated Harness handle and allows a later attach", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] });
		const firstHarness = host.latestHarness("session-1");

		await firstHarness.terminate(new Error("worker crashed"));
		await firstHarness.terminated;

		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.harnesses.get("session-1")).toHaveLength(2);
	});

	test("connection loss releases its attachment, while server shutdown closes the Harness", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		await client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] });
		const harness = host.latestHarness("session-1");

		await client.close();
		await expect.poll(() => harness.attachedClients).toBe(0);
		expect(harness.closeCount).toBe(0);
		await server.close();
		expect(harness.closeCount).toBe(1);
	});
});

describe("hosted Harness acquisition failures", () => {
	test("shares a Harness creation failure, releases the Session, and allows a later retry", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		host.nextCreateHarnessError = new Error("Harness creation failed");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);
		const gate = host.gateNextCreateHarness();

		const firstAttach = first.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await gate.entered.promise;
		const secondAttach = second.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		gate.release.resolve(undefined);

		await expect(Promise.all([firstAttach, secondAttach])).resolves.toMatchObject([
			{ ok: false, error: { code: "internal_error" } },
			{ ok: false, error: { code: "internal_error" } },
		]);
		expect(host.createHarnessCount).toBe(1);

		await expect(
			first.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.createHarnessCount).toBe(2);
		expect(host.harnesses.get("session-1")).toHaveLength(1);
	});

	test("closes a Harness acquired while server shutdown is in progress", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const gate = host.gateNextCreateHarness();
		const attach = client.request("00000000-0000-4000-8000-000000000001", {
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

	test("fails shutdown when an in-flight acquisition cannot release its Harness", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const cleanupError = new Error("close failed");
		host.nextHarnessCloseError = cleanupError;
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const gate = host.gateNextCreateHarness();
		const attach = client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await gate.entered.promise;

		const closing = server.close();
		gate.release.resolve(undefined);

		await expect(closing).rejects.toThrow(/Failed to close hosted Harnesses/);
		await expect(server.closed).rejects.toThrow(/Failed to close hosted Harnesses/);
		await expect(attach).rejects.toThrow(/closed/i);
		expect(host.latestHarness("session-1").closeCount).toBe(1);

		servers.delete(server);
		await host.latestHarness("session-1").close();
	});
});

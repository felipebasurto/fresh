import { BACKGROUND_CONTEXT, type SessionMetadata } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import type { ByteConnection, ByteConnectionHandler } from "../src/connection.ts";
import { Server } from "../src/server.ts";
import { Deferred, ProtocolTestClient, TestServerHost, type WireChannel } from "../src/testing/index.ts";
import type { ServerHost } from "../src/types.ts";

const servers = new Set<Server>();

function createServer(host: ServerHost, serverId = "00000000-0000-4000-8000-000000000001"): Server {
	const server = new Server(host, { listeners: [], serverId });
	servers.add(server);
	return server;
}

function connect(server: Server): ProtocolTestClient {
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

	test("list returns presentation-safe summaries without opening a Session", async () => {
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
			result: [
				{
					serverId: "00000000-0000-4000-8000-000000000001",
					sessionId: metadata.id,
					createdAt: metadata.createdAt,
				},
			],
		});
		expect(host.harnesses.size).toBe(0);
	});

	test("create persists a Session without opening a Harness", async () => {
		const host = new TestServerHost();
		const client = connect(createServer(host));
		await client.hello();

		await expect(
			client.request("00000000-0000-4000-8000-000000000001", {
				method: "create",
				args: [{ id: "session-1" }],
			}),
		).resolves.toMatchObject({
			ok: true,
			result: {
				serverId: "00000000-0000-4000-8000-000000000001",
				sessionId: "session-1",
				createdAt: 1,
			},
		});
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "list", args: [] }),
		).resolves.toMatchObject({ result: [{ sessionId: "session-1" }] });
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
		const host: ServerHost<BackendMetadata> = {
			sessions: { list: async () => [metadata], create: async () => metadata },
			openSession: async (candidate) => {
				received = candidate;
				return {
					attachClient: async () => ({
						prompt: async () => ({
							ok: true,
							value: {
								operationId: "run-1",
								kind: "run" as const,
								status: "completed" as const,
								fromTipId: null,
								tipId: "leaf-1",
								startedAt: 1,
								endedAt: 2,
							},
						}),
						release: () => {},
					}),
					close: async () => {},
				};
			},
		};
		const server = new Server(host, {
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
					serverId: "00000000-0000-4000-8000-000000000001",
					sessionId: "session-1",
					createdAt: 1,
				},
			],
		});
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(received).toBe(metadata);
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", { method: "watch", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: false, error: { code: "not_supported" } });
	});

	test("routes opaque server services and publishes attachment changes out of band", async () => {
		const backing = new TestServerHost();
		await backing.seed("session-1");
		let releaseCount = 0;
		const host: ServerHost = {
			sessions: backing.sessions,
			openSession: (metadata, context) => backing.openSession(metadata, context),
			serverServices: {
				attachClient(presentation) {
					return {
						async invokeService(call, _publish, context) {
							if (call.serviceId !== "pi.session-management") throw new Error("Unexpected service");
							if (call.member === "attach" && typeof call.args[0] === "string") {
								await presentation.attachSession(call.args[0], context);
								return undefined;
							}
							if (call.member === "detach") {
								await presentation.detachSession(context);
								return undefined;
							}
							throw new Error("Unexpected service member");
						},
						release() {
							releaseCount += 1;
						},
					};
				},
			},
		};
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const attached = client.next((message) => message.type === "attachment" && message.attachment !== null);
		const attachResponse = client.next((message) => message.type === "response" && message.id === "service-attach");
		await client.sendMessage({
			type: "request",
			id: "service-attach",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-management", member: "attach", args: ["session-1"] },
		});
		await expect(attached).resolves.toMatchObject({
			type: "attachment",
			attachment: { sessionId: "session-1", attachmentId: expect.any(String) },
		});
		await expect(attachResponse).resolves.toEqual({
			type: "response",
			id: "service-attach",
			ok: true,
		});
		expect(backing.latestHarness("session-1").attachedClients).toBe(1);

		const detached = client.next((message) => message.type === "attachment" && message.attachment === null);
		const detachResponse = client.next((message) => message.type === "response" && message.id === "service-detach");
		await client.sendMessage({
			type: "request",
			id: "service-detach",
			target: { serverId: "00000000-0000-4000-8000-000000000001" },
			call: { serviceId: "pi.session-management", member: "detach", args: [] },
		});
		await expect(detached).resolves.toMatchObject({ type: "attachment", attachment: null });
		await expect(detachResponse).resolves.toEqual({
			type: "response",
			id: "service-detach",
			ok: true,
		});
		expect(backing.latestHarness("session-1").attachedClients).toBe(0);
		await client.close();
		await expect.poll(() => releaseCount).toBe(1);
	});

	test("delivers a lane snapshot before buffered and live watch events", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const client = connect(createServer(host));
		await client.hello();
		await client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});

		const watched = await client.request("00000000-0000-4000-8000-000000000001", {
			method: "watch",
			args: ["session-1"],
		});
		expect(watched).toMatchObject({
			ok: true,
			result: { snapshot: { lane: "main", transcript: [], operation: null } },
		});
		if (
			!watched.ok ||
			typeof watched.result !== "object" ||
			watched.result === null ||
			!("watchId" in watched.result)
		) {
			throw new Error("Missing watch result");
		}
		const watchId = watched.result.watchId;
		if (typeof watchId !== "string") throw new Error("Invalid watch ID");
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", {
				method: "watch",
				args: ["session-1"],
			}),
		).resolves.toMatchObject({ ok: false, error: { code: "watch_in_use" } });
		await host.latestHarness("session-1").emitEvent({
			type: "run_start",
			lane: "main",
			runId: "run-1",
			startedAt: 1,
		});
		expect(client.messages.some((message) => message.type === "event")).toBe(false);

		const messageIndex = client.messages.length;
		const starting = client.request("00000000-0000-4000-8000-000000000001", {
			method: "startWatch",
			args: ["session-1", watchId],
		});
		await expect(client.nextFrom(messageIndex, (message) => message.type === "event")).resolves.toMatchObject({
			type: "event",
			watchId,
			event: { type: "run_start", runId: "run-1" },
		});
		await expect(starting).resolves.toMatchObject({ ok: true, result: { watchId } });
		await expect(
			client.request("00000000-0000-4000-8000-000000000001", {
				method: "resnapshotWatch",
				args: ["session-1", watchId],
			}),
		).resolves.toMatchObject({ ok: true, result: { watchId, snapshot: { lane: "main" } } });

		await host.latestHarness("session-1").emitEvent({
			type: "message_start",
			lane: "main",
			runId: "run-1",
			message: { role: "user", content: "hello", timestamp: 1 },
		});
		await expect(client.nextFrom(messageIndex + 1, (message) => message.type === "event")).resolves.toMatchObject({
			event: { type: "message_start" },
		});

		await client.request("00000000-0000-4000-8000-000000000001", {
			method: "stopWatch",
			args: ["session-1", watchId],
		});
		const stoppedAt = client.messages.length;
		await host.latestHarness("session-1").emitEvent({
			type: "run_resume",
			lane: "main",
			runId: "run-1",
		});
		expect(client.messages.slice(stoppedAt).some((message) => message.type === "event")).toBe(false);
	});

	test("permits multiple client attachments per Session", async () => {
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
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.harnesses.get("session-1")).toHaveLength(1);
		expect(host.latestHarness("session-1").attachedClients).toBe(2);

		await first.close();
		await expect.poll(() => host.latestHarness("session-1").attachedClients).toBe(1);
		await expect(
			second.request("00000000-0000-4000-8000-000000000001", {
				method: "attach",
				args: ["session-1"],
			}),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
	});

	test("clears connection ownership when attachment release fails", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const errors: Error[] = [];
		const server = new Server(host, {
			listeners: [],
			serverId: "00000000-0000-4000-8000-000000000001",
			onError: (error) => errors.push(error),
		});
		servers.add(server);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);
		await first.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		const harness = host.latestHarness("session-1");
		const releaseError = new Error("release failed");
		harness.failAttachmentRelease = releaseError;

		await first.close();
		await expect.poll(() => harness.attachmentReleaseCount).toBe(1);
		await expect.poll(() => errors).toContain(releaseError);
		harness.failAttachmentRelease = undefined;
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
			result: {
				ok: true,
				value: {
					operationId: "run-1",
					kind: "run",
					status: "completed",
					fromTipId: null,
					tipId: "leaf-1",
					startedAt: 1,
					endedAt: 2,
				},
			},
		});
		expect(host.latestHarness("session-1").promptCalls).toEqual([["Hello"]]);
	});

	test("rejects a stale attachment route after switching Sessions", async () => {
		const host = new TestServerHost();
		await Promise.all([host.seed("session-1"), host.seed("session-2")]);
		const client = connect(createServer(host));
		const serverId = "00000000-0000-4000-8000-000000000001";
		await client.hello();
		const first = await client.request(serverId, { method: "attach", args: ["session-1"] });
		if (
			!first.ok ||
			typeof first.result !== "object" ||
			first.result === null ||
			!("attachmentId" in first.result) ||
			typeof first.result.attachmentId !== "string"
		) {
			throw new Error("Missing first attachment ID");
		}
		await client.request(serverId, { method: "attach", args: ["session-2"] });

		const response = client.next((message) => message.type === "response" && message.id === "stale-request");
		await client.sendMessage({
			type: "request",
			id: "stale-request",
			target: { serverId, sessionId: "session-1", attachmentId: first.result.attachmentId },
			call: { serviceId: "pi.chat", member: "prompt", args: [["stale"]] },
		});
		await expect(response).resolves.toMatchObject({
			type: "response",
			ok: false,
			error: { code: "session_not_attached" },
		});
		expect(host.latestHarness("session-1").promptCalls).toEqual([]);
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
		const host: ServerHost<BackendMetadata> = {
			sessions: {
				list: async () => [
					{ id: "duplicate", createdAt: 1, storageVersion: 1, cwd: "/one", path: "/one/session.jsonl" },
					{ id: "duplicate", createdAt: 2, storageVersion: 1, cwd: "/two", path: "/two/session.jsonl" },
				],
				create: async () => {
					throw new Error("must not create a Session in this test");
				},
			},
			openSession: async () => {
				throw new Error("must not create a Harness for an ambiguous session");
			},
		};
		const server = new Server(host, {
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
		await expect.poll(() => firstHarness.attachedClients).toBe(0);
		expect(firstHarness.attachmentReleaseCount).toBe(1);

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

describe("routed Session acquisition failures", () => {
	test("releases a lease acquired concurrently with Harness termination", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: 1, storageVersion: 1 };
		const acquiring = new Deferred<void>();
		const continueAcquiring = new Deferred<void>();
		const terminated = new Deferred<Error | undefined>();
		let releaseCount = 0;
		const host: ServerHost = {
			sessions: { list: async () => [metadata], create: async () => metadata },
			openSession: async () => ({
				terminated: terminated.promise,
				attachClient: async () => {
					acquiring.resolve(undefined);
					await continueAcquiring.promise;
					return {
						prompt: async () => ({
							ok: true,
							value: {
								operationId: "run-1",
								kind: "run" as const,
								status: "completed" as const,
								fromTipId: null,
								tipId: "leaf-1",
								startedAt: 1,
								endedAt: 2,
							},
						}),
						release: () => {
							releaseCount += 1;
						},
					};
				},
				close: async () => {},
			}),
		};
		const server = new Server(host, {
			listeners: [],
			serverId: "00000000-0000-4000-8000-000000000001",
		});
		servers.add(server);
		const client = connect(server);
		await client.hello();
		const attach = client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await acquiring.promise;

		terminated.resolve(new Error("worker crashed"));
		continueAcquiring.resolve(undefined);
		await expect(attach).resolves.toMatchObject({ ok: false, error: { code: "server_draining" } });
		expect(releaseCount).toBe(1);
	});

	test("shares a Harness creation failure, releases the Session, and allows a later retry", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		host.nextOpenSessionError = new Error("Harness creation failed");
		const server = createServer(host);
		const first = connect(server);
		const second = connect(server);
		await Promise.all([first.hello(), second.hello()]);
		const gate = host.gateNextOpenSession();

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
		expect(host.openSessionCount).toBe(1);

		await expect(
			first.request("00000000-0000-4000-8000-000000000001", { method: "attach", args: ["session-1"] }),
		).resolves.toMatchObject({ ok: true, result: { sessionId: "session-1" } });
		expect(host.openSessionCount).toBe(2);
		expect(host.harnesses.get("session-1")).toHaveLength(1);
	});

	test("closes a Harness acquired while server shutdown is in progress", async () => {
		const host = new TestServerHost();
		await host.seed("session-1");
		const server = createServer(host);
		const client = connect(server);
		await client.hello();
		const gate = host.gateNextOpenSession();
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
		const gate = host.gateNextOpenSession();
		const attach = client.request("00000000-0000-4000-8000-000000000001", {
			method: "attach",
			args: ["session-1"],
		});
		await gate.entered.promise;

		const closing = server.close();
		gate.release.resolve(undefined);

		await expect(closing).rejects.toThrow(/Failed to close routed Sessions/);
		await expect(server.closed).rejects.toThrow(/Failed to close routed Sessions/);
		await expect(attach).rejects.toThrow(/closed/i);
		expect(host.latestHarness("session-1").closeCount).toBe(1);

		servers.delete(server);
		await host.latestHarness("session-1").close(BACKGROUND_CONTEXT);
	});
});

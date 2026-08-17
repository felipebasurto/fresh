import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runClient } from "../src/experimental/client.ts";
import * as processRuntime from "../src/experimental/process.ts";
import { activateServer, type RunningServer, startServer } from "../src/experimental/server.ts";
import {
	configureExperimentalWorkerModel,
	createExperimentalSessions,
	readExperimentalSessionState,
} from "./experimental-session-support.ts";

const servers = new Set<RunningServer>();
const clients = new Set<PiClient>();
const directories = new Set<string>();
const fauxWorkerEntryUrl = new URL("fixtures/faux-session-worker.ts", import.meta.url);
const realSpawnInternalProcess = processRuntime.spawnInternalProcess;
const sessionWorkerModel = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;
let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join("/tmp", "pi-experimental-agent-"));
	directories.add(agentDir);
	await configureExperimentalWorkerModel(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	await createExperimentalSessions(join(agentDir, "experimental", "sessions"), ["demo-1", "demo-2"]);
});

async function makeServer(): Promise<{ directory: string; runtime: RunningServer }> {
	const directory = await mkdtemp(join("/tmp", "pes-"));
	directories.add(directory);
	const runtime = await startServer({ ...sessionWorkerModel, directory });
	servers.add(runtime);
	return { directory, runtime };
}

async function attachClient(runtime: RunningServer, sessionId: string): Promise<PiClient> {
	const client = await PiClient.connect({
		serverId: runtime.serverId,
		transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
	});
	clients.add(client);
	await client.attachSession(sessionId);
	return client;
}

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.dispose()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	vi.unstubAllEnvs();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("experimental durable server composition", () => {
	test("resolves the configured session directory", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startServer({ directory, sessionDir: "relative/sessions" });
		servers.add(runtime);

		expect(runtime.sessionDir).toBe(resolve("relative/sessions"));
		expect(runtime.workerPids.size).toBe(0);
	});

	test("uses PI_SERVER_DIR and PI_SERVER_ID", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-server-dir-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);
		const runtime = await startServer();
		servers.add(runtime);

		expect(runtime.serverId).toBe(serverId);
		expect(runtime.socketPath).toBe(join(directory, `${serverId}.sock`));
		expect((await lstat(directory)).mode & 0o777).toBe(0o700);
		const publicSocket = await lstat(runtime.socketPath);
		const controlSocket = await lstat(join(directory, `control-${runtime.serverId}.sock`));
		expect(publicSocket.isSocket()).toBe(true);
		expect(publicSocket.mode & 0o777).toBe(0o600);
		expect(controlSocket.isSocket()).toBe(true);
		expect(controlSocket.mode & 0o777).toBe(0o600);
		const entries = await readdir(directory);
		expect(entries).toHaveLength(3);
		expect(entries.every((entry) => !entry.startsWith("."))).toBe(true);
		expect(entries).toContain(`${serverId}.sock`);
		expect(entries).toContain(`control-${serverId}.sock`);
		expect(entries).toContainEqual(expect.stringMatching(new RegExp(`^server-${serverId}-[0-9a-f]{12}\\.sock$`)));
		await expect(runClient({ command: "client" })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
	});

	test("rejects a provider without a model", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		await expect(startServer({ directory, provider: "anthropic" })).rejects.toThrow("provider requires a model");
	});

	test("uses legacy model selection when the server model is omitted", async () => {
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" }),
		);
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startServer({ directory });
		servers.add(runtime);

		const client = await attachClient(runtime, "demo-1");
		await client.dispose();
		clients.delete(client);
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);
		const state = await readExperimentalSessionState(runtime.sessionDir, "demo-1");
		expect(state.model).toEqual({ provider: "anthropic", modelId: "claude-opus-4-6" });
		expect(state.activeTools).toEqual(["read", "write", "bash"]);
	});

	test("applies an explicit model when opening an existing Session", async () => {
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" }),
		);
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const first = await startServer({ directory });
		servers.add(first);
		const firstClient = await attachClient(first, "demo-1");
		await firstClient.dispose();
		clients.delete(firstClient);
		await expect.poll(() => first.workerPids.has("demo-1")).toBe(false);
		await first.close();

		const second = await startServer({ ...sessionWorkerModel, directory });
		servers.add(second);
		const secondClient = await attachClient(second, "demo-1");
		await secondClient.dispose();
		clients.delete(secondClient);
		await expect.poll(() => second.workerPids.has("demo-1")).toBe(false);
		const state = await readExperimentalSessionState(second.sessionDir, "demo-1");
		expect(state.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	test.each(["discovery", "explicit connection"] as const)(
		"rejects model options when %s selects an existing server",
		async (connection) => {
			const { directory, runtime } = await makeServer();
			await expect(
				runClient(
					{
						command: "client",
						model: "anthropic/claude-opus-4-6",
						...(connection === "explicit connection"
							? { connect: { transport: "unix" as const, path: runtime.socketPath } }
							: {}),
					},
					{ directory },
				),
			).rejects.toThrow("Model selection is only valid when automatically activating a new server");
		},
	);

	test("rejects model options when serialized activation finds an existing server", async () => {
		const { directory, runtime } = await makeServer();
		await expect(
			activateServer({
				directory,
				requestedServerId: runtime.serverId,
				sessionDir: runtime.sessionDir,
				model: "anthropic/claude-opus-4-6",
			}),
		).rejects.toThrow("Model selection is only valid when automatically activating a new server");
	});

	test("serializes concurrent cold activation and retires after both clients leave", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-auto-server-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);

		const results = await Promise.all([runClient({ command: "client" }), runClient({ command: "client" })]);
		expect(results).toEqual([
			{
				kind: "list",
				sessions: [
					{ serverId, sessionId: "demo-1" },
					{ serverId, sessionId: "demo-2" },
				],
			},
			{
				kind: "list",
				sessions: [
					{ serverId, sessionId: "demo-1" },
					{ serverId, sessionId: "demo-2" },
				],
			},
		]);
		expect(await pathExists(join(directory, `${serverId}.sock`))).toBe(true);
		await expect.poll(() => pathExists(join(directory, `${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
		await expect.poll(() => pathExists(join(directory, `control-${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
	});

	test("retires a cold server after its only Session attachment disconnects", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-auto-session-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);

		await expect(runClient({ command: "client", sessionId: "demo-1", ...sessionWorkerModel })).resolves.toEqual({
			kind: "attached",
			serverId,
			sessionId: "demo-1",
		});
		await expect.poll(() => pathExists(join(directory, `${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
		await expect.poll(() => pathExists(join(directory, `control-${serverId}.sock`)), { timeout: 5_000 }).toBe(false);
	});

	test("runs and discovers multiple logical servers from one directory", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-multi-server-"));
		directories.add(directory);
		const firstId = "00000000-0000-4000-8000-000000000001";
		const secondId = "00000000-0000-4000-8000-000000000002";
		const [first, second] = await Promise.all([
			startServer({ directory, serverId: firstId }),
			startServer({ directory, serverId: secondId }),
		]);
		servers.add(first);
		servers.add(second);

		expect((await lstat(join(directory, `control-${firstId}.sock`))).isSocket()).toBe(true);
		expect((await lstat(join(directory, `control-${secondId}.sock`))).isSocket()).toBe(true);
		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serverId: firstId, sessionId: "demo-1" },
				{ serverId: firstId, sessionId: "demo-2" },
				{ serverId: secondId, sessionId: "demo-1" },
				{ serverId: secondId, sessionId: "demo-2" },
			],
		});

		await first.close();
		await expect.poll(() => pathExists(first.socketPath)).toBe(false);
		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serverId: secondId, sessionId: "demo-1" },
				{ serverId: secondId, sessionId: "demo-2" },
			],
		});
	});

	test("discovers and lists seeded sessions without hosting either session", async () => {
		const { directory, runtime } = await makeServer();

		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serverId: runtime.serverId, sessionId: "demo-1" },
				{ serverId: runtime.serverId, sessionId: "demo-2" },
			],
		});
		expect(runtime.workerPids.size).toBe(0);
		const socket = await lstat(runtime.socketPath);
		expect(socket.mode & 0o777).toBe(0o600);
	});

	test("keeps one worker for one connection-scoped Session attachment", async () => {
		const { runtime } = await makeServer();
		const client = await attachClient(runtime, "demo-1");

		expect([...runtime.workerPids.keys()]).toEqual(["demo-1"]);
		const firstPid = runtime.workerPids.get("demo-1");
		expect(firstPid).toEqual(expect.any(Number));
		await expect(client.attachSession("demo-1")).resolves.toEqual({ sessionId: "demo-1" });
		expect(runtime.workerPids.get("demo-1")).toBe(firstPid);

		const competing = await PiClient.connect({
			serverId: runtime.serverId,
			transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
		});
		clients.add(competing);
		await expect(competing.attachSession("demo-1")).rejects.toMatchObject({ code: "session_in_use" });
	});

	// WP00 intentionally selects execution-incomplete runtime2. Re-enable with the no-tool run package.
	test.skip("creates generated and requested Sessions for one-shot prompts", async ({ onTestFinished }) => {
		const spawn = vi
			.spyOn(processRuntime, "spawnInternalProcess")
			.mockImplementation((role, args, options) =>
				realSpawnInternalProcess(
					role,
					args,
					role === "session-worker" ? { ...options, entryUrl: fauxWorkerEntryUrl } : options,
				),
			);
		onTestFinished(() => spawn.mockRestore());
		const { directory, runtime } = await makeServer();
		const prompt = (sessionId?: string) =>
			runClient(
				{ command: "client", prompt: "question", ...(sessionId === undefined ? {} : { sessionId }) },
				{ directory },
			);

		const generated = await prompt();
		expect(generated).toMatchObject({
			kind: "prompted",
			serverId: runtime.serverId,
			sessionId: expect.any(String),
			text: "deterministic remote answer",
		});
		const requested = await prompt("created-by-prompt");
		expect(requested).toEqual({
			kind: "prompted",
			serverId: runtime.serverId,
			sessionId: "created-by-prompt",
			text: "deterministic remote answer",
		});

		for (const result of [generated, requested]) {
			if (result.kind !== "prompted") throw new Error("Expected a prompted client result");
			await expect.poll(() => runtime.workerPids.has(result.sessionId)).toBe(false);
			const { branch } = await readExperimentalSessionState(runtime.sessionDir, result.sessionId);
			expect(branch).toHaveLength(2);
			expect(branch[0]).toMatchObject({
				message: { role: "user", content: [{ type: "text", text: "question" }] },
			});
			expect(branch[1]).toMatchObject({
				message: { role: "assistant", content: [{ type: "text", text: "deterministic remote answer" }] },
			});
		}
	});

	test.skip("completes and persists a prompt through the worker-owned Harness", async ({ onTestFinished }) => {
		const spawn = vi
			.spyOn(processRuntime, "spawnInternalProcess")
			.mockImplementation((role, args, options) =>
				realSpawnInternalProcess(
					role,
					args,
					role === "session-worker" ? { ...options, entryUrl: fauxWorkerEntryUrl } : options,
				),
			);
		onTestFinished(() => spawn.mockRestore());
		const { runtime } = await makeServer();
		const client = await attachClient(runtime, "demo-1");
		const workerPid = runtime.workerPids.get("demo-1");
		expect(workerPid).toEqual(expect.any(Number));

		const result = await client.promptSession("demo-1", "question");
		expect(result).toMatchObject({
			ok: true,
			value: {
				kind: "completed",
				leafId: expect.any(String),
				finalEntryId: expect.any(String),
				finalMessage: {
					role: "assistant",
					content: [{ type: "text", text: "deterministic remote answer" }],
					stopReason: "stop",
				},
			},
		});
		expect(runtime.workerPids.get("demo-1")).toBe(workerPid);
		expect(processExists(workerPid!)).toBe(true);
		if (!result.ok || result.value.kind !== "completed" || !("finalEntryId" in result.value)) {
			throw new Error("Expected a completed prompt with a final assistant entry");
		}
		const finalEntryId = result.value.finalEntryId;

		await client.dispose();
		clients.delete(client);
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);
		const { branch } = await readExperimentalSessionState(runtime.sessionDir, "demo-1");
		expect(branch).toHaveLength(2);
		expect(branch[0]).toMatchObject({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "question" }] },
		});
		expect(branch[1]).toMatchObject({
			id: finalEntryId,
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "deterministic remote answer" }],
				stopReason: "stop",
			},
		});
	});

	test("uses legacy provider/model and thinking-suffix resolution", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startServer({ directory, model: "anthropic/claude-sonnet-4-5:high" });
		servers.add(runtime);
		await attachClient(runtime, "demo-1");
		expect(runtime.workerPids.get("demo-1")).toEqual(expect.any(Number));
	});

	test("accepts a custom model ID through legacy model resolution", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startServer({ directory, provider: "anthropic", model: "missing-model" });
		servers.add(runtime);
		const client = await PiClient.connect({
			serverId: runtime.serverId,
			transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
		});
		clients.add(client);

		await expect(client.attachSession("demo-1")).resolves.toEqual({ sessionId: "demo-1" });
		expect(runtime.workerPids.get("demo-1")).toEqual(expect.any(Number));
	});

	test("stops an idle Session worker after its client disconnects", async () => {
		const { runtime } = await makeServer();
		const client = await attachClient(runtime, "demo-1");
		const pid = runtime.workerPids.get("demo-1");
		expect(pid).toEqual(expect.any(Number));

		await client.dispose();
		clients.delete(client);
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);
		expect(processExists(pid!)).toBe(false);
	});

	test("starts one process per attached session and stops them during shutdown", async () => {
		const { runtime } = await makeServer();
		await Promise.all([attachClient(runtime, "demo-1"), attachClient(runtime, "demo-2")]);

		const pids = [...runtime.workerPids.values()];
		expect(pids).toHaveLength(2);
		expect(new Set(pids).size).toBe(2);
		for (const pid of pids) expect(processExists(pid)).toBe(true);

		await runtime.close();
		expect(runtime.workerPids.size).toBe(0);
		await Promise.all(pids.map((pid) => expect.poll(() => processExists(pid)).toBe(false)));
	});

	test("server runtime replaces an exited worker on the next attach", async () => {
		const directory = await mkdtemp(join("/tmp", "pew-"));
		directories.add(directory);
		const runtime = await startServer({ ...sessionWorkerModel, directory });
		servers.add(runtime);
		const client = await attachClient(runtime, "demo-1");
		const firstPid = runtime.workerPids.get("demo-1");
		expect(firstPid).toEqual(expect.any(Number));

		process.kill(firstPid!, "SIGKILL");
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);
		await client.attachSession("demo-1");
		const replacementPid = runtime.workerPids.get("demo-1");
		expect(replacementPid).toEqual(expect.any(Number));
		expect(replacementPid).not.toBe(firstPid);
	});

	test("normal server shutdown stops detached workers", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startServer({ ...sessionWorkerModel, directory });
		servers.add(runtime);
		await attachClient(runtime, "demo-1");
		const pid = runtime.workerPids.get("demo-1");
		expect(pid).toEqual(expect.any(Number));

		await runtime.close();
		await expect.poll(() => processExists(pid!)).toBe(false);
		expect(runtime.workerPids.size).toBe(0);
		await expect.poll(() => pathExists(runtime.socketPath)).toBe(false);
	});

	test("serializes concurrent launchers so only one server remains active", async () => {
		const directory = await mkdtemp(join("/tmp", "pel-"));
		directories.add(directory);
		const runtimes = await Promise.all([
			startServer({ ...sessionWorkerModel, directory }),
			startServer({ ...sessionWorkerModel, directory }),
		]);
		for (const runtime of runtimes) servers.add(runtime);

		expect(runtimes[0].serverId).toBe(runtimes[1].serverId);
		await expect
			.poll(async () => {
				const closed = await Promise.all(
					runtimes.map((runtime) =>
						Promise.race([
							runtime.closed.then(() => true),
							new Promise<false>((resolve) => setImmediate(() => resolve(false))),
						]),
					),
				);
				return closed.filter(Boolean).length;
			})
			.toBe(1);
		await expect(runClient({ command: "client" }, { directory })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
	});

	test("shuts down the replaced server without waiting for its clients", async () => {
		const directory = await mkdtemp(join("/tmp", "peg-"));
		directories.add(directory);
		const first = await startServer({ ...sessionWorkerModel, directory });
		servers.add(first);
		const client = await PiClient.connect({
			serverId: first.serverId,
			transportFactory: createUnixTransportFactory({ path: first.socketPath }),
		});
		await client.listSessions();

		const replacement = await startServer({ ...sessionWorkerModel, directory });
		servers.add(replacement);
		await first.closed;
		await expect(runClient({ command: "client" }, { directory })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
		await client.dispose();
	});

	test("discovers workers after replacing the server", async () => {
		const firstDirectory = await mkdtemp(join("/tmp", "per-"));
		directories.add(firstDirectory);
		const first = await startServer({ ...sessionWorkerModel, directory: firstDirectory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const firstWorkerPid = first.workerPids.get("demo-1");
		expect(firstWorkerPid).toEqual(expect.any(Number));

		const replacement = await startServer({ ...sessionWorkerModel, directory: firstDirectory });
		servers.add(replacement);
		await first.closed;

		expect(replacement.serverId).toBe(first.serverId);
		expect(replacement.workerPids.get("demo-1")).toBe(firstWorkerPid);
		await expect.poll(() => first.workerPids.size).toBe(0);
		expect(processExists(firstWorkerPid!)).toBe(true);

		await expect(runClient({ command: "client" }, { directory: firstDirectory })).resolves.toMatchObject({
			kind: "list",
			sessions: [
				{ serverId: first.serverId, sessionId: "demo-1" },
				{ serverId: first.serverId, sessionId: "demo-2" },
			],
		});
		await attachClient(replacement, "demo-1");
		expect(replacement.workerPids.get("demo-1")).toBe(firstWorkerPid);
		await attachClient(replacement, "demo-2");
		expect(replacement.workerPids.get("demo-2")).toEqual(expect.any(Number));
		expect(replacement.workerPids.get("demo-2")).not.toBe(firstWorkerPid);
	});

	test("retires an unclaimed idle worker after replacement demand expires", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-orphan-worker-"));
		directories.add(directory);
		vi.stubEnv("__PI_SESSION_WORKER_ORPHAN_DEMAND_GRACE_MS", "50");
		const first = await startServer({ ...sessionWorkerModel, directory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const workerPid = first.workerPids.get("demo-1");
		expect(workerPid).toEqual(expect.any(Number));

		const replacement = await startServer({ ...sessionWorkerModel, directory });
		servers.add(replacement);
		await first.closed;
		expect(replacement.workerPids.get("demo-1")).toBe(workerPid);

		await expect.poll(() => replacement.workerPids.has("demo-1"), { timeout: 5_000 }).toBe(false);
		expect(processExists(workerPid!)).toBe(false);
	});

	test("restores tracked sessions that are outside the replacement catalog", async () => {
		const directory = await mkdtemp(join("/tmp", "pet-"));
		const emptySessionDir = await mkdtemp(join("/tmp", "pet-sessions-"));
		directories.add(directory);
		directories.add(emptySessionDir);
		const first = await startServer({ ...sessionWorkerModel, directory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const workerPid = first.workerPids.get("demo-1");

		const replacement = await startServer({
			...sessionWorkerModel,
			directory,
			sessionDir: emptySessionDir,
		});
		servers.add(replacement);
		await first.closed;

		await expect(runClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [{ serverId: first.serverId, sessionId: "demo-1" }],
		});
		await attachClient(replacement, "demo-1");
		expect(replacement.workerPids.get("demo-1")).toBe(workerPid);
	});

	test("reports missing and ambiguous session selections", async () => {
		const sharedDirectory = await mkdtemp(join("/tmp", "ped-"));
		directories.add(sharedDirectory);
		const firstShared = await startServer({
			...sessionWorkerModel,
			directory: sharedDirectory,
			serverId: "00000000-0000-4000-8000-000000000001",
		});
		const secondShared = await startServer({
			...sessionWorkerModel,
			directory: sharedDirectory,
			serverId: "00000000-0000-4000-8000-000000000002",
		});
		servers.add(firstShared);
		servers.add(secondShared);

		await expect(
			runClient({ command: "client", sessionId: "missing" }, { directory: sharedDirectory }),
		).rejects.toThrow("No discovered server contains session missing");
		await expect(
			runClient({ command: "client", sessionId: "demo-1" }, { directory: sharedDirectory }),
		).rejects.toThrow("Session demo-1 is available from more than one server");
	});
	test("rejects a duplicate session ID within one durable repository", async () => {
		await createExperimentalSessions(
			join(agentDir, "experimental", "sessions"),
			["demo-1"],
			join(agentDir, "other-cwd"),
		);
		const { directory } = await makeServer();

		await expect(runClient({ command: "client", sessionId: "demo-1" }, { directory })).rejects.toMatchObject({
			code: "session_ambiguous",
		});
	});
});

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

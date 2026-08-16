import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type ExperimentalServer,
	runExperimentalClient,
	startExperimentalCoordinatedServer,
	startExperimentalServer,
} from "../src/cli/experimental/runtime.ts";
import { configureExperimentalWorkerModel, createExperimentalSessions } from "./experimental-session-support.ts";

const servers = new Set<ExperimentalServer>();
const clients = new Set<PiClient>();
const directories = new Set<string>();
let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(join("/tmp", "pi-experimental-agent-"));
	directories.add(agentDir);
	await configureExperimentalWorkerModel(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	await createExperimentalSessions(join(agentDir, "experimental", "sessions"), ["demo-1", "demo-2"]);
});

async function makeServer(): Promise<{ directory: string; runtime: ExperimentalServer }> {
	const directory = await mkdtemp(join("/tmp", "pes-"));
	directories.add(directory);
	const runtime = await startExperimentalServer({ directory });
	servers.add(runtime);
	return { directory, runtime };
}

async function attachClient(runtime: ExperimentalServer, sessionId: string): Promise<PiClient> {
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
	test("does not change permissions on an explicit socket-path parent", async () => {
		const directory = await mkdtemp(join("/tmp", "pep-"));
		directories.add(directory);
		await chmod(directory, 0o750);
		const serverId = "00000000-0000-4000-8000-000000000001";
		const runtime = await startExperimentalServer({
			path: join(directory, `${serverId}.sock`),
			serverId,
		});
		servers.add(runtime);

		await expect(
			runExperimentalClient({
				command: "client",
				connect: { transport: "unix", path: runtime.socketPath },
			}),
		).resolves.toMatchObject({ kind: "list" });
		expect((await lstat(directory)).mode & 0o777).toBe(0o750);
	});

	test("resolves the configured session directory", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startExperimentalServer({ directory, sessionDir: "relative/sessions" });
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
		const runtime = await startExperimentalCoordinatedServer();
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
		await expect(runExperimentalClient({ command: "client" })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
	});

	test("serializes concurrent cold activation and retires after both clients leave", async () => {
		const directory = await mkdtemp(join("/tmp", "pi-auto-server-"));
		directories.add(directory);
		const serverId = "00000000-0000-4000-8000-000000000001";
		vi.stubEnv("PI_SERVER_DIR", directory);
		vi.stubEnv("PI_SERVER_ID", serverId);

		const results = await Promise.all([
			runExperimentalClient({ command: "client" }),
			runExperimentalClient({ command: "client" }),
		]);
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

		await expect(runExperimentalClient({ command: "client", sessionId: "demo-1" })).resolves.toEqual({
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
			startExperimentalCoordinatedServer({ directory, serverId: firstId }),
			startExperimentalCoordinatedServer({ directory, serverId: secondId }),
		]);
		servers.add(first);
		servers.add(second);

		expect((await lstat(join(directory, `control-${firstId}.sock`))).isSocket()).toBe(true);
		expect((await lstat(join(directory, `control-${secondId}.sock`))).isSocket()).toBe(true);
		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toEqual({
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
		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serverId: secondId, sessionId: "demo-1" },
				{ serverId: secondId, sessionId: "demo-2" },
			],
		});
	});

	test("discovers and lists seeded sessions without hosting either session", async () => {
		const { directory, runtime } = await makeServer();

		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toEqual({
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

	test("invalidates an exited worker and starts a replacement on the next attach", async () => {
		const { runtime } = await makeServer();
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

	test("starts one process per attached session and stops them during shutdown", async () => {
		const { runtime } = await makeServer();
		await Promise.all([attachClient(runtime, "demo-1"), attachClient(runtime, "demo-2")]);

		const pids = [...runtime.workerPids.values()];
		expect(pids).toHaveLength(2);
		expect(new Set(pids).size).toBe(2);
		for (const pid of pids) expect(processExists(pid)).toBe(true);

		await runtime.close();
		expect(runtime.workerPids.size).toBe(0);
		for (const pid of pids) expect(processExists(pid)).toBe(false);
	});

	test("coordinated server replaces an exited worker on the next attach", async () => {
		const directory = await mkdtemp(join("/tmp", "pew-"));
		directories.add(directory);
		const runtime = await startExperimentalCoordinatedServer({ directory });
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

	test("normal coordinated shutdown stops detached workers", async () => {
		const directory = await mkdtemp(join("/tmp", "pes-"));
		directories.add(directory);
		const runtime = await startExperimentalCoordinatedServer({ directory });
		servers.add(runtime);
		await attachClient(runtime, "demo-1");
		const pid = runtime.workerPids.get("demo-1");
		expect(pid).toEqual(expect.any(Number));

		await runtime.close();
		expect(processExists(pid!)).toBe(false);
		expect(runtime.workerPids.size).toBe(0);
		await expect.poll(() => pathExists(runtime.socketPath)).toBe(false);
	});

	test("serializes concurrent launchers so only one server remains active", async () => {
		const directory = await mkdtemp(join("/tmp", "pel-"));
		directories.add(directory);
		const runtimes = await Promise.all([
			startExperimentalCoordinatedServer({ directory }),
			startExperimentalCoordinatedServer({ directory }),
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
		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
	});

	test("shuts down the replaced server without waiting for its clients", async () => {
		const directory = await mkdtemp(join("/tmp", "peg-"));
		directories.add(directory);
		const first = await startExperimentalCoordinatedServer({ directory });
		servers.add(first);
		const client = await PiClient.connect({
			serverId: first.serverId,
			transportFactory: createUnixTransportFactory({ path: first.socketPath }),
		});
		await client.listSessions();

		const replacement = await startExperimentalCoordinatedServer({ directory });
		servers.add(replacement);
		await first.closed;
		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
		await client.dispose();
	});

	test("discovers workers after replacing the server", async () => {
		const firstDirectory = await mkdtemp(join("/tmp", "per-"));
		directories.add(firstDirectory);
		const first = await startExperimentalCoordinatedServer({ directory: firstDirectory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const firstWorkerPid = first.workerPids.get("demo-1");
		expect(firstWorkerPid).toEqual(expect.any(Number));

		const replacement = await startExperimentalCoordinatedServer({ directory: firstDirectory });
		servers.add(replacement);
		await first.closed;

		expect(replacement.serverId).toBe(first.serverId);
		expect(replacement.workerPids.get("demo-1")).toBe(firstWorkerPid);
		await expect.poll(() => first.workerPids.size).toBe(0);
		expect(processExists(firstWorkerPid!)).toBe(true);

		await expect(runExperimentalClient({ command: "client" }, { directory: firstDirectory })).resolves.toMatchObject({
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
		const first = await startExperimentalCoordinatedServer({ directory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const workerPid = first.workerPids.get("demo-1");
		expect(workerPid).toEqual(expect.any(Number));

		const replacement = await startExperimentalCoordinatedServer({ directory });
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
		const first = await startExperimentalCoordinatedServer({ directory });
		servers.add(first);
		await attachClient(first, "demo-1");
		const workerPid = first.workerPids.get("demo-1");

		const replacement = await startExperimentalCoordinatedServer({
			directory,
			sessionDir: emptySessionDir,
		});
		servers.add(replacement);
		await first.closed;

		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [{ serverId: first.serverId, sessionId: "demo-1" }],
		});
		await attachClient(replacement, "demo-1");
		expect(replacement.workerPids.get("demo-1")).toBe(workerPid);
	});

	test("reports missing and ambiguous session selections", async () => {
		const sharedDirectory = await mkdtemp(join("/tmp", "ped-"));
		directories.add(sharedDirectory);
		const firstShared = await startExperimentalServer({ directory: sharedDirectory });
		const secondShared = await startExperimentalServer({ directory: sharedDirectory });
		servers.add(firstShared);
		servers.add(secondShared);

		await expect(
			runExperimentalClient({ command: "client", sessionId: "missing" }, { directory: sharedDirectory }),
		).rejects.toThrow("No discovered server contains session missing");
		await expect(
			runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory: sharedDirectory }),
		).rejects.toThrow("Session demo-1 is available from more than one server");
	});
	test("rejects a duplicate session ID within one durable repository", async () => {
		await createExperimentalSessions(
			join(agentDir, "experimental", "sessions"),
			["demo-1"],
			join(agentDir, "other-cwd"),
		);
		const { directory } = await makeServer();

		await expect(
			runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory }),
		).rejects.toMatchObject({ code: "session_ambiguous" });
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

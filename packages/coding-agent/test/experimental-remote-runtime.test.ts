import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type ExperimentalMemoryServer,
	runExperimentalClient,
	startExperimentalMemoryServer,
	startExperimentalServerGeneration,
} from "../src/cli/experimental/runtime.ts";

const servers = new Set<ExperimentalMemoryServer>();
const directories = new Set<string>();

async function makeServer(): Promise<{ directory: string; runtime: ExperimentalMemoryServer }> {
	const directory = await mkdtemp(join("/tmp", "pes-"));
	directories.add(directory);
	const runtime = await startExperimentalMemoryServer({ directory });
	servers.add(runtime);
	return { directory, runtime };
}

afterEach(async () => {
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("experimental memory server composition", () => {
	test("does not change permissions on an explicit socket-path parent", async () => {
		const directory = await mkdtemp(join("/tmp", "pep-"));
		directories.add(directory);
		await chmod(directory, 0o750);
		const serverId = "00000000-0000-4000-8000-000000000001";
		const runtime = await startExperimentalMemoryServer({
			path: join(directory, `${serverId}.sock`),
			serverId,
		});
		servers.add(runtime);

		expect((await lstat(directory)).mode & 0o777).toBe(0o750);
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

	test("attaches to a seeded session and reuses its hosted handle", async () => {
		const { directory, runtime } = await makeServer();

		await expect(runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory })).resolves.toEqual({
			kind: "attached",
			serverId: runtime.serverId,
			sessionId: "demo-1",
		});
		expect([...runtime.workerPids.keys()]).toEqual(["demo-1"]);
		const firstPid = runtime.workerPids.get("demo-1");
		expect(firstPid).toEqual(expect.any(Number));

		await runExperimentalClient({
			command: "client",
			sessionId: "demo-1",
			connect: { transport: "unix", path: runtime.socketPath },
		});
		expect([...runtime.workerPids.keys()]).toEqual(["demo-1"]);
		expect(runtime.workerPids.get("demo-1")).toBe(firstPid);
	});

	test("invalidates an exited worker and starts a replacement on the next attach", async () => {
		const { directory, runtime } = await makeServer();
		await runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory });
		const firstPid = runtime.workerPids.get("demo-1");
		expect(firstPid).toEqual(expect.any(Number));

		process.kill(firstPid!, "SIGKILL");
		await expect.poll(() => runtime.workerPids.has("demo-1")).toBe(false);

		await runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory });
		const replacementPid = runtime.workerPids.get("demo-1");
		expect(replacementPid).toEqual(expect.any(Number));
		expect(replacementPid).not.toBe(firstPid);
	});

	test("starts one process per attached session and stops them during shutdown", async () => {
		const { directory, runtime } = await makeServer();
		await Promise.all([
			runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory }),
			runExperimentalClient({ command: "client", sessionId: "demo-2" }, { directory }),
		]);

		const pids = [...runtime.workerPids.values()];
		expect(pids).toHaveLength(2);
		expect(new Set(pids).size).toBe(2);
		for (const pid of pids) expect(processExists(pid)).toBe(true);

		await runtime.close();
		expect(runtime.workerPids.size).toBe(0);
		for (const pid of pids) expect(processExists(pid)).toBe(false);
	});

	test("serializes concurrent launchers so only one generation remains active", async () => {
		const directory = await mkdtemp(join("/tmp", "pel-"));
		directories.add(directory);
		const generations = await Promise.all([
			startExperimentalServerGeneration({ directory, socketDirectory: directory }),
			startExperimentalServerGeneration({ directory, socketDirectory: directory }),
		]);
		for (const generation of generations) servers.add(generation);

		expect(generations[0].serverId).toBe(generations[1].serverId);
		const closed = await Promise.all(
			generations.map((generation) =>
				Promise.race([
					generation.closed.then(() => true),
					new Promise<false>((resolve) => setImmediate(() => resolve(false))),
				]),
			),
		);
		expect(closed.filter(Boolean)).toHaveLength(1);
		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toMatchObject({
			kind: "list",
			sessions: [{ sessionId: "demo-1" }, { sessionId: "demo-2" }],
		});
	});

	test("starts a clean replacement and requires explicit reattachment", async () => {
		const firstDirectory = await mkdtemp(join("/tmp", "per-"));
		const otherDirectory = await mkdtemp(join("/tmp", "per-"));
		directories.add(firstDirectory);
		directories.add(otherDirectory);
		const first = await startExperimentalServerGeneration({
			directory: firstDirectory,
			socketDirectory: firstDirectory,
		});
		const other = await startExperimentalServerGeneration({
			directory: otherDirectory,
			socketDirectory: otherDirectory,
		});
		servers.add(first);
		servers.add(other);
		await runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory: firstDirectory });
		await runExperimentalClient({ command: "client", sessionId: "demo-2" }, { directory: otherDirectory });
		const firstWorkerPid = first.workerPids.get("demo-1");
		const otherWorkerPid = other.workerPids.get("demo-2");
		expect(firstWorkerPid).toEqual(expect.any(Number));
		expect(otherWorkerPid).toEqual(expect.any(Number));

		const replacement = await startExperimentalServerGeneration({
			directory: firstDirectory,
			socketDirectory: firstDirectory,
		});
		servers.add(replacement);
		await first.closed;

		expect(replacement.serverId).toBe(first.serverId);
		expect(replacement.workerPids.size).toBe(0);
		expect(first.workerPids.size).toBe(0);
		expect(processExists(firstWorkerPid!)).toBe(false);
		expect(other.workerPids.get("demo-2")).toBe(otherWorkerPid);
		expect(processExists(otherWorkerPid!)).toBe(true);

		await expect(runExperimentalClient({ command: "client" }, { directory: firstDirectory })).resolves.toMatchObject({
			kind: "list",
			sessions: [
				{ serverId: first.serverId, sessionId: "demo-1" },
				{ serverId: first.serverId, sessionId: "demo-2" },
			],
		});
		await runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory: firstDirectory });
		expect(replacement.workerPids.get("demo-1")).toEqual(expect.any(Number));
		expect(replacement.workerPids.get("demo-1")).not.toBe(firstWorkerPid);
	});

	test("reports missing and ambiguous session selections", async () => {
		const sharedDirectory = await mkdtemp(join("/tmp", "ped-"));
		directories.add(sharedDirectory);
		const firstShared = await startExperimentalMemoryServer({ directory: sharedDirectory });
		const secondShared = await startExperimentalMemoryServer({ directory: sharedDirectory });
		servers.add(firstShared);
		servers.add(secondShared);

		await expect(
			runExperimentalClient({ command: "client", sessionId: "missing" }, { directory: sharedDirectory }),
		).rejects.toThrow("No discovered server contains session missing");
		await expect(
			runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory: sharedDirectory }),
		).rejects.toThrow("Session demo-1 is available from more than one server");
	});
});

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

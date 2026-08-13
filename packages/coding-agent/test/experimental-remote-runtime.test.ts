import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type ExperimentalMemoryServer,
	runExperimentalClient,
	startExperimentalMemoryServer,
} from "../src/cli/experimental/runtime.ts";

const servers = new Set<ExperimentalMemoryServer>();
const directories = new Set<string>();

async function makeServer(): Promise<{ directory: string; runtime: ExperimentalMemoryServer }> {
	const directory = await mkdtemp(join(tmpdir(), "pes-"));
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
	test("discovers and lists seeded sessions without hosting either session", async () => {
		const { directory, runtime } = await makeServer();

		await expect(runExperimentalClient({ command: "client" }, { directory })).resolves.toEqual({
			kind: "list",
			sessions: [
				{ serviceId: runtime.serviceId, sessionId: "demo-1" },
				{ serviceId: runtime.serviceId, sessionId: "demo-2" },
			],
		});
		expect(runtime.server.hostedSessions).toEqual([]);
	});

	test("attaches to a seeded session and reuses its hosted owner", async () => {
		const { directory, runtime } = await makeServer();

		await expect(runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory })).resolves.toEqual({
			kind: "attached",
			serviceId: runtime.serviceId,
			sessionId: "demo-1",
		});
		expect(runtime.server.hostedSessions.map(({ sessionId }) => sessionId)).toEqual(["demo-1"]);

		await runExperimentalClient({
			command: "client",
			sessionId: "demo-1",
			connect: { transport: "unix", path: runtime.socketPath },
		});
		expect(runtime.server.hostedSessions.map(({ sessionId }) => sessionId)).toEqual(["demo-1"]);
	});

	test("reports missing and ambiguous session selections", async () => {
		const sharedDirectory = await mkdtemp(join(tmpdir(), "ped-"));
		directories.add(sharedDirectory);
		const firstShared = await startExperimentalMemoryServer({ directory: sharedDirectory });
		const secondShared = await startExperimentalMemoryServer({ directory: sharedDirectory });
		servers.add(firstShared);
		servers.add(secondShared);

		await expect(
			runExperimentalClient({ command: "client", sessionId: "missing" }, { directory: sharedDirectory }),
		).rejects.toThrow("No discovered service contains session missing");
		await expect(
			runExperimentalClient({ command: "client", sessionId: "demo-1" }, { directory: sharedDirectory }),
		).rejects.toThrow("Session demo-1 is available from more than one service");
	});
});

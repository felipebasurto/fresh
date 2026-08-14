import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type JsonlSessionMetadata, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type ExperimentalSessionWorker,
	startExperimentalSessionWorker,
} from "../src/cli/experimental/session-worker.ts";
import { configureExperimentalWorkerModel, createExperimentalSessions } from "./experimental-session-support.ts";

const workers = new Set<ExperimentalSessionWorker>();
const fixtureUrl = new URL("fixtures/session-worker-fixture.ts", import.meta.url);
const sessionDir = "/tmp/pi-session-worker-tests";
const directories = new Set<string>();

function testMetadata(id: string): JsonlSessionMetadata {
	return {
		id,
		createdAt: 1,
		storageVersion: 1,
		cwd: "/tmp",
		path: `/tmp/${id}.jsonl`,
		modifiedAt: 1,
	};
}

afterEach(async () => {
	await Promise.all([...workers].map((worker) => worker.close()));
	workers.clear();
	vi.unstubAllEnvs();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("experimental session worker controller", () => {
	test("starts a real child, validates readiness, and closes idempotently", async () => {
		const worker = await startExperimentalSessionWorker(testMetadata("ready"), {
			sessionDir,
			workerUrl: fixtureUrl,
		});
		workers.add(worker);

		expect(worker.sessionId).toBe("ready");
		expect(worker.pid).not.toBe(process.pid);
		expect(processExists(worker.pid)).toBe(true);

		await Promise.all([worker.close(), worker.close()]);
		expect(processExists(worker.pid)).toBe(false);
		await expect(worker.terminated).resolves.toBeUndefined();
	});

	test("passes session IDs containing null bytes through serialized metadata", async () => {
		const worker = await startExperimentalSessionWorker(testMetadata("ready\0"), {
			sessionDir,
			workerUrl: fixtureUrl,
		});
		workers.add(worker);

		expect(worker.sessionId).toBe("ready\0");
		await worker.close();
	});

	test("rejects a relative session directory before starting a child", async () => {
		await expect(
			startExperimentalSessionWorker(testMetadata("ready"), { sessionDir: "relative", workerUrl: fixtureUrl }),
		).rejects.toThrow("sessionDir must be absolute");
	});

	test("times out and kills a child that never reports readiness", async () => {
		await expect(
			startExperimentalSessionWorker(testMetadata("startup-hang"), {
				sessionDir,
				workerUrl: fixtureUrl,
				startupTimeoutMs: 10,
			}),
		).rejects.toThrow(/startup timed out/);
	});

	test.each([
		["failure event", "fail", /fixture startup failed/],
		["exit before readiness", "exit", /exited before readiness/],
		["invalid ready identity", "mismatch", /invalid identity/],
	] as const)("rejects %s", async (_label, sessionId, message) => {
		await expect(
			startExperimentalSessionWorker(testMetadata(sessionId), { sessionDir, workerUrl: fixtureUrl }),
		).rejects.toThrow(message);
	});

	test("kills a worker that ignores graceful shutdown", async () => {
		const worker = await startExperimentalSessionWorker(testMetadata("hang"), {
			sessionDir,
			workerUrl: fixtureUrl,
			shutdownTimeoutMs: 10,
		});
		workers.add(worker);

		await worker.close();
		expect(processExists(worker.pid)).toBe(false);
	});

	test("reports an unexpected exit after readiness", async () => {
		const worker = await startExperimentalSessionWorker(testMetadata("ready"), {
			sessionDir,
			workerUrl: fixtureUrl,
		});
		workers.add(worker);

		process.kill(worker.pid, "SIGKILL");
		await expect(worker.terminated).resolves.toEqual(
			expect.objectContaining({ message: expect.stringMatching(/exited unexpectedly.*SIGKILL/) }),
		);
		expect(processExists(worker.pid)).toBe(false);
	});

	test("fails clearly when no model is configured", async () => {
		const root = await mkdtemp(join("/tmp", "pi-session-worker-no-model-"));
		directories.add(root);
		const durableSessionDir = join(root, "sessions");
		const [metadata] = await createExperimentalSessions(durableSessionDir, ["no-model"]);
		const agentDir = join(root, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		await expect(startExperimentalSessionWorker(metadata!, { sessionDir: durableSessionDir })).rejects.toThrow(
			"could not find a configured model",
		);
	});

	test("opens a durable session and creates a real Harness before readiness", async () => {
		const root = await mkdtemp(join("/tmp", "pi-session-worker-real-"));
		directories.add(root);
		const durableSessionDir = join(root, "sessions");
		const [metadata] = await createExperimentalSessions(durableSessionDir, ["durable-session"]);
		const agentDir = join(root, "agent");
		await configureExperimentalWorkerModel(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const worker = await startExperimentalSessionWorker(metadata!, { sessionDir: durableSessionDir });
		workers.add(worker);

		expect(worker.sessionId).toBe("durable-session");
		expect(worker.pid).not.toBe(process.pid);
		expect(processExists(worker.pid)).toBe(true);

		await worker.close();
		await expect(worker.terminated).resolves.toBeUndefined();

		const executionEnv = new NodeExecutionEnv({ cwd: metadata!.cwd });
		const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: durableSessionDir });
		const reopened = await repo.open(metadata!);
		await expect(reopened.getRegister("lane.config", "main")).resolves.toMatchObject({
			value: {
				model: { provider: "anthropic" },
				thinkingLevel: "off",
				activeToolNames: [],
			},
		});
		await reopened.close();
		await repo.close();
		await executionEnv.cleanup();
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

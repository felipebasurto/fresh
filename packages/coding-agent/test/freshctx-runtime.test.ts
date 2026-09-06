import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FreshCtxRuntime } from "../src/core/freshctx/runtime.ts";

const fakeServer = resolve(__dirname, "fixtures/freshctx-fake-server.mjs");
const tempDirs: string[] = [];
const runtimes: FreshCtxRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) {
		await runtime.close();
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function start(
	root: string,
	options?: { timeoutMs?: number; sessionId?: string; extraEnv?: NodeJS.ProcessEnv },
): Promise<FreshCtxRuntime> {
	const runtime = await FreshCtxRuntime.start({
		server: { command: process.execPath, args: [fakeServer] },
		root,
		sessionId: options?.sessionId ?? "test-session",
		adapter: "test/openai-completions",
		timeoutMs: options?.timeoutMs,
		env: { ...process.env, FRESHCTX_FAKE_ROOT: root, ...options?.extraEnv },
	});
	runtimes.push(runtime);
	return runtime;
}

describe("FreshCtxRuntime", () => {
	it("completes hello and reports status", async () => {
		const root = createTempDir("pi-freshctx-runtime-");
		const runtime = await start(root);
		const status = (await runtime.request("status")) as { healthy: boolean; session_id: string };
		expect(status.healthy).toBe(true);
		expect(status.session_id).toBe("test-session");
	});

	it("observe/prepare/commit returns fresh disk bytes in the projection", async () => {
		const root = createTempDir("pi-freshctx-runtime-");
		writeFileSync(join(root, "price.py"), "RATE = 10\n");
		const runtime = await start(root);
		const shown = "RATE = 10";
		await runtime.request("observe", {
			result_id: "read_1",
			path: "price.py",
			content_utf8_base64: Buffer.from(shown, "utf-8").toString("base64"),
			range: { start_byte: 0, end_byte: Buffer.byteLength(shown) },
			turn: 0,
		});
		writeFileSync(join(root, "price.py"), "RATE = 20\n");
		const plan = (await runtime.request("prepare", {
			request_id: "req-1",
			result_ids: ["read_1", "unknown-result"],
			budget_bytes: 131072,
		})) as {
			plan_id: string;
			replacements: Array<{ result_id: string; expected_sha256: string; marker: string }>;
			projection_utf8_base64: string;
			unresolved: Array<{ result_id: string }>;
		};
		expect(plan.unresolved).toEqual([{ result_id: "unknown-result", reason: "unknown_result" }]);
		expect(plan.replacements).toHaveLength(1);
		const projection = Buffer.from(plan.projection_utf8_base64, "base64").toString("utf-8");
		expect(projection).toContain("RATE = 20");
		expect(projection).not.toContain("RATE = 10");
		const committed = (await runtime.request("commit", { plan_id: plan.plan_id })) as { applied: boolean };
		expect(committed.applied).toBe(true);
	});

	it("rejects requests after close and fails to start with a bad command", async () => {
		const root = createTempDir("pi-freshctx-runtime-");
		const runtime = await start(root);
		await runtime.close();
		await expect(runtime.request("status")).rejects.toThrow(/closed/);
		await expect(
			FreshCtxRuntime.start({
				server: { command: "/nonexistent/freshctx-binary", args: [] },
				root,
				sessionId: "test-session",
				adapter: "test/openai-completions",
				timeoutMs: 1000,
			}),
		).rejects.toThrow();
	});

	it("times out slow servers and stays failed afterwards", async () => {
		const root = createTempDir("pi-freshctx-runtime-");
		const runtime = await start(root, { timeoutMs: 200 });
		await runtime.request("__delay", { ms: 5000 });
		await expect(runtime.request("status")).rejects.toThrow(/timed out/);
		// Transport failure is sticky: later requests fail too.
		await expect(runtime.request("status")).rejects.toThrow(/timed out/);
	});

	it("aborts single requests without killing the runtime", async () => {
		const root = createTempDir("pi-freshctx-runtime-");
		const runtime = await start(root, { timeoutMs: 30000 });
		await runtime.request("__delay", { ms: 5000 });
		const controller = new AbortController();
		const pending = runtime.request("status", {}, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow(/abort/i);
		// Abort rejects only the aborted call; the runtime stays usable.
		await runtime.request("__delay", { ms: 0 });
		const status = (await runtime.request("status")) as { healthy: boolean };
		expect(status.healthy).toBe(true);
	});
});

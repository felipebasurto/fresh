/**
 * Zero-cost protocol probe: real local `freshctx` + loopback capture provider.
 *
 * Explains A/B selection_granularity wiring without a live LLM. For each arm
 * (region, file) records:
 *   1. requested mode from active settings
 *   2. exact prepare request fields sent to FreshCtx
 *   3. exact prepare response (selection_granularity echo)
 *   4. persisted plan-trace selectionGranularity
 *   5. Fresh/FreshCtx fingerprints + session path
 *
 * Expected:
 *   - region: request omits or sends region; response + trace are region
 *   - file: request sends file; response + trace are file, OR prepare blocks
 *     as invalid-plan when the engine echoes a different mode
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../src/config.ts";
import { FreshCtxRuntime } from "../src/core/freshctx/runtime.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

const tempDirs: string[] = [];
const prepareWireLog: Array<{
	requestFields: Record<string, unknown>;
	response: Record<string, unknown>;
}> = [];

const originalRequest = FreshCtxRuntime.prototype.request;

afterEach(() => {
	FreshCtxRuntime.prototype.request = originalRequest;
	prepareWireLog.length = 0;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function resolveRealFreshCtxEntry(): string | null {
	const candidates: string[] = [];
	if (process.env.FRESHCTX_BIN) candidates.push(process.env.FRESHCTX_BIN);
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir) candidates.push(join(dir, "freshctx"));
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function resolveFreshCtxRoot(engineEntry: string): string | null {
	if (process.env.FRESHCTX_ROOT) return process.env.FRESHCTX_ROOT;
	const marker = `${sep}bin${sep}freshctx.mjs`;
	if (engineEntry.endsWith(marker)) return dirname(dirname(engineEntry));
	return null;
}

const realFreshCtx = resolveRealFreshCtxEntry();
const describeReal = realFreshCtx ? describe : describe.skip;

function installPrepareWireTap(): void {
	FreshCtxRuntime.prototype.request = async function patchedRequest(
		this: FreshCtxRuntime,
		op: string,
		fields: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<unknown> {
		const result = await originalRequest.call(this, op, fields, signal);
		if (op === "prepare" && result && typeof result === "object") {
			prepareWireLog.push({
				requestFields: structuredClone(fields),
				response: structuredClone(result as Record<string, unknown>),
			});
		}
		return result;
	};
}

function fingerprint(
	root: string,
	name: string,
	paths: string,
): { name: string; head: string | null; dirty: boolean | null; fingerprint: string | null } {
	try {
		const script = resolve(process.cwd(), "../../scripts/build-fingerprint.mjs");
		const out = execFileSync(process.execPath, [script, "--root", root, "--name", name, "--paths", paths], {
			encoding: "utf8",
		});
		return JSON.parse(out) as {
			name: string;
			head: string | null;
			dirty: boolean | null;
			fingerprint: string | null;
		};
	} catch {
		return { name, head: null, dirty: null, fingerprint: null };
	}
}

async function startCaptureServer(): Promise<{ server: Server; port: number }> {
	let turn = 0;
	const server = createServer(async (req, res) => {
		try {
			for await (const _chunk of req) {
				/* drain */
			}
			const emitRead = turn++ === 0;
			const delta = emitRead
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "read_target_rate",
								type: "function",
								function: {
									name: "read",
									arguments: JSON.stringify({ path: "config.py", offset: 1, limit: 5 }),
								},
							},
						],
					}
				: { role: "assistant", content: "Fixture response (ignored)." };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: emitRead ? "tool_calls" : "stop" }] })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		} catch (error) {
			res.writeHead(500);
			res.end(error instanceof Error ? error.message : String(error));
		}
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("capture server did not bind");
	}
	return { server, port: address.port };
}

type ArmRecord = {
	requestedMode: "region" | "file";
	activeSettingsGranularity: string;
	prepareRequest: Record<string, unknown> | null;
	prepareResponseGranularity: unknown;
	persistedTraceGranularity: unknown;
	persistedAttempts: Array<Record<string, unknown>>;
	blockedCode: string | null;
	sessionFile: string | null;
	fingerprints: {
		fresh: ReturnType<typeof fingerprint>;
		freshctx: ReturnType<typeof fingerprint>;
		engineEntrySha256: string | null;
	};
};

async function runArm(mode: "region" | "file", engineEntry: string): Promise<ArmRecord> {
	prepareWireLog.length = 0;
	installPrepareWireTap();

	const root = createTempDir(`pi-freshctx-granularity-${mode}-`);
	writeFileSync(join(root, "config.py"), "TARGET_RATE = 10\nOTHER = 1\n");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	// Same settings shape the A/B pilot writes into the per-run agent dir.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			freshctx: {
				mode: "native",
				selectionGranularity: mode,
				serverCommand: [process.execPath, engineEntry, "serve", "--stdio", "--root", "{root}"],
				timeoutMs: 20000,
			},
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);

	const settingsManager = SettingsManager.create(root, agentDir);
	const activeSettingsGranularity = settingsManager.getFreshCtxSelectionGranularity();

	const { server, port } = await startCaptureServer();
	const errors: unknown[] = [];
	let sessionFile: string | null = null;
	let blockedCode: string | null = null;

	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(agentDir, "models-store.json"),
			refreshOnCreate: false,
		});
		modelRuntime.registerProvider("freshctx-granularity-probe", {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			api: "openai-completions",
			apiKey: "local-fixture-no-secret",
			models: [
				{
					id: "fixture",
					name: "Deterministic local fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 1024,
				},
			],
		});
		const model = modelRuntime.getModel("freshctx-granularity-probe", "fixture");
		if (!model) throw new Error("probe model not registered");

		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const sessionManager = SessionManager.create(root, join(root, "sessions"));
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel: "off",
			tools: ["read"],
			resourceLoader: loader,
			sessionManager,
			settingsManager,
		});
		try {
			await session.bindExtensions({
				onError: (error) => errors.push(error),
			});
			await session.prompt("Read TARGET_RATE in config.py.");
			sessionFile = (session.sessionManager as SessionManager).getSessionFile() ?? null;
		} finally {
			session.dispose();
		}
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
				? (error as { code: string }).code
				: null;
		blockedCode = code;
		if (code !== "invalid-plan") {
			throw error;
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}

	const lastPrepare = prepareWireLog.at(-1) ?? null;
	let persistedTraceGranularity: unknown = null;
	const persistedAttempts: Array<Record<string, unknown>> = [];
	if (sessionFile && existsSync(sessionFile)) {
		for (const line of readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean)) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type !== "custom") {
				continue;
			}
			if (entry.customType === "freshctx_prepare_attempt") {
				persistedAttempts.push((entry.data ?? {}) as Record<string, unknown>);
				continue;
			}
			if (entry.customType === "freshctx_revalidation") {
				const data = (entry.data ?? {}) as Record<string, unknown>;
				persistedTraceGranularity = data.selectionGranularity ?? null;
				for (const attempt of Array.isArray(data.prepareAttempts) ? data.prepareAttempts : []) {
					persistedAttempts.push(attempt as Record<string, unknown>);
				}
			}
		}
	}

	const repoRoot = resolve(process.cwd(), "../..");
	let engineEntrySha256: string | null = null;
	try {
		engineEntrySha256 = createHash("sha256").update(readFileSync(engineEntry)).digest("hex");
	} catch {
		engineEntrySha256 = null;
	}

	return {
		requestedMode: mode,
		activeSettingsGranularity,
		prepareRequest: lastPrepare?.requestFields ?? null,
		prepareResponseGranularity: lastPrepare?.response.selection_granularity ?? null,
		persistedTraceGranularity,
		persistedAttempts,
		blockedCode,
		sessionFile,
		fingerprints: {
			fresh: fingerprint(
				repoRoot,
				"fresh",
				"packages/coding-agent/src,packages/ai/src,packages/agent/src,scripts/freshctx-ab-pilot.mjs",
			),
			freshctx: fingerprint(
				resolveFreshCtxRoot(engineEntry) ?? engineEntry,
				"freshctx",
				"src,bin,package.json,schema",
			),
			engineEntrySha256,
		},
	};
}

describe("Fresh agent-dir env contract (explains pilot isolation)", () => {
	it("reads FRESH_CODING_AGENT_DIR, not PI_CODING_AGENT_DIR", () => {
		expect(ENV_AGENT_DIR).toBe("FRESH_CODING_AGENT_DIR");
		const prevPi = process.env.PI_CODING_AGENT_DIR;
		const prevFresh = process.env.FRESH_CODING_AGENT_DIR;
		const isolated = join(tmpdir(), `pi-ignored-agent-${Date.now()}`);
		try {
			process.env.PI_CODING_AGENT_DIR = isolated;
			delete process.env.FRESH_CODING_AGENT_DIR;
			expect(getAgentDir()).not.toBe(isolated);
			process.env.FRESH_CODING_AGENT_DIR = isolated;
			expect(getAgentDir()).toBe(isolated);
		} finally {
			if (prevPi === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevPi;
			if (prevFresh === undefined) delete process.env.FRESH_CODING_AGENT_DIR;
			else process.env.FRESH_CODING_AGENT_DIR = prevFresh;
		}
	});
});

describeReal("FreshCtx selection_granularity protocol probe (real engine)", () => {
	it("region and file arms record request/response/trace consistently", async () => {
		if (!realFreshCtx) {
			throw new Error("unreachable: describe.skip when binary missing");
		}

		const region = await runArm("region", realFreshCtx);
		const file = await runArm("file", realFreshCtx);

		// Machine-readable record for offline review of the t9 mismatch.
		console.log(
			JSON.stringify(
				{
					schema: "freshctx-granularity-protocol-probe/1",
					arms: { region, file },
				},
				null,
				2,
			),
		);

		expect(region.activeSettingsGranularity).toBe("region");
		expect(region.blockedCode).toBeNull();
		expect(region.prepareRequest).not.toBeNull();
		expect(region.prepareRequest?.selection_granularity).toBeUndefined();
		expect(region.prepareResponseGranularity).toBe("region");
		expect(region.persistedTraceGranularity).toBe("region");
		expect(region.persistedAttempts.length).toBeGreaterThan(0);
		expect(region.persistedAttempts.at(-1)).toMatchObject({
			requestedGranularity: "region",
			engineGranularity: "region",
			accepted: true,
			blockCode: null,
		});
		expect(region.sessionFile).toBeTruthy();
		expect(region.fingerprints.fresh.head).toBeTruthy();
		expect(region.fingerprints.engineEntrySha256).toBeTruthy();

		expect(file.activeSettingsGranularity).toBe("file");
		if (file.blockedCode === "invalid-plan") {
			// Fail-closed path: engine echo disagreed with requested file mode.
			// The pre-commit attempt record is the diagnosis: file requested,
			// region echoed, rejected before commit.
			expect(file.prepareRequest?.selection_granularity).toBe("file");
			expect(file.prepareResponseGranularity).not.toBe("file");
			expect(file.persistedAttempts.length).toBeGreaterThan(0);
			expect(file.persistedAttempts.at(-1)).toMatchObject({
				requestedGranularity: "file",
				engineGranularity: expect.not.stringMatching(/^file$/),
				accepted: false,
				blockCode: "invalid-plan",
			});
		} else {
			expect(file.blockedCode).toBeNull();
			expect(file.prepareRequest?.selection_granularity).toBe("file");
			expect(file.prepareResponseGranularity).toBe("file");
			expect(file.persistedTraceGranularity).toBe("file");
			expect(file.persistedAttempts.length).toBeGreaterThan(0);
			expect(file.persistedAttempts.at(-1)).toMatchObject({
				requestedGranularity: "file",
				engineGranularity: "file",
				accepted: true,
				blockCode: null,
			});
			expect(file.sessionFile).toBeTruthy();
		}
	}, 60000);
});

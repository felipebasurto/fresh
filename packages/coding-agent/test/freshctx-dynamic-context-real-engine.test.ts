/**
 * Non-live end-to-end dynamic-context probe against the **real** local
 * `freshctx` binary. Provider remains a deterministic loopback capture fixture.
 *
 * Chain under test:
 *   external disk mutation → real engine plan → Fresh adapter payload →
 *   captured outgoing provider body contains current bytes
 *
 * Skips when no local binary is found (override with FRESHCTX_BIN).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Prefer FRESHCTX_BIN, then `freshctx` on PATH. */
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

const realFreshCtx = resolveRealFreshCtxEntry();
const describeReal = realFreshCtx ? describe : describe.skip;

type Captured = Array<{ messages: Array<Record<string, unknown>> }>;

async function startCaptureServer(): Promise<{ server: Server; port: number; captured: Captured }> {
	const captured: Captured = [];
	let turn = 0;
	const server = createServer(async (req, res) => {
		try {
			let body = "";
			for await (const chunk of req) body += chunk;
			captured.push(JSON.parse(body));
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
				: { role: "assistant", content: "Fixture response (ignored for proof)." };
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
	return { server, port: address.port, captured };
}

async function openRealEngineSession(
	root: string,
	port: number,
	engineEntry: string,
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; errors: unknown[] }> {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("freshctx-real-engine-probe", {
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
	const model = modelRuntime.getModel("freshctx-real-engine-probe", "fixture");
	if (!model) {
		throw new Error("probe model not registered");
	}
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		freshctx: {
			mode: "native",
			// Real engine: stdio serve over the workspace root (token-substituted).
			serverCommand: [process.execPath, engineEntry, "serve", "--stdio", "--root", "{root}"],
			timeoutMs: 20000,
		},
	});
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
	const errors: unknown[] = [];
	await session.bindExtensions({
		onError: (error) => errors.push(error),
	});
	return { session, errors };
}

function countReadToolCallsInRequest(req: Captured[number]): number {
	let n = 0;
	for (const message of req.messages ?? []) {
		if (message.role !== "assistant") continue;
		const names = new Set<string>();
		const content = message.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					(block as { type?: string; name?: string }).type === "toolCall" &&
					(block as { name?: string }).name === "read"
				) {
					names.add("read");
				}
			}
		}
		const toolCalls = (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls;
		if (Array.isArray(toolCalls)) {
			for (const call of toolCalls) {
				if (call.function?.name === "read") names.add("read");
			}
		}
		n += names.has("read") ? 1 : 0;
	}
	return n;
}

function revalidationEntries(sessionFile: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const line of readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean)) {
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type === "custom" && entry.customType === "freshctx_revalidation") {
			out.push((entry.data ?? {}) as Record<string, unknown>);
		}
	}
	return out;
}

describeReal("FreshCtx dynamic-context probe (real local engine)", () => {
	it("external mutation → real engine plan → adapter payload carries current bytes", async () => {
		if (!realFreshCtx) {
			throw new Error("unreachable: describe.skip when binary missing");
		}
		const root = createTempDir("pi-freshctx-real-dyn-");
		writeFileSync(join(root, "config.py"), "TARGET_RATE = 10\nOTHER = 1\n");
		const { server, port, captured } = await startCaptureServer();
		try {
			const { session, errors } = await openRealEngineSession(root, port, realFreshCtx);
			try {
				await session.prompt("Read the TARGET_RATE assignment in config.py.");
				expect(captured.length).toBe(2);
				expect(countReadToolCallsInRequest(captured[1]!)).toBe(1);

				writeFileSync(join(root, "config.py"), "TARGET_RATE = 12\nOTHER = 1\n");
				const beforeRefresh = captured.length;
				await session.prompt("Using only context you already have, what is TARGET_RATE?");
				expect(captured.length).toBe(beforeRefresh + 1);
				expect(countReadToolCallsInRequest(captured.at(-1)!)).toBe(1);

				const outgoing = JSON.stringify(captured.at(-1)?.messages);
				expect(outgoing).toContain("TARGET_RATE = 12");
				expect(outgoing).not.toContain("TARGET_RATE = 10");

				const sessionFile = (session.sessionManager as SessionManager).getSessionFile();
				expect(sessionFile).toBeDefined();
				const revals = revalidationEntries(sessionFile as string);
				expect(revals.length).toBeGreaterThanOrEqual(1);
				const last = revals.at(-1)!;
				expect(last.blocked).toBe(false);
				expect(["STABLE", "RELOCATED", "UPDATED"]).toContain(last.outcome);
				expect(typeof last.prepareRequestIndex).toBe("number");
				expect(last.prepareRequestIndex).toBeGreaterThan(0);
				expect(typeof last.regionBytes).toBe("number");
				expect(last.regionBytes).toBeGreaterThan(0);
				// Real engine should emit a plan-time whole-file counterfactual for region mode.
				expect(typeof last.wholeFileEquivalentBytes).toBe("number");
				expect(last.wholeFileEquivalentBytes).toBeGreaterThan(0);
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 60000);
});

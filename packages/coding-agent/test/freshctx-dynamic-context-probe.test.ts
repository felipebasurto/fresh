/**
 * Offline dynamic-context probe (hermetic protocol fixture).
 *
 * Proves the Fresh *adapter* native request-rewrite path when the engine is
 * `freshctx-fake-server.mjs` / the stale-projection sibling. It does **not**
 * prove the real `freshctx` engine; see
 * `freshctx-dynamic-context-real-engine.test.ts` for that.
 *
 * Success is measured from the captured HTTP request body only — never from
 * model text. Independent of a real LLM.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

const fakeServer = resolve(__dirname, "fixtures/freshctx-fake-server.mjs");
const probeStaleServer = resolve(__dirname, "fixtures/freshctx-dynamic-probe-stale-server.mjs");
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

type Captured = Array<{ messages: Array<Record<string, unknown>> }>;

/** Turn 0: emit a bounded read of config.py. Later turns: stop with no tools. */
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

async function openProbeSession(
	root: string,
	port: number,
	options?: { mode?: "native" | "off"; engineScript?: string },
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; errors: unknown[] }> {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("freshctx-dynamic-probe", {
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
	const model = modelRuntime.getModel("freshctx-dynamic-probe", "fixture");
	if (!model) {
		throw new Error("probe model not registered");
	}
	const engine = options?.engineScript ?? fakeServer;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		freshctx: {
			mode: options?.mode ?? "native",
			serverCommand: [process.execPath, engine],
			serverEnv: { FRESHCTX_FAKE_ROOT: root },
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

function countReadToolCalls(captured: Captured): number {
	let n = 0;
	for (const req of captured) {
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

describe("FreshCtx adapter dynamic-context probe (hermetic fake engine)", () => {
	it("injects current disk bytes into the next outgoing request after an external mutation", async () => {
		const root = createTempDir("pi-freshctx-dyn-");
		writeFileSync(join(root, "config.py"), "TARGET_RATE = 10\nOTHER = 1\n");
		const { server, port, captured } = await startCaptureServer();
		try {
			const { session, errors } = await openProbeSession(root, port, { mode: "native" });
			try {
				await session.prompt("Read the TARGET_RATE assignment in config.py.");
				// First user prompt + tool continuation = 2 provider requests.
				expect(captured.length).toBe(2);
				// The read appears in history starting at the tool-continuation request.
				expect(countReadToolCalls([captured[1]!])).toBe(1);

				// External mutation: agent did not edit; stale history still shows 10.
				writeFileSync(join(root, "config.py"), "TARGET_RATE = 12\nOTHER = 1\n");

				const beforeRefresh = captured.length;
				await session.prompt("Using only context you already have, what is TARGET_RATE?");
				expect(captured.length).toBe(beforeRefresh + 1);
				// Still exactly one historical read — no second read after the mutation.
				expect(countReadToolCalls([captured.at(-1)!])).toBe(1);

				const outgoing = JSON.stringify(captured.at(-1)?.messages);
				expect(outgoing).toContain("TARGET_RATE = 12");
				expect(outgoing).not.toContain("TARGET_RATE = 10");
				// Stale tool body is replaced by a FreshCtx marker, not raw source.
				expect(outgoing).toMatch(/\[u_/);

				const sessionFile = (session.sessionManager as SessionManager).getSessionFile();
				expect(sessionFile).toBeDefined();
				const revals = revalidationEntries(sessionFile as string);
				expect(revals.length).toBeGreaterThanOrEqual(1);
				const last = revals.at(-1)!;
				expect(last.outcome).toBe("STABLE");
				expect(last.blocked).toBe(false);
				expect(typeof last.prepareRequestIndex).toBe("number");
				expect(last.prepareRequestIndex).toBeGreaterThan(0);
				expect(Array.isArray(last.observedResultIds)).toBe(true);
				expect((last.observedResultIds as string[]).length).toBeGreaterThan(0);
				expect(typeof last.regionBytes).toBe("number");
				expect(last.regionBytes).toBeGreaterThan(0);
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 30000);

	it("negative control: FreshCtx off keeps stale TARGET_RATE = 10 in the outgoing payload", async () => {
		const root = createTempDir("pi-freshctx-dyn-off-");
		writeFileSync(join(root, "config.py"), "TARGET_RATE = 10\nOTHER = 1\n");
		const { server, port, captured } = await startCaptureServer();
		try {
			const { session, errors } = await openProbeSession(root, port, { mode: "off" });
			try {
				await session.prompt("Read the TARGET_RATE assignment in config.py.");
				writeFileSync(join(root, "config.py"), "TARGET_RATE = 12\nOTHER = 1\n");
				await session.prompt("Using only context you already have, what is TARGET_RATE?");
				expect(captured.length).toBe(3);
				expect(countReadToolCalls([captured.at(-1)!])).toBe(1);
				const outgoing = JSON.stringify(captured.at(-1)?.messages);
				expect(outgoing).toContain("TARGET_RATE = 10");
				expect(outgoing).not.toContain("TARGET_RATE = 12");
				const sessionFile = (session.sessionManager as SessionManager).getSessionFile();
				expect(sessionFile).toBeDefined();
				expect(revalidationEntries(sessionFile as string)).toEqual([]);
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 30000);

	it("blocks unprovable refresh before provider HTTP and records WRONG plan trace", async () => {
		const root = createTempDir("pi-freshctx-dyn-block-");
		writeFileSync(join(root, "config.py"), "TARGET_RATE = 10\nOTHER = 1\n");
		const { server, port, captured } = await startCaptureServer();
		try {
			const { session } = await openProbeSession(root, port, {
				mode: "native",
				engineScript: probeStaleServer,
			});
			try {
				await session.prompt("Read the TARGET_RATE assignment in config.py.");
				expect(captured.length).toBe(2);
				const httpAfterRead = captured.length;

				// Disk still holds the referent; engine projects an unrelated current region → WRONG.
				writeFileSync(join(root, "config.py"), "TARGET_RATE = 10\nOTHER = 1\n# unrelated\n");
				await session.prompt("Using only context you already have, what is TARGET_RATE?");

				// No additional provider HTTP: prepare blocked before dispatch.
				expect(captured.length).toBe(httpAfterRead);
				expect(countReadToolCalls([captured.at(-1)!])).toBe(1);

				const last = session.messages.at(-1);
				expect(last?.role).toBe("assistant");
				if (last?.role === "assistant") {
					expect(last.stopReason).toBe("error");
					expect(last.errorMessage ?? "").toMatch(/FreshCtx|drift/i);
				}

				const sessionFile = (session.sessionManager as SessionManager).getSessionFile();
				expect(sessionFile).toBeDefined();
				const revals = revalidationEntries(sessionFile as string);
				expect(revals.some((entry) => entry.outcome === "WRONG" && entry.blocked === true)).toBe(true);
				const blocked = revals.find((entry) => entry.blocked === true)!;
				expect(typeof blocked.prepareRequestIndex).toBe("number");
				expect(blocked.prepareRequestIndex).toBeGreaterThan(0);
				expect(blocked.planId).toBeTruthy();
			} finally {
				session.dispose();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 30000);
});

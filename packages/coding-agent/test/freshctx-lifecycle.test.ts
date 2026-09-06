import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { buildTextReadObservation } from "../src/core/freshctx/observations.ts";
import { FreshCtxRequestPreparer } from "../src/core/freshctx/prepare-context.ts";
import { FreshCtxRuntime } from "../src/core/freshctx/runtime.ts";
import { refreshSessionObservations } from "../src/core/freshctx/session-state.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../src/index.ts";

const fakeServer = resolve(__dirname, "fixtures/freshctx-fake-server.mjs");
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

async function startFixtureServer(): Promise<{ server: Server; port: number; captured: unknown[] }> {
	const captured: unknown[] = [];
	let turn = 0;
	const server = createServer(async (req, res) => {
		try {
			let body = "";
			for await (const chunk of req) body += chunk;
			captured.push(JSON.parse(body));
			const read = turn++ === 0;
			const delta = read
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "read_price",
								type: "function",
								function: {
									name: "read",
									arguments: JSON.stringify({ path: "price.py", offset: 1, limit: 2 }),
								},
							},
						],
					}
				: { role: "assistant", content: "Fixture response." };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: read ? "tool_calls" : "stop" }] })}\n\n`,
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
		throw new Error("fixture server did not bind");
	}
	return { server, port: address.port, captured };
}

async function openSession(
	root: string,
	port: number,
	options?: {
		mode?: "native" | "off";
		tools?: string[];
		sessionManager?: SessionManager;
		extraServerEnv?: Record<string, string>;
	},
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; errors: unknown[] }> {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("freshctx-fixture", {
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
	const model = modelRuntime.getModel("freshctx-fixture", "fixture");
	if (!model) {
		throw new Error("fixture model not registered");
	}
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		freshctx: {
			mode: options?.mode ?? "native",
			serverCommand: [process.execPath, fakeServer],
			serverEnv: {
				FRESHCTX_FAKE_ROOT: root,
				FRESHCTX_FAKE_PIDFILE: join(root, "fake.pid"),
				...options?.extraServerEnv,
			},
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
	const sessionManager = options?.sessionManager ?? SessionManager.create(root, join(root, "sessions"));
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		modelRuntime,
		model,
		thinkingLevel: "off",
		tools: options?.tools,
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

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

describe("native FreshCtx lifecycle", () => {
	it("resume across restart re-observes and refreshes; projections never persist", async () => {
		const root = createTempDir("pi-freshctx-resume-");
		writeFileSync(join(root, "price.py"), "RATE = 10\n");
		const { server, port, captured } = await startFixtureServer();
		try {
			const firstManager = SessionManager.create(root, join(root, "sessions"));
			const { session } = await openSession(root, port, { sessionManager: firstManager });
			try {
				await session.prompt("Read the first two lines of price.py.");
				expect(captured.length).toBe(2);
			} finally {
				session.dispose();
			}
			const sessionFile = firstManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			writeFileSync(join(root, "price.py"), "RATE = 20\n");
			const reopened = SessionManager.open(sessionFile as string);
			expect(reopened.getSessionId()).toBe(firstManager.getSessionId());
			const { session: resumed, errors } = await openSession(root, port, { sessionManager: reopened });
			try {
				await resumed.prompt("Inspect the code context already available.");
				const outgoing = JSON.stringify((captured.at(-1) as { messages: unknown }).messages);
				expect(outgoing).toContain("RATE = 20");
				expect(outgoing).not.toContain("RATE = 10");
				const saved = readFileSync(sessionFile as string, "utf-8");
				expect(saved).toContain("RATE = 10");
				expect(saved).not.toContain("RATE = 20");
				expect(saved).not.toMatch(/\[u_\d+\]/);
				expect(saved).not.toContain("--- price.py ---");
				expect(errors).toEqual([]);
			} finally {
				resumed.dispose();
			}
		} finally {
			await closeServer(server);
		}
	}, 30000);

	it("branch observations never leak into another branch payload", async () => {
		const root = createTempDir("pi-freshctx-branch-");
		writeFileSync(join(root, "a.txt"), "aaa\n");
		writeFileSync(join(root, "b.txt"), "bbb\n");
		const manager = SessionManager.create(root, join(root, "sessions"), { id: "branch-payload" });
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		const forkPoint = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const bufferA = Buffer.from("aaa\n", "utf-8");
		const linesA = "aaa\n".split("\n");
		manager.appendCustomEntry(
			"freshctx_obs",
			buildTextReadObservation({
				obsId: "read_A",
				absolutePath: join(root, "a.txt"),
				cwd: root,
				buffer: bufferA,
				allLines: linesA,
				startLine: 0,
				shownLineCount: linesA.length,
				totalFileLines: linesA.length,
				truncated: false,
				truncatedBy: null,
				userLimited: false,
				firstLineExceedsLimit: false,
				symlink: false,
			}),
		);
		manager.branch(forkPoint);
		const bufferB = Buffer.from("bbb\n", "utf-8");
		const linesB = "bbb\n".split("\n");
		manager.appendCustomEntry(
			"freshctx_obs",
			buildTextReadObservation({
				obsId: "read_B",
				absolutePath: join(root, "b.txt"),
				cwd: root,
				buffer: bufferB,
				allLines: linesB,
				startLine: 0,
				shownLineCount: linesB.length,
				totalFileLines: linesB.length,
				truncated: false,
				truncatedBy: null,
				userLimited: false,
				firstLineExceedsLimit: false,
				symlink: false,
			}),
		);
		const { active } = refreshSessionObservations(manager.getBranch(), manager.getCwd());
		expect(active.map((obs) => obs.obsId)).toEqual(["read_B"]);
		writeFileSync(join(root, "b.txt"), "BBB\n");
		const runtime = await FreshCtxRuntime.start({
			server: { command: process.execPath, args: [fakeServer] },
			root,
			sessionId: "branch-test",
			adapter: "test/openai-completions",
			env: { ...process.env, FRESHCTX_FAKE_ROOT: root },
		});
		try {
			const preparer = new FreshCtxRequestPreparer(runtime);
			const payload = {
				model: "fixture",
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{ id: "read_A", type: "function", function: { name: "read", arguments: "{}" } },
							{ id: "read_B", type: "function", function: { name: "read", arguments: "{}" } },
						],
					},
					{ role: "tool", tool_call_id: "read_A", content: "aaa\n" },
					{ role: "tool", tool_call_id: "read_B", content: "bbb\n" },
					{ role: "user", content: "go" },
				],
			};
			const result = (await preparer.prepare(payload, active)) as { messages: Array<{ content?: unknown }> };
			const outgoing = JSON.stringify(result.messages);
			expect(outgoing).toContain("aaa\\n");
			expect(outgoing).not.toContain("bbb\\n");
			expect(outgoing).toContain("BBB\\n");
		} finally {
			await runtime.close();
		}
	}, 30000);

	it("child crash blocks the next request with zero new HTTP", async () => {
		const root = createTempDir("pi-freshctx-crash-");
		writeFileSync(join(root, "price.py"), "RATE = 10\n");
		const { server, port, captured } = await startFixtureServer();
		try {
			const { session } = await openSession(root, port, { tools: ["read"] });
			try {
				await session.prompt("Read the first two lines of price.py.");
				expect(captured.length).toBe(2);
				const pid = Number(readFileSync(join(root, "fake.pid"), "utf-8").trim());
				expect(Number.isSafeInteger(pid)).toBe(true);
				process.kill(pid, "SIGKILL");
				await session.prompt("Inspect the code context already available.");
				expect(captured.length).toBe(2);
				const last = session.messages.at(-1);
				expect(last?.role).toBe("assistant");
				if (last?.role === "assistant") {
					expect(last.stopReason).toBe("error");
					expect(last.errorMessage ?? "").toContain("FreshCtx");
				}
			} finally {
				session.dispose();
			}
		} finally {
			await closeServer(server);
		}
	}, 30000);

	it("dispose reaps the server child", async () => {
		const root = createTempDir("pi-freshctx-shutdown-");
		writeFileSync(join(root, "price.py"), "RATE = 10\n");
		const { server, port, captured } = await startFixtureServer();
		try {
			const { session } = await openSession(root, port, { tools: ["read"] });
			await session.prompt("Read the first two lines of price.py.");
			expect(captured.length).toBe(2);
			const pid = Number(readFileSync(join(root, "fake.pid"), "utf-8").trim());
			session.dispose();
			let alive = true;
			for (let attempt = 0; attempt < 30; attempt++) {
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
					break;
				}
				await sleep(100);
			}
			expect(alive).toBe(false);
		} finally {
			await closeServer(server);
		}
	}, 30000);

	it("abort during preparation sends zero HTTP and settles", async () => {
		const root = createTempDir("pi-freshctx-abort-");
		writeFileSync(join(root, "price.py"), "RATE = 10\n");
		const { server, port, captured } = await startFixtureServer();
		try {
			const { session } = await openSession(root, port, {
				tools: ["read"],
				extraServerEnv: { FRESHCTX_FAKE_DELAY_MS: "5000" },
			});
			try {
				const pending = session.prompt("Read the first two lines of price.py.");
				setTimeout(() => void session.abort(), 400);
				const outcome = await pending.then(
					(): unknown => "resolved",
					(error: unknown): unknown => error,
				);
				expect(captured.length).toBe(0);
				if (typeof outcome === "string") {
					const last = session.messages.at(-1);
					expect(["aborted", "error"]).toContain(
						last?.role === "assistant" ? last.stopReason : "no-assistant-message",
					);
				} else {
					expect(String(outcome)).toMatch(/abort/i);
				}
			} finally {
				session.dispose();
			}
		} finally {
			await closeServer(server);
		}
	}, 30000);

	it("registers recover and inspect tools in native mode (opt-in activation)", async () => {
		const root = createTempDir("pi-freshctx-tools-");
		const { server, port } = await startFixtureServer();
		try {
			const { session: defaultSession } = await openSession(root, port);
			try {
				// Unregistered by default: existing tool-surface contracts stay exact.
				expect(defaultSession.getActiveToolNames()).not.toContain("freshctx_recover");
				expect(defaultSession.getActiveToolNames()).not.toContain("freshctx_inspect");
				expect(defaultSession.getAllTools().map((tool) => tool.name)).not.toContain("freshctx_recover");
			} finally {
				defaultSession.dispose();
			}
			const { session: optedIn } = await openSession(root, port, {
				tools: ["read", "freshctx_recover", "freshctx_inspect"],
			});
			try {
				expect(optedIn.getActiveToolNames()).toContain("freshctx_recover");
				expect(optedIn.getActiveToolNames()).toContain("freshctx_inspect");
			} finally {
				optedIn.dispose();
			}
			const { session: offSession } = await openSession(root, port, { mode: "off" });
			try {
				expect(offSession.getActiveToolNames()).not.toContain("freshctx_recover");
				expect(offSession.getActiveToolNames()).not.toContain("freshctx_inspect");
			} finally {
				offSession.dispose();
			}
		} finally {
			await closeServer(server);
		}
	});
});

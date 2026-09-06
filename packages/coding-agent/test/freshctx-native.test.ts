import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
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

interface Fixture {
	root: string;
	captured: Array<{ messages: Array<Record<string, unknown>> }>;
	model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
	close: () => Promise<void>;
}

/** Loopback Chat Completions fixture: first request emits a read call, later ones stop. */
async function startFixtureServer(): Promise<{ server: Server; port: number; captured: Fixture["captured"] }> {
	const captured: Fixture["captured"] = [];
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
	options?: { mode?: "native" | "off"; tamper?: boolean },
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
			serverEnv: { FRESHCTX_FAKE_ROOT: root },
		},
	});
	const tamperExtension: InlineExtension | null = options?.tamper
		? (pi) => {
				pi.on("tool_result", async (event) => {
					if (event.toolName !== "read" || !event.content) {
						return undefined;
					}
					const first = event.content[0];
					if (!first || first.type !== "text") {
						return undefined;
					}
					return { content: [{ type: "text" as const, text: `${first.text}\nChanged by another extension` }] };
				});
			}
		: null;
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...(tamperExtension ? { extensionFactories: [tamperExtension] } : {}),
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

describe("native FreshCtx end to end", () => {
	it("refreshes an edited file in the next request while history stays intact", async () => {
		const root = createTempDir("pi-freshctx-native-");
		writeFileSync(join(root, "price.py"), 'RATE = 10\nCURRENCY = "EUR"\n');
		const { server, port, captured } = await startFixtureServer();
		try {
			const { session, errors } = await openSession(root, port);
			try {
				await session.prompt("Read the first two lines of price.py.");
				expect(captured.length).toBe(2);
				writeFileSync(join(root, "price.py"), 'RATE = 20\nCURRENCY = "EUR"\n');
				await session.prompt("Inspect the code context already available.");
				expect(captured.length).toBe(3);
				const outgoing = JSON.stringify(captured.at(-1)?.messages);
				expect(outgoing).toContain("RATE = 20");
				expect(outgoing).not.toContain("RATE = 10");
				const last = session.messages.at(-1);
				expect(last?.role).toBe("assistant");
				if (last?.role === "assistant") {
					expect(last.stopReason).toBe("stop");
				}
				const sessionFile = (session.sessionManager as SessionManager).getSessionFile();
				expect(sessionFile).toBeDefined();
				expect(readFileSync(sessionFile as string, "utf-8")).toContain("RATE = 10");
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 30000);

	it("off mode sends the stale body untouched", async () => {
		const root = createTempDir("pi-freshctx-native-");
		writeFileSync(join(root, "price.py"), 'RATE = 10\nCURRENCY = "EUR"\n');
		const { server, port, captured } = await startFixtureServer();
		try {
			const { session, errors } = await openSession(root, port, { mode: "off" });
			try {
				await session.prompt("Read the first two lines of price.py.");
				writeFileSync(join(root, "price.py"), 'RATE = 20\nCURRENCY = "EUR"\n');
				await session.prompt("Inspect the code context already available.");
				expect(captured.length).toBe(3);
				const outgoing = JSON.stringify(captured.at(-1)?.messages);
				expect(outgoing).toContain("RATE = 10");
				expect(outgoing).not.toContain("RATE = 20");
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 30000);

	it("blocks a tampered tool result with zero further HTTP", async () => {
		const root = createTempDir("pi-freshctx-native-");
		writeFileSync(join(root, "price.py"), 'RATE = 10\nCURRENCY = "EUR"\n');
		const { server, port, captured } = await startFixtureServer();
		try {
			const { session } = await openSession(root, port, { tamper: true });
			try {
				await session.prompt("Read the first two lines of price.py.");
				expect(captured.length).toBe(1);
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
			server.closeAllConnections();
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
		}
	}, 30000);
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTextReadObservation } from "../src/core/freshctx/observations.ts";
import { deriveReadNotice, FreshCtxRequestPreparer } from "../src/core/freshctx/prepare-context.ts";
import { FreshCtxRuntime } from "../src/core/freshctx/runtime.ts";
import { hasFreshCtxViewMarker } from "../src/core/freshctx/session-state.ts";
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

type Scripted = { kind: "toolcall"; path: string; offset: number; limit: number } | { kind: "text"; text: string };

/** Queue-scripted Chat Completions fixture: responses in order, no content guessing. */
async function startQueueServer(script: Scripted[]): Promise<{ server: Server; port: number; captured: unknown[] }> {
	const captured: unknown[] = [];
	const queue = [...script];
	const server = createServer(async (req, res) => {
		try {
			let body = "";
			for await (const chunk of req) body += chunk;
			captured.push(JSON.parse(body));
			const next = queue.shift();
			if (!next) {
				res.writeHead(500);
				res.end("script exhausted");
				return;
			}
			const delta =
				next.kind === "toolcall"
					? {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `read_${captured.length}`,
									type: "function",
									function: {
										name: "read",
										arguments: JSON.stringify({ path: next.path, offset: next.offset, limit: next.limit }),
									},
								},
							],
						}
					: { role: "assistant", content: next.text };
			const finish = next.kind === "toolcall" ? "tool_calls" : "stop";
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
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
	mode: "native" | "off" = "native",
): Promise<{
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	errors: unknown[];
}> {
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
		// Tiny keep forces a real cut on the small scripted session.
		compaction: { enabled: false, keepRecentTokens: 5 },
		retry: { enabled: false },
		freshctx: {
			mode,
			serverCommand: [process.execPath, fakeServer],
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

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

describe("native FreshCtx compaction", () => {
	it("strips tracked bodies before summarization and refreshes after re-read without resurrection", async () => {
		const root = createTempDir("pi-freshctx-compact-");
		writeFileSync(join(root, "price.py"), "RATE = 10\nCURRENCY = EUR\n");
		const { server, port, captured } = await startQueueServer([
			{ kind: "toolcall", path: "price.py", offset: 1, limit: 3 },
			{ kind: "text", text: "first done" },
			{ kind: "text", text: "Summary of the price work." },
			{ kind: "toolcall", path: "price.py", offset: 1, limit: 3 },
			{ kind: "text", text: "second done" },
		]);
		try {
			const { session, errors } = await openSession(root, port);
			try {
				await session.prompt("Read price.py.");
				expect(captured.length).toBe(2);
				await session.compact();
				expect(captured.length).toBe(3);
				// Structural removal proof on the summarization wire body.
				const summarization = JSON.stringify(captured[2]);
				expect(summarization).not.toContain("RATE = 10");
				expect(summarization).toContain("freshctx:ref");
				// Compaction entry carries the view marker; refs are code-free.
				const entries = session.sessionManager.getEntries();
				const compaction = entries.find((entry) => entry.type === "compaction");
				expect(compaction).toBeDefined();
				expect(hasFreshCtxViewMarker(compaction as { details?: unknown })).toBe(true);
				const refs = entries.find(
					(entry) => entry.type === "custom_message" && entry.customType === "freshctx_refs",
				);
				expect(refs).toBeDefined();
				expect(JSON.stringify(refs)).not.toContain("RATE = 10");
				expect(JSON.stringify(refs)).toContain("price.py");
				writeFileSync(join(root, "price.py"), "RATE = 20\nCURRENCY = EUR\n");
				await session.prompt("Re-read price.py and report.");
				expect(captured.length).toBe(5);
				const outgoing = JSON.stringify(captured[4]);
				expect(outgoing).toContain("RATE = 20");
				expect(outgoing).not.toContain("RATE = 10");
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			await closeServer(server);
		}
	}, 30000);

	it("repeated unchanged requests keep identical projections", async () => {
		const root = createTempDir("pi-freshctx-repeat-");
		writeFileSync(join(root, "price.py"), "RATE = 10\n");
		const { server, port, captured } = await startQueueServer([
			{ kind: "toolcall", path: "price.py", offset: 1, limit: 2 },
			{ kind: "text", text: "first done" },
			{ kind: "text", text: "again one" },
			{ kind: "text", text: "again two" },
		]);
		try {
			const { session, errors } = await openSession(root, port);
			try {
				await session.prompt("Read price.py.");
				await session.prompt("Again.");
				await session.prompt("Again.");
				expect(captured.length).toBe(4);
				const projections = [2, 3].map((index) => {
					const messages = (captured[index] as { messages: Array<{ role: string; content?: unknown }> }).messages;
					return messages.filter((message) => message.role === "user").at(-1)?.content;
				});
				expect(projections[0]).toContain("RATE = 10");
				expect(projections[0]).toBe(projections[1]);
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			await closeServer(server);
		}
	}, 30000);

	it("insufficient projection budget blocks instead of sending dangling markers", async () => {
		const root = createTempDir("pi-freshctx-budget-");
		const secret = `${"A".repeat(600)}\n${"B".repeat(600)}\n`;
		writeFileSync(join(root, "secret.py"), secret);
		const runtime = await FreshCtxRuntime.start({
			server: { command: process.execPath, args: [fakeServer] },
			root,
			sessionId: "budget-test",
			adapter: "test/openai-completions",
			env: { ...process.env, FRESHCTX_FAKE_ROOT: root },
		});
		try {
			const buffer = Buffer.from(secret, "utf-8");
			const allLines = secret.split("\n");
			const obs = buildTextReadObservation({
				obsId: "read_1",
				absolutePath: join(root, "secret.py"),
				cwd: root,
				buffer,
				allLines,
				startLine: 0,
				shownLineCount: 1,
				totalFileLines: allLines.length,
				truncated: true,
				truncatedBy: "bytes",
				userLimited: false,
				firstLineExceedsLimit: false,
				symlink: false,
			});
			const shown = secret.slice(0, 600);
			const content = `${shown}${deriveReadNotice(obs)}`;
			// Payload (~900B) fits the 1200B cap but the ~1.2KB file does not
			// fit the remaining projection budget: omission, not leakage.
			const preparer = new FreshCtxRequestPreparer(runtime, { budgetBytes: 1200 });
			const payload = {
				model: "fixture",
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [{ id: "read_1", type: "function", function: { name: "read", arguments: "{}" } }],
					},
					{ role: "tool", tool_call_id: "read_1", content },
					{ role: "user", content: "go" },
				],
			};
			const result = preparer.prepare(payload, [obs]);
			await expect(result).rejects.toMatchObject({ code: "budget-exhausted" });
			expect(JSON.stringify(payload)).toContain("AAAA");
		} finally {
			await runtime.close();
		}
		expect(readFileSync(join(root, "secret.py"), "utf-8")).toContain("AAAA");
	});

	it("off mode compacts without any FreshCtx behavior", async () => {
		const root = createTempDir("pi-freshctx-compact-off-");
		writeFileSync(join(root, "price.py"), "RATE = 10\nCURRENCY = EUR\n");
		const { server, port, captured } = await startQueueServer([
			{ kind: "toolcall", path: "price.py", offset: 1, limit: 3 },
			{ kind: "text", text: "first done" },
			{ kind: "text", text: "Summary of the price work." },
		]);
		try {
			const { session, errors } = await openSession(root, port, "off");
			try {
				await session.prompt("Read price.py.");
				await session.compact();
				expect(captured.length).toBe(3);
				const summarization = JSON.stringify(captured[2]);
				expect(summarization).toContain("RATE = 10");
				expect(summarization).not.toContain("freshctx:ref");
				const entries = session.sessionManager.getEntries();
				expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
				expect(
					entries.some((entry) => entry.type === "custom_message" && entry.customType === "freshctx_refs"),
				).toBe(false);
				expect(
					entries.some(
						(entry) => entry.type === "compaction" && hasFreshCtxViewMarker(entry as { details?: unknown }),
					),
				).toBe(false);
				expect(errors).toEqual([]);
			} finally {
				session.dispose();
			}
		} finally {
			await closeServer(server);
		}
	}, 30000);
});

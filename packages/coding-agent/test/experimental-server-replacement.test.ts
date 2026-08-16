import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { runClient } from "../src/cli/experimental/client.ts";
import { configureExperimentalWorkerModel, createExperimentalSessions } from "./experimental-session-support.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const processes = new Set<ChildProcess>();
const directories = new Set<string>();

interface RunningCli {
	readonly child: ChildProcess;
	readonly output: () => string;
	readonly errors: () => string;
}

async function startServer(home: string, agentDir: string, serverDir: string): Promise<RunningCli> {
	const child = spawn(process.execPath, ["--import", "tsx", cliPath, "server"], {
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		env: {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PI_EXPERIMENTAL: "1",
			PI_SERVER_DIR: serverDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	processes.add(child);
	let output = "";
	let errors = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		errors += chunk;
	});
	return { child, output: () => output, errors: () => errors };
}

async function waitForOutput(process: RunningCli, pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
	const existing = process.output().match(pattern);
	if (existing) return existing;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(
				new Error(`Timed out waiting for ${pattern}; stdout: ${process.output()}; stderr: ${process.errors()}`),
			);
		}, timeoutMs);
		const inspect = (): void => {
			const match = process.output().match(pattern);
			if (!match) return;
			cleanup();
			resolve(match);
		};
		const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
			cleanup();
			reject(
				new Error(
					`Server exited before ${pattern} (${signal ?? code ?? "unknown"}); stdout: ${process.output()}; stderr: ${process.errors()}`,
				),
			);
		};
		const cleanup = (): void => {
			clearTimeout(timeout);
			process.child.stdout?.off("data", inspect);
			process.child.off("exit", exited);
		};
		process.child.stdout?.on("data", inspect);
		process.child.once("exit", exited);
	});
}

async function waitForExit(process: ChildProcess): Promise<void> {
	if (process.exitCode !== null || process.signalCode !== null) return;
	await once(process, "exit");
}

async function stop(process: ChildProcess): Promise<void> {
	if (process.exitCode !== null || process.signalCode !== null) return;
	const exited = once(process, "exit");
	process.kill("SIGTERM");
	await exited;
}

afterEach(async () => {
	await Promise.all([...processes].map((process) => stop(process)));
	processes.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe.skipIf(process.platform === "win32")("experimental CLI server replacement", () => {
	test("a second CLI server takes over the stable coordinator socket", async () => {
		const root = await mkdtemp(join("/tmp", "pcs-"));
		directories.add(root);
		const home = join(root, "long-home-segment".repeat(8));
		await mkdir(home);
		const agentDir = join(root, "agent");
		const serverDir = join(root, "server");
		await configureExperimentalWorkerModel(agentDir);
		await createExperimentalSessions(join(agentDir, "experimental", "sessions"), ["demo-1", "demo-2"]);
		const first = await startServer(home, agentDir, serverDir);
		const firstIdentity = await waitForOutput(
			first,
			/Server: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/,
		);
		const firstSocket = await waitForOutput(first, /Socket: (.+\.sock)/);
		expect(firstSocket[1]).toBe(join(serverDir, `${firstIdentity[1]}.sock`));
		expect((await lstat(join(serverDir, `control-${firstIdentity[1]}.sock`))).isSocket()).toBe(true);
		await runClient({
			command: "client",
			sessionId: "demo-1",
			connect: { transport: "unix", path: firstSocket[1]! },
		});

		const replacement = await startServer(home, agentDir, serverDir);
		const replacementIdentity = await waitForOutput(
			replacement,
			/Server: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/,
		);
		const replacementSocket = await waitForOutput(replacement, /Socket: (.+\.sock)/);
		await waitForExit(first.child);

		expect(replacementIdentity[1]).toBe(firstIdentity[1]);
		expect(replacementSocket[1]).toBe(firstSocket[1]);
		expect(replacement.child.pid).not.toBe(first.child.pid);
		await expect(
			runClient({
				command: "client",
				connect: { transport: "unix", path: replacementSocket[1]! },
			}),
		).resolves.toMatchObject({
			kind: "list",
			sessions: [
				{ serverId: firstIdentity[1], sessionId: "demo-1" },
				{ serverId: firstIdentity[1], sessionId: "demo-2" },
			],
		});
		await expect(
			runClient({
				command: "client",
				sessionId: "demo-1",
				connect: { transport: "unix", path: replacementSocket[1]! },
			}),
		).resolves.toMatchObject({ kind: "attached", sessionId: "demo-1" });
	});
});

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import type { SessionWorkerCommand, SessionWorkerEvent } from "./session-worker-process.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const WorkerControlInputSchema = Type.Union([
	Type.Object({ type: Type.Literal("worker_failed"), message: Type.String() }),
	Type.Object({ type: Type.Literal("worker_ready"), sessionId: Type.String(), pid: Type.Integer({ minimum: 1 }) }),
	Type.Object({
		type: Type.Literal("register_worker"),
		protocol: Type.Literal(1),
		token: Type.String(),
		sessionId: Type.String(),
		pid: Type.Integer({ minimum: 1 }),
	}),
]);
type WorkerControlInput = Static<typeof WorkerControlInputSchema>;
export const SESSION_WORKER_CONTROL_ADDRESS_ENV = "PI_SESSION_WORKER_CONTROL_ADDRESS";
export const SESSION_WORKER_CONTROL_TOKEN_ENV = "PI_SESSION_WORKER_CONTROL_TOKEN";
export const SESSION_WORKER_SESSION_KEY_ENV = "PI_SESSION_WORKER_SESSION_KEY_BASE64";
export const SESSION_WORKER_COORDINATED_ENV = "PI_SESSION_WORKER_COORDINATED";
export const SESSION_WORKER_PEER_ID_ENV = "PI_SESSION_WORKER_PEER_ID";

export interface ExperimentalSessionWorker {
	readonly sessionId: string;
	readonly pid: number;
	readonly terminated: Promise<Error | undefined>;
	close(): Promise<void>;
}

export interface SessionWorkerLaunchSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

export interface StartExperimentalSessionWorkerOptions {
	readonly sessionDir: string;
	readonly startupTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly workerUrl?: URL;
}

export function createExperimentalSessionWorkerLaunchSpec(
	metadata: JsonlSessionMetadata,
	options: Pick<StartExperimentalSessionWorkerOptions, "sessionDir" | "workerUrl">,
): SessionWorkerLaunchSpec {
	if (!isAbsolute(options.sessionDir)) throw new TypeError("Session worker sessionDir must be absolute");
	const workerUrl =
		options.workerUrl ??
		new URL(
			import.meta.url.endsWith(".js") ? "session-worker-process.js" : "session-worker-process.ts",
			import.meta.url,
		);
	return {
		command: process.execPath,
		args: [
			...(workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : []),
			fileURLToPath(workerUrl),
			options.sessionDir,
			JSON.stringify(metadata),
		],
		cwd: process.cwd(),
		env: Object.fromEntries(
			Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
		),
	};
}

export async function startExperimentalSessionWorker(
	metadata: JsonlSessionMetadata,
	options: StartExperimentalSessionWorkerOptions,
): Promise<ExperimentalSessionWorker> {
	const startupTimeoutMs = validateTimeout(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
	const shutdownTimeoutMs = validateTimeout(
		options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
		"shutdownTimeoutMs",
	);
	const launch = createExperimentalSessionWorkerLaunchSpec(metadata, options);
	const token = randomUUID();
	const controlId = randomUUID();
	const controlAddress =
		process.platform === "win32" ? `\\\\.\\pipe\\pi-worker-${controlId}` : join(tmpdir(), `pi-w-${controlId}.sock`);
	const control = await createWorkerControlServer(controlAddress, token, metadata.id);
	let child: ChildProcess;
	try {
		child = spawn(launch.command, launch.args, {
			cwd: launch.cwd,
			detached: true,
			env: {
				...launch.env,
				[SESSION_WORKER_CONTROL_ADDRESS_ENV]: controlAddress,
				[SESSION_WORKER_CONTROL_TOKEN_ENV]: token,
				[SESSION_WORKER_SESSION_KEY_ENV]: Buffer.from(metadata.path).toString("base64url"),
			},
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	} catch (error) {
		await control.close();
		throw error;
	}

	try {
		const ready = await waitForReady(child, control, metadata.id, startupTimeoutMs);
		return new SpawnedSessionWorker(child, control, ready.sessionId, ready.pid, shutdownTimeoutMs);
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await waitForExit(child);
		await control.close();
		throw error;
	}
}

function validateTimeout(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
		throw new TypeError(`Session worker ${name} must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return value;
}

type WorkerControllerEvent = SessionWorkerEvent | { type: "hello"; token: string; sessionId: string; pid: number };

interface WorkerControlServer {
	readonly connected: Promise<Socket>;
	readonly events: AsyncIterable<WorkerControllerEvent>;
	send(message: SessionWorkerCommand): Promise<void>;
	close(): Promise<void>;
}

async function createWorkerControlServer(
	address: string,
	token: string,
	expectedSessionId: string,
): Promise<WorkerControlServer> {
	let accepted: Socket | undefined;
	let resolveConnected!: (socket: Socket) => void;
	const connected = new Promise<Socket>((resolve) => {
		resolveConnected = resolve;
	});
	const messages: WorkerControllerEvent[] = [];
	const waiters: ((message: WorkerControllerEvent) => void)[] = [];
	const server = createServer((socket) => {
		if (accepted) {
			socket.destroy();
			return;
		}
		accepted = socket;
		resolveConnected(socket);
		attachJsonLineReader(socket, (value) => {
			if (!Check(WorkerControlInputSchema, value)) {
				socket.destroy(new Error("Session worker sent an invalid control message"));
				return;
			}
			const message: WorkerControlInput = value;
			let event: WorkerControllerEvent;
			if (message.type === "worker_failed") {
				event = { type: "failed", message: message.message };
			} else if (message.type === "worker_ready") {
				event = { type: "ready", sessionId: message.sessionId, pid: message.pid };
			} else {
				event = {
					type: "hello",
					token: message.token,
					sessionId: message.sessionId,
					pid: message.pid,
				};
			}
			if (event.type === "hello" && (event.token !== token || event.sessionId !== expectedSessionId)) {
				socket.destroy(new Error("Session worker sent invalid control credentials"));
				return;
			}
			const waiter = waiters.shift();
			if (waiter) waiter(event);
			else messages.push(event);
		});
	});
	await listen(server, address);
	if (process.platform !== "win32") await chmod(address, 0o600);

	let closePromise: Promise<void> | undefined;
	return {
		connected,
		events: {
			[Symbol.asyncIterator]() {
				return {
					next: async () => {
						const message =
							messages.shift() ??
							(await new Promise<(typeof messages)[number]>((resolve) => waiters.push(resolve)));
						return { done: false as const, value: message };
					},
				};
			},
		},
		async send(message) {
			const socket = await connected;
			await new Promise<void>((resolve, reject) => {
				socket.write(`${JSON.stringify(message)}\n`, (error) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
		close() {
			closePromise ??= closeWorkerControl(server, accepted, address);
			return closePromise;
		},
	};
}

async function waitForReady(
	child: ChildProcess,
	control: WorkerControlServer,
	expectedSessionId: string,
	startupTimeoutMs: number,
): Promise<Extract<SessionWorkerEvent, { type: "ready" }>> {
	const events = control.events[Symbol.asyncIterator]();
	const startup = (async () => {
		const hello = (await events.next()).value;
		if (hello.type !== "hello" || hello.sessionId !== expectedSessionId || hello.pid !== child.pid) {
			throw new Error("Session worker reported an invalid identity");
		}
		const event = (await events.next()).value;
		if (event.type === "failed") throw new Error(`Session worker failed: ${event.message}`);
		if (event.type !== "ready" || event.sessionId !== expectedSessionId || event.pid !== child.pid) {
			throw new Error("Session worker reported an invalid identity");
		}
		return event;
	})();
	const exited = waitForExit(child).then(({ code, signal }) => {
		throw new Error(`Session worker exited before readiness (${signal ?? code ?? "unknown"})`);
	});
	let timeout: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() => reject(new Error(`Session worker startup timed out after ${startupTimeoutMs}ms`)),
			startupTimeoutMs,
		);
		timeout.unref();
	});
	try {
		return await Promise.race([startup, exited, timedOut]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

class SpawnedSessionWorker implements ExperimentalSessionWorker {
	readonly terminated: Promise<Error | undefined>;
	readonly sessionId: string;
	readonly pid: number;
	readonly #child: ChildProcess;
	readonly #control: WorkerControlServer;
	readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	readonly #shutdownTimeoutMs: number;
	#closePromise?: Promise<void>;
	#closeRequested = false;

	constructor(
		child: ChildProcess,
		control: WorkerControlServer,
		sessionId: string,
		pid: number,
		shutdownTimeoutMs: number,
	) {
		this.#child = child;
		this.#control = control;
		this.sessionId = sessionId;
		this.pid = pid;
		this.#shutdownTimeoutMs = shutdownTimeoutMs;
		this.#exit = waitForExit(child);
		this.terminated = this.#exit.then(async ({ code, signal }) => {
			await this.#control.close();
			return this.#closeRequested
				? undefined
				: new Error(`Session worker ${sessionId} exited unexpectedly (${signal ?? code ?? "unknown"})`);
		});
	}

	close(): Promise<void> {
		this.#closeRequested = true;
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#child.exitCode === null && this.#child.signalCode === null) {
			await this.#control.send({ type: "shutdown" }).catch(() => this.#child.kill("SIGKILL"));
			const timeout = setTimeout(() => this.#child.kill("SIGKILL"), this.#shutdownTimeoutMs);
			timeout.unref();
			try {
				await this.#exit;
			} finally {
				clearTimeout(timeout);
			}
		}
		await this.#control.close();
	}
}

function attachJsonLineReader(socket: Socket, onMessage: (message: unknown) => void): void {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			try {
				onMessage(JSON.parse(line));
			} catch {
				socket.destroy(new Error("Session worker sent invalid JSON"));
				return;
			}
		}
	});
}

function listen(server: Server, address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(address);
	});
}

async function closeWorkerControl(server: Server, socket: Socket | undefined, address: string): Promise<void> {
	socket?.destroy();
	if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (process.platform !== "win32") await unlink(address).catch(() => undefined);
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

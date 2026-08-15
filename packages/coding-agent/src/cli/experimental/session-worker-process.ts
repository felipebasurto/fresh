import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import lockfile from "proper-lockfile";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { ModelRuntime } from "../../core/model-runtime.ts";
import {
	SESSION_WORKER_CONTROL_ADDRESS_ENV,
	SESSION_WORKER_CONTROL_TOKEN_ENV,
	SESSION_WORKER_COORDINATED_ENV,
	SESSION_WORKER_PEER_ID_ENV,
	SESSION_WORKER_SESSION_KEY_ENV,
} from "./session-worker.ts";

// Process lifecycle control only. Agent operations use the shared
// transport-independent protocol rather than this channel.
export type SessionWorkerCommand = { type: "shutdown" };
export type SessionWorkerEvent =
	| { type: "ready"; sessionId: string; pid: number }
	| { type: "failed"; message: string };

const WorkerMetadataSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	createdAt: Type.Integer(),
	storageVersion: Type.Integer(),
	cwd: Type.String(),
	path: Type.String(),
	modifiedAt: Type.Number(),
	parentSessionId: Type.Optional(Type.String()),
	legacyParentSessionPath: Type.Optional(Type.String()),
});
const CoordinatorInputSchema = Type.Union([
	Type.Object({ type: Type.Literal("peer_registered"), peerId: Type.String() }),
	Type.Object({ type: Type.Literal("message"), from: Type.Literal("server"), payload: Type.Unknown() }),
]);
const WorkerCommandSchema = Type.Union([
	Type.Object({ type: Type.Literal("shutdown") }),
	Type.Object({ type: Type.Literal("discover_workers") }),
]);
type CoordinatorInput = Static<typeof CoordinatorInputSchema>;
type WorkerCommand = Static<typeof WorkerCommandSchema>;

type SessionWorkerControlEvent =
	| {
			type: "register_worker";
			protocol: 1;
			token: string;
			sessionKey: string;
			sessionId: string;
			pid: number;
	  }
	| {
			type: "worker_ready";
			token: string;
			sessionKey: string;
			sessionId: string;
			pid: number;
			metadata: JsonlSessionMetadata;
	  }
	| { type: "worker_failed"; token: string; sessionKey: string; message: string };

interface WorkerControl {
	readonly coordinated: boolean;
	readonly messages: AsyncIterable<unknown>;
	readonly socket: Socket;
	send(event: SessionWorkerControlEvent): Promise<void>;
}

let failureControl: WorkerControl | undefined;

async function connectControl(): Promise<WorkerControl> {
	const address = process.env[SESSION_WORKER_CONTROL_ADDRESS_ENV];
	const token = process.env[SESSION_WORKER_CONTROL_TOKEN_ENV];
	const encodedSessionKey = process.env[SESSION_WORKER_SESSION_KEY_ENV];
	if (!address || !token || !encodedSessionKey) throw new Error("Session worker requires a control address");
	const socket = createConnection(address);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const messages = createJsonLineMessages(socket);
	const coordinated = process.env[SESSION_WORKER_COORDINATED_ENV] === "1";
	if (coordinated) {
		const peerId = process.env[SESSION_WORKER_PEER_ID_ENV];
		if (!peerId) throw new Error("Coordinated session worker requires a peer ID");
		await writeJsonLine(socket, { type: "register_peer", protocol: 1, peerId });
		const registered = await messages[Symbol.asyncIterator]().next();
		if (
			registered.done ||
			!Check(CoordinatorInputSchema, registered.value) ||
			registered.value.type !== "peer_registered"
		) {
			throw new Error("Coordinator rejected the session worker registration");
		}
	}
	return {
		coordinated,
		messages,
		socket,
		send: (event) => writeJsonLine(socket, coordinated ? { type: "send", to: "server", payload: event } : event),
	};
}

async function readCommands(control: WorkerControl, onShutdown: () => void, onDiscovery: () => void): Promise<void> {
	for await (const value of control.messages) {
		if (!control.coordinated) {
			if (Check(WorkerCommandSchema, value) && value.type === "shutdown") onShutdown();
			continue;
		}
		if (!Check(CoordinatorInputSchema, value)) {
			control.socket.destroy(new Error("Coordinator sent an invalid worker message"));
			return;
		}
		const message: CoordinatorInput = value;
		if (message.type !== "message" || !Check(WorkerCommandSchema, message.payload)) continue;
		const command: WorkerCommand = message.payload;
		if (command.type === "shutdown") onShutdown();
		else onDiscovery();
	}
}

function createJsonLineMessages(socket: Socket): AsyncIterable<unknown> {
	const queued: unknown[] = [];
	const waiters: ((value: unknown) => void)[] = [];
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
				const value: unknown = JSON.parse(line);
				const waiter = waiters.shift();
				if (waiter) waiter(value);
				else queued.push(value);
			} catch {
				socket.destroy(new Error("Session worker received invalid control JSON"));
				return;
			}
		}
	});
	return {
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					const value = queued.shift() ?? (await new Promise<unknown>((resolve) => waiters.push(resolve)));
					return { done: false as const, value };
				},
			};
		},
	};
}

function writeJsonLine(socket: Socket, message: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

function parseMetadata(value: string | undefined): JsonlSessionMetadata {
	if (value === undefined) throw new Error("Session worker requires session metadata");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error("Session worker received invalid session metadata", { cause: error });
	}
	if (!Check(WorkerMetadataSchema, parsed) || !isAbsolute(parsed.cwd) || !isAbsolute(parsed.path)) {
		throw new Error("Session worker received invalid session metadata");
	}
	return parsed;
}

async function closeResources(resources: {
	harness?: AgentHarnessInstance;
	session?: Session<JsonlSessionMetadata>;
	repo: JsonlSessionRepo;
	executionEnv: NodeExecutionEnv;
	releaseOwnership: () => Promise<void>;
}): Promise<void> {
	const errors: unknown[] = [];
	try {
		if (resources.harness) await resources.harness.close();
		else await resources.session?.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await resources.repo.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await resources.executionEnv.cleanup();
	} catch (error) {
		errors.push(error);
	}
	try {
		await resources.releaseOwnership();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Session worker cleanup failed");
}

async function run(args: readonly string[]): Promise<void> {
	const sessionDir = args[0];
	if (!sessionDir || !isAbsolute(sessionDir)) throw new Error("Session worker requires an absolute session directory");
	const metadata = parseMetadata(args[1]);
	const sessionId = metadata.id;
	const control = await connectControl();
	const token = process.env[SESSION_WORKER_CONTROL_TOKEN_ENV]!;
	const sessionKey = Buffer.from(process.env[SESSION_WORKER_SESSION_KEY_ENV]!, "base64url").toString();
	failureControl = control;
	if (!control.coordinated) {
		await control.send({
			type: "register_worker",
			protocol: 1,
			token,
			sessionKey,
			sessionId,
			pid: process.pid,
		});
	}

	const releaseOwnership = await lockfile.lock(metadata.path, {
		realpath: true,
		stale: 2_000,
		update: 1_000,
		retries: { retries: 320, factor: 1, minTimeout: 25, maxTimeout: 25, maxRetryTime: 8_000 },
	});
	const executionEnv = new NodeExecutionEnv({ cwd: metadata.cwd });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: sessionDir });
	let session: Session<JsonlSessionMetadata> | undefined;
	let harness: AgentHarnessInstance | undefined;
	try {
		session = await repo.open(metadata);
		const modelRuntime = await ModelRuntime.create();
		const model = modelRuntime.getAvailableSnapshot()[0];
		if (!model) throw new Error("Session worker could not find a configured model");
		({ harness } = await AgentHarness.create({ session, models: modelRuntime, model, tools: [], resources: {} }));
	} catch (error) {
		try {
			await closeResources({ harness, session, repo, executionEnv, releaseOwnership });
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Session worker startup and cleanup failed");
		}
		throw error;
	}

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= closeResources({ harness, repo, executionEnv, releaseOwnership });
		return closing;
	};
	const closeAndExit = (): void => {
		void close().then(
			() => process.exit(0),
			(error: unknown) => {
				console.error(error);
				process.exit(1);
			},
		);
	};

	let ready = false;
	const announce = (): void => {
		if (!ready) return;
		void control
			.send({
				type: "worker_ready",
				token,
				sessionKey,
				sessionId,
				pid: process.pid,
				metadata,
			})
			.catch(() => closeAndExit());
	};
	void readCommands(control, closeAndExit, announce);
	control.socket.once("close", closeAndExit);
	control.socket.once("error", () => closeAndExit());
	process.once("SIGTERM", closeAndExit);
	process.once("SIGINT", closeAndExit);

	try {
		ready = true;
		await control.send({ type: "worker_ready", token, sessionKey, sessionId, pid: process.pid, metadata });
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Session worker readiness and cleanup failed");
		}
		throw error;
	}
}

export async function runSessionWorkerProcess(args: readonly string[]): Promise<void> {
	try {
		await run(args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const token = process.env[SESSION_WORKER_CONTROL_TOKEN_ENV];
		const encodedSessionKey = process.env[SESSION_WORKER_SESSION_KEY_ENV];
		if (token && encodedSessionKey) {
			const sessionKey = Buffer.from(encodedSessionKey, "base64url").toString();
			await failureControl?.send({ type: "worker_failed", token, sessionKey, message }).catch(() => {});
		}
		throw error;
	}
}

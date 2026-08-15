import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

const COORDINATOR_PROTOCOL_VERSION = 1;
const COORDINATOR_START_TIMEOUT_MS = 10_000;
const COORDINATOR_RETRY_MS = 10;
const MAX_CONTROL_LINE_BYTES = 1024 * 1024;

const CoordinatorMessageSchema = Type.Union([
	Type.Object({
		type: Type.Literal("server_registered"),
		serverConnectionId: Type.String(),
		peers: Type.Array(Type.String()),
	}),
	Type.Object({ type: Type.Literal("server_replaced") }),
	Type.Object({ type: Type.Literal("peer_connected"), peerId: Type.String() }),
	Type.Object({ type: Type.Literal("peer_disconnected"), peerId: Type.String() }),
	Type.Object({ type: Type.Literal("message"), from: Type.String(), payload: Type.Unknown() }),
]);
type CoordinatorMessage = Static<typeof CoordinatorMessageSchema>;

export type CoordinatorServerEvent =
	| { readonly type: "peer_connected"; readonly peerId: string }
	| { readonly type: "peer_disconnected"; readonly peerId: string }
	| { readonly type: "message"; readonly from: string; readonly payload: unknown };

export interface CoordinatorServerOptions {
	readonly controlPath: string;
	readonly endpoint: string;
	readonly serverConnectionId?: string;
}

/** The server-side endpoint of the coordinator's intentionally opaque message router. */
export class CoordinatorServer {
	readonly serverConnectionId: string;
	readonly replaced: Promise<void>;
	readonly peerIds = new Set<string>();
	readonly #controlPath: string;
	readonly #endpoint: string;
	readonly #listeners = new Set<(event: CoordinatorServerEvent) => void>();
	#socket?: Socket;
	#registered = false;
	#closed = false;
	#replacedValue = false;
	#resolveRegistered?: () => void;
	#rejectRegistered?: (error: Error) => void;
	#resolveReplaced!: () => void;

	constructor(options: CoordinatorServerOptions) {
		this.serverConnectionId = options.serverConnectionId ?? randomUUID();
		this.#controlPath = options.controlPath;
		this.#endpoint = options.endpoint;
		this.replaced = new Promise((resolve) => {
			this.#resolveReplaced = resolve;
		});
	}

	get controlPath(): string {
		return this.#controlPath;
	}

	get wasReplaced(): boolean {
		return this.#replacedValue;
	}

	onEvent(listener: (event: CoordinatorServerEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async connect(): Promise<void> {
		if (this.#socket) throw new Error("Coordinator server is already connected");
		const socket = await connectSocket(this.#controlPath);
		this.#socket = socket;
		attachJsonLineReader(socket, (message) => this.#handleMessage(message));
		const registered = new Promise<void>((resolve, reject) => {
			this.#resolveRegistered = resolve;
			this.#rejectRegistered = reject;
		});
		socket.once("close", () => this.#disconnected(new Error("Coordinator connection closed")));
		socket.once("error", (error) => this.#disconnected(error));
		await writeJsonLine(socket, {
			type: "register_server",
			protocol: COORDINATOR_PROTOCOL_VERSION,
			serverConnectionId: this.serverConnectionId,
			endpoint: this.#endpoint,
		});
		await registered;
	}

	send(peerId: string, payload: unknown): Promise<void> {
		return this.#write({ type: "send", to: peerId, payload });
	}

	broadcast(payload: unknown): Promise<void> {
		return this.#write({ type: "broadcast", payload });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = undefined;
		this.peerIds.clear();
		this.#rejectRegistered?.(new Error("Coordinator server closed"));
		this.#resolveRegistered = undefined;
		this.#rejectRegistered = undefined;
	}

	async #write(message: unknown): Promise<void> {
		if (!this.#registered || !this.#socket || this.#closed) throw new Error("Coordinator server is not connected");
		await writeJsonLine(this.#socket, message);
	}

	#handleMessage(value: unknown): void {
		if (!Check(CoordinatorMessageSchema, value)) {
			this.#socket?.destroy(new Error("Coordinator sent an invalid message"));
			return;
		}
		const message: CoordinatorMessage = value;
		if (message.type === "server_registered") {
			if (message.serverConnectionId !== this.serverConnectionId) {
				this.#socket?.destroy(new Error("Coordinator returned an invalid server registration"));
				return;
			}
			for (const peerId of message.peers) this.peerIds.add(peerId);
			this.#registered = true;
			this.#resolveRegistered?.();
			this.#resolveRegistered = undefined;
			this.#rejectRegistered = undefined;
			return;
		}
		if (message.type === "server_replaced") {
			this.#markReplaced();
			return;
		}
		if (message.type === "peer_connected") {
			this.peerIds.add(message.peerId);
			this.#emit({ type: "peer_connected", peerId: message.peerId });
			return;
		}
		if (message.type === "peer_disconnected") {
			this.peerIds.delete(message.peerId);
			this.#emit({ type: "peer_disconnected", peerId: message.peerId });
			return;
		}
		if (message.type === "message") {
			this.#emit({ type: "message", from: message.from, payload: message.payload });
			return;
		}
		this.#socket?.destroy(new Error("Coordinator sent an unsupported message"));
	}

	#emit(event: CoordinatorServerEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	#disconnected(error: Error): void {
		this.#socket = undefined;
		if (this.#closed) return;
		this.#rejectRegistered?.(error);
		this.#resolveRegistered = undefined;
		this.#rejectRegistered = undefined;
		this.#markReplaced();
	}

	#markReplaced(): void {
		if (this.#replacedValue) return;
		this.#replacedValue = true;
		this.#resolveReplaced();
	}
}

export interface CoordinatorStartupLease {
	close(): void;
}

export async function ensureExperimentalCoordinator(
	publicPath: string,
	controlPath: string,
	coordinatorUrl = new URL(
		import.meta.url.endsWith(".js") ? "coordinator-process.js" : "coordinator-process.ts",
		import.meta.url,
	),
): Promise<CoordinatorStartupLease> {
	const existing = await tryConnect(controlPath);
	if (existing) return { close: () => existing.destroy() };
	const args = [
		...(coordinatorUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : []),
		fileURLToPath(coordinatorUrl),
		publicPath,
		controlPath,
	];
	const child = spawn(process.execPath, args, {
		cwd: process.cwd(),
		detached: true,
		env: process.env,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	const deadline = Date.now() + COORDINATOR_START_TIMEOUT_MS;
	while (true) {
		const socket = await tryConnect(controlPath);
		if (socket) return { close: () => socket.destroy() };
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("Coordinator exited during startup");
		if (Date.now() >= deadline) throw new Error("Timed out waiting for coordinator startup");
		await new Promise<void>((resolve) => setTimeout(resolve, COORDINATOR_RETRY_MS));
	}
}

function connectSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve(socket);
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

async function tryConnect(path: string): Promise<Socket | undefined> {
	try {
		return await connectSocket(path);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
		throw error;
	}
}

function attachJsonLineReader(socket: Socket, onMessage: (message: unknown) => void): void {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		if (Buffer.byteLength(buffered) > MAX_CONTROL_LINE_BYTES) {
			socket.destroy(new Error("Coordinator message is too large"));
			return;
		}
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			try {
				onMessage(JSON.parse(line));
			} catch {
				socket.destroy(new Error("Coordinator sent invalid JSON"));
				return;
			}
		}
	});
}

function writeJsonLine(socket: Socket, message: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

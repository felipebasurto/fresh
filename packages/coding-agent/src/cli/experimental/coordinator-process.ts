import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

// This process is intentionally a transport shim. It depends only on Node
// built-ins and never interprets Pi, session, worker, or lifecycle payloads.

const COORDINATOR_PROTOCOL_VERSION = 1;
const MAX_CONTROL_LINE_BYTES = 1024 * 1024;
const EMPTY_STARTUP_GRACE_MS = 30_000;
const EMPTY_SHUTDOWN_GRACE_MS = 250;

interface ServerPeer {
	readonly serverConnectionId: string;
	readonly endpoint: string;
	readonly socket: Socket;
}

interface RoutedPeer {
	readonly peerId: string;
	readonly socket: Socket;
}

interface ControlMessage {
	readonly type: string;
	readonly protocol?: unknown;
	readonly serverConnectionId?: unknown;
	readonly endpoint?: unknown;
	readonly peerId?: unknown;
	readonly to?: unknown;
	readonly payload?: unknown;
}

let publicPath: string;
let controlPath: string;
let running = false;

const peers = new Map<string, RoutedPeer>();
const controlConnections = new Set<Socket>();
const publicConnections = new Map<Socket, Socket>();
let currentServer: ServerPeer | undefined;
let shuttingDown = false;
let emptyTimer: NodeJS.Timeout | undefined;

const publicServer = createServer((socket) => acceptPublicConnection(socket));
const controlServer = createServer((socket) => acceptControlConnection(socket));

export async function runCoordinatorProcess(args: readonly string[]): Promise<void> {
	if (running) throw new Error("Coordinator process is already running");
	const [requestedPublicPath, requestedControlPath] = args;
	if (!requestedPublicPath || !requestedControlPath) {
		throw new Error("Coordinator requires public and control socket paths");
	}
	publicPath = requestedPublicPath;
	controlPath = requestedControlPath;
	running = true;
	process.once("SIGINT", () => void shutdownCoordinator());
	process.once("SIGTERM", () => void shutdownCoordinator());
	await main();
}

async function main(): Promise<void> {
	await removeStaleSocket(controlPath);
	await removeStaleSocket(publicPath);
	try {
		await listen(controlServer, controlPath);
		await restrictSocket(controlPath);
		await listen(publicServer, publicPath);
		await restrictSocket(publicPath);
	} catch (error) {
		await Promise.all([cleanupSocket(controlPath), cleanupSocket(publicPath)]);
		throw error;
	}
	scheduleEmptyShutdown(EMPTY_STARTUP_GRACE_MS);
}

function acceptControlConnection(socket: Socket): void {
	if (shuttingDown) {
		socket.destroy();
		return;
	}
	controlConnections.add(socket);
	let server: ServerPeer | undefined;
	let peer: RoutedPeer | undefined;
	attachJsonLineReader(socket, (message) => {
		if (!server && !peer) {
			if (message.type === "register_server") {
				server = registerServer(socket, message);
				return;
			}
			if (message.type === "register_peer") {
				peer = registerPeer(socket, message);
				return;
			}
			throw new Error("Coordinator connection did not register a role");
		}
		if (server) {
			if (server === currentServer) handleRoutedMessage("server", message);
			return;
		}
		handleRoutedMessage(peer!.peerId, message);
	});
	const disconnect = (): void => {
		controlConnections.delete(socket);
		if (server && currentServer === server) currentServer = undefined;
		if (peer && peers.get(peer.peerId) === peer) {
			peers.delete(peer.peerId);
			if (currentServer) writeJsonLine(currentServer.socket, { type: "peer_disconnected", peerId: peer.peerId });
		}
		checkEmpty();
	};
	socket.once("close", disconnect);
	socket.once("error", () => socket.destroy());
}

function registerServer(socket: Socket, message: ControlMessage): ServerPeer {
	if (message.protocol !== COORDINATOR_PROTOCOL_VERSION) throw new Error("Unsupported coordinator protocol");
	if (typeof message.serverConnectionId !== "string" || message.serverConnectionId.length === 0) {
		throw new Error("Coordinator serverConnectionId must be a string");
	}
	if (typeof message.endpoint !== "string" || message.endpoint.length === 0) {
		throw new Error("Coordinator endpoint must be a string");
	}
	const { serverConnectionId, endpoint } = message;
	const server = { serverConnectionId, endpoint, socket };
	const previous = currentServer;
	currentServer = server;
	cancelEmptyShutdown();
	writeJsonLine(socket, {
		type: "server_registered",
		serverConnectionId,
		peers: [...peers.keys()],
	});
	if (previous && previous !== server) {
		closePublicConnections();
		writeJsonLine(previous.socket, { type: "server_replaced" });
	}
	return server;
}

function registerPeer(socket: Socket, message: ControlMessage): RoutedPeer {
	if (message.protocol !== COORDINATOR_PROTOCOL_VERSION) throw new Error("Unsupported coordinator protocol");
	if (typeof message.peerId !== "string" || message.peerId.length === 0) {
		throw new Error("Coordinator peerId must be a string");
	}
	const { peerId } = message;
	if (peerId === "server" || peers.has(peerId)) throw new Error(`Coordinator peer is already connected: ${peerId}`);
	const peer = { peerId, socket };
	peers.set(peerId, peer);
	cancelEmptyShutdown();
	writeJsonLine(socket, { type: "peer_registered", peerId });
	if (currentServer) {
		writeJsonLine(currentServer.socket, { type: "peer_connected", peerId });
	}
	return peer;
}

function handleRoutedMessage(from: string, message: ControlMessage): void {
	if (message.type === "send") {
		if (typeof message.to !== "string" || message.to.length === 0) {
			throw new Error("Coordinator message target must be a string");
		}
		const { to } = message;
		const target = to === "server" ? currentServer?.socket : peers.get(to)?.socket;
		if (target) writeJsonLine(target, { type: "message", from, payload: message.payload });
		return;
	}
	if (message.type === "broadcast") {
		if (from !== "server") throw new Error("Only the current server may broadcast");
		for (const peer of peers.values()) {
			writeJsonLine(peer.socket, { type: "message", from, payload: message.payload });
		}
		return;
	}
	throw new Error(`Unknown coordinator routing message: ${message.type}`);
}

function acceptPublicConnection(client: Socket): void {
	if (shuttingDown || !currentServer) {
		client.destroy();
		return;
	}
	cancelEmptyShutdown();
	const upstream = createConnection(currentServer.endpoint);
	publicConnections.set(client, upstream);
	let finalized = false;
	const finalize = (): void => {
		if (finalized) return;
		finalized = true;
		publicConnections.delete(client);
		checkEmpty();
	};
	upstream.once("connect", () => {
		client.pipe(upstream);
		upstream.pipe(client);
	});
	upstream.once("error", () => client.destroy());
	upstream.once("close", () => {
		client.destroy();
		finalize();
	});
	client.once("error", () => upstream.destroy());
	client.once("close", () => {
		upstream.destroy();
		finalize();
	});
}

function closePublicConnections(): void {
	for (const [client, upstream] of publicConnections) {
		client.destroy();
		upstream.destroy();
	}
	publicConnections.clear();
}

function checkEmpty(): void {
	if (shuttingDown || currentServer || peers.size > 0 || publicConnections.size > 0 || controlConnections.size > 0) {
		cancelEmptyShutdown();
		return;
	}
	scheduleEmptyShutdown(EMPTY_SHUTDOWN_GRACE_MS);
}

function scheduleEmptyShutdown(delayMs: number): void {
	if (emptyTimer || shuttingDown) return;
	emptyTimer = setTimeout(() => {
		emptyTimer = undefined;
		if (!currentServer && peers.size === 0 && publicConnections.size === 0 && controlConnections.size === 0) {
			void shutdownCoordinator();
		}
	}, delayMs);
	emptyTimer.unref();
}

function cancelEmptyShutdown(): void {
	if (!emptyTimer) return;
	clearTimeout(emptyTimer);
	emptyTimer = undefined;
}

async function shutdownCoordinator(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelEmptyShutdown();
	closePublicConnections();
	for (const connection of controlConnections) connection.destroy();
	await Promise.all([closeServer(publicServer), closeServer(controlServer)]);
	await Promise.all([cleanupSocket(publicPath), cleanupSocket(controlPath)]);
	process.exit(0);
}

function writeJsonLine(socket: Socket, message: unknown): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function attachJsonLineReader(socket: Socket, onMessage: (message: ControlMessage) => void): void {
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
				const message = JSON.parse(line) as ControlMessage | null;
				if (typeof message?.type !== "string") throw new Error("Coordinator message must have a type");
				onMessage(message);
			} catch (error) {
				socket.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	});
}

function listen(server: Server, path: string): Promise<void> {
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
		server.listen(path);
	});
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve) => server.close(() => resolve()));
}

async function restrictSocket(path: string): Promise<void> {
	if (process.platform !== "win32") await chmod(path, 0o600);
}

async function removeStaleSocket(path: string): Promise<void> {
	try {
		const stats = await lstat(path);
		if (!stats.isSocket()) throw new Error(`Coordinator path is not a socket: ${path}`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	const live = await new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
			else reject(error);
		});
	});
	if (live) throw new Error(`Coordinator socket is already active: ${path}`);
	await cleanupSocket(path);
}

async function cleanupSocket(path: string): Promise<void> {
	if (process.platform === "win32") return;
	await unlink(path).catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	});
}

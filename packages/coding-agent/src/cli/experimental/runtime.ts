import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { PiClient } from "@earendil-works/pi-client";
import { requestServerDrain } from "@earendil-works/pi-client/control";
import { createUnixTransportFactory, discoverUnixServers, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { isServerId } from "@earendil-works/pi-protocol";
import type { PiServer, PiServerHost } from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ClientCommand } from "./commands/client.ts";
import { DEMO_SESSION_IDS } from "./demo-sessions.ts";
import { acquireExperimentalServerProfile } from "./server-profile.ts";
import { startExperimentalSessionWorker } from "./session-worker.ts";

const SOCKET_RELEASE_TIMEOUT_MS = 10_000;
const SOCKET_RELEASE_POLL_MS = 10;
const EXPERIMENTAL_SOCKET_ROOT = "/tmp";

export interface ExperimentalMemoryServer {
	readonly serverId: string;
	readonly sessionDir: string;
	readonly socketPath: string;
	readonly server: PiServer;
	readonly workerPids: ReadonlyMap<string, number>;
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

export type ExperimentalClientResult =
	| {
			readonly kind: "list";
			readonly sessions: readonly { serverId: string; sessionId: string }[];
	  }
	| { readonly kind: "attached"; readonly serverId: string; readonly sessionId: string };

export interface StartExperimentalMemoryServerOptions {
	/** Directory for server-addressed Unix sockets. Defaults to a short, private per-user runtime directory. */
	readonly directory?: string;
	readonly path?: string;
	readonly serverId?: string;
	/** Durable session directory. Defaults to the experimental directory under the configured agent directory. */
	readonly sessionDir?: string;
}

export interface StartExperimentalServerGenerationOptions {
	/** Persistent profile directory. Defaults to ~/.pi/server. */
	readonly directory?: string;
	/** Physical socket directory. Defaults to a short, private per-user runtime directory. */
	readonly socketDirectory?: string;
	/** Durable session directory. Defaults to the experimental directory under the configured agent directory. */
	readonly sessionDir?: string;
}

export interface RunExperimentalClientOptions {
	/** Directory searched when --connect is omitted. Defaults to the experimental per-user runtime directory. */
	readonly directory?: string;
}

export function resolveExperimentalSessionDirectory(sessionDir?: string): string {
	return resolvePath(sessionDir ?? join(getAgentDir(), "experimental", "sessions"));
}

/** Start the temporary in-memory list-and-attach server composition. */
export async function startExperimentalMemoryServer(
	options: StartExperimentalMemoryServerOptions = {},
): Promise<ExperimentalMemoryServer> {
	const serverId = options.serverId ?? randomUUID();
	const sessionDir = resolveExperimentalSessionDirectory(options.sessionDir);
	const repo = new MemorySessionRepo();
	for (const id of DEMO_SESSION_IDS) {
		const session = await repo.create({ id });
		await session.close();
	}

	const workerPids = new Map<string, number>();
	const host: PiServerHost = {
		sessions: repo,
		createHarness: async (metadata) => {
			const sessionId = metadata.id;
			const worker = await startExperimentalSessionWorker(sessionId, { sessionDir });
			workerPids.set(sessionId, worker.pid);
			return {
				terminated: worker.terminated.then((error) => {
					if (workerPids.get(sessionId) === worker.pid) workerPids.delete(sessionId);
					return error;
				}),
				close: async () => {
					try {
						await worker.close();
					} finally {
						if (workerPids.get(sessionId) === worker.pid) workerPids.delete(sessionId);
					}
				},
			};
		},
	};
	let socketPath = options.path;
	if (socketPath === undefined) {
		const socketDirectory = options.directory ?? getExperimentalSocketDirectory();
		await ensurePrivateSocketDirectory(socketDirectory);
		socketPath = getUnixSocketPath(serverId, socketDirectory);
	}
	const server = createUnixServer(host, { serverId, path: socketPath, mode: 0o600 });
	try {
		await server.start();
	} catch (error) {
		const cleanup = await Promise.allSettled([server.close(), repo.close()]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Experimental server startup and cleanup failed");
		}
		throw error;
	}

	let closePromise: Promise<void> | undefined;
	const closed = server.closed.then(
		() => repo.close(),
		async (serverError: unknown) => {
			try {
				await repo.close();
			} catch (repoError) {
				throw new AggregateError([serverError, repoError], "Server and repository shutdown failed");
			}
			throw serverError;
		},
	);
	return {
		serverId,
		sessionDir,
		socketPath,
		server,
		workerPids,
		closed,
		close() {
			if (closePromise === undefined)
				closePromise = server.close().then(
					() => closed,
					() => closed,
				);
			return closePromise;
		},
	};
}

/** Start the experimental local server, replacing an existing generation for the same profile. */
export async function startExperimentalServerGeneration(
	options: StartExperimentalServerGenerationOptions = {},
): Promise<ExperimentalMemoryServer> {
	const directory = options.directory ?? join(homedir(), ".pi", "server");
	const socketDirectory = options.socketDirectory ?? getExperimentalSocketDirectory();
	const { serverId, release } = await acquireExperimentalServerProfile(directory);
	let runtime: ExperimentalMemoryServer;
	try {
		await ensurePrivateSocketDirectory(socketDirectory);
		const socketPath = getUnixSocketPath(serverId, socketDirectory);
		await drainExistingGeneration(serverId, socketPath);
		runtime = await startExperimentalMemoryServer({
			directory,
			path: socketPath,
			serverId,
			sessionDir: options.sessionDir,
		});
	} catch (error) {
		try {
			await release();
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], "Server generation failed and launcher lock release failed");
		}
		throw error;
	}

	try {
		await release();
	} catch (error) {
		try {
			await runtime.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Launcher lock release and server cleanup failed");
		}
		throw error;
	}
	return runtime;
}

async function drainExistingGeneration(serverId: string, socketPath: string): Promise<void> {
	try {
		await requestServerDrain({
			serverId,
			transportFactory: createUnixTransportFactory({ path: socketPath }),
		});
		await waitForSocketRelease(socketPath);
	} catch (error) {
		// At this launcher boundary, a missing or refused stable socket proves that
		// no generation accepted the drain request. All ambiguous failures propagate.
		if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ECONNREFUSED")) return;
		throw error;
	}
}

/** Discover local servers, then list sessions or attach to one selected session. */
export async function runExperimentalClient(
	command: ClientCommand,
	options: RunExperimentalClientOptions = {},
): Promise<ExperimentalClientResult> {
	if (command.auth !== undefined) throw new Error("Authentication is not supported by the local demo server");
	const routes = command.connect
		? [routeFromExplicitPath(command.connect.path)]
		: await discoverUnixServers({ directory: options.directory ?? getExperimentalSocketDirectory() });
	const discovered: { route: UnixServerRoute; sessionIds: string[] }[] = [];

	for (const route of routes) {
		const client = await PiClient.connect({
			serverId: route.serverId,
			transportFactory: createUnixTransportFactory({ path: route.path }),
		});
		try {
			const sessions = await client.listSessions();
			discovered.push({ route, sessionIds: sessions.map(({ id }) => id) });
		} finally {
			await client.dispose();
		}
	}

	const sessionId = command.sessionId;
	if (sessionId === undefined) {
		return {
			kind: "list",
			sessions: discovered
				.flatMap(({ route, sessionIds }) =>
					sessionIds.map((sessionId) => ({ serverId: route.serverId, sessionId })),
				)
				.sort(
					(left, right) =>
						left.serverId.localeCompare(right.serverId) || left.sessionId.localeCompare(right.sessionId),
				),
		};
	}

	const matches = discovered.filter((candidate) => candidate.sessionIds.includes(sessionId));
	if (matches.length === 0) throw new Error(`No discovered server contains session ${sessionId}`);
	if (matches.length > 1) throw new Error(`Session ${sessionId} is available from more than one server`);
	const route = matches[0]!.route;
	const client = await PiClient.connect({
		serverId: route.serverId,
		transportFactory: createUnixTransportFactory({ path: route.path }),
	});
	try {
		const attached = await client.attachSession(sessionId);
		return { kind: "attached", serverId: route.serverId, sessionId: attached.sessionId };
	} finally {
		await client.dispose();
	}
}

function routeFromExplicitPath(path: string): UnixServerRoute {
	const name = basename(path);
	const serverId = name.endsWith(".sock") ? name.slice(0, -".sock".length) : "";
	if (!isServerId(serverId)) {
		throw new Error("--connect path must end with <uuidv4-server-id>.sock");
	}
	return { serverId, path };
}

async function waitForSocketRelease(path: string): Promise<void> {
	const deadline = Date.now() + SOCKET_RELEASE_TIMEOUT_MS;
	while (true) {
		try {
			await lstat(path);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return;
			throw error;
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for server socket to close: ${path}`);
		await delay(SOCKET_RELEASE_POLL_MS);
	}
}

function getExperimentalSocketDirectory(): string {
	if (process.platform === "win32" || typeof process.getuid !== "function") {
		throw new Error("Experimental Unix server transport requires a POSIX user ID");
	}
	return join(EXPERIMENTAL_SOCKET_ROOT, `pi-server-${process.getuid()}`);
}

async function ensurePrivateSocketDirectory(directory: string): Promise<void> {
	if (typeof process.getuid !== "function") throw new Error("Unix socket directory requires a POSIX user ID");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await lstat(directory);
	if (!stats.isDirectory()) throw new Error(`Unix socket directory is not a directory: ${directory}`);
	if (stats.uid !== process.getuid())
		throw new Error(`Unix socket directory is not owned by the current user: ${directory}`);
	await chmod(directory, 0o700);
}

function hasErrorCode(error: unknown, code: string): boolean {
	let current = error;
	const seen = new Set<unknown>();
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		if ("code" in current && current.code === code) return true;
		current = current.cause;
	}
	return false;
}

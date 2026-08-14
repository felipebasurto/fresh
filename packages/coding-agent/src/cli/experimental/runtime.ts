import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { PiClient } from "@earendil-works/pi-client";
import { requestServerDrain } from "@earendil-works/pi-client/control";
import {
	createUnixTransportFactory,
	discoverUnixServices,
	type UnixServiceRoute,
} from "@earendil-works/pi-client/unix";
import { isServiceId } from "@earendil-works/pi-protocol";
import { generateServiceId, type PiServer, type PiServerHost } from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";
import type { ClientCommand } from "./commands/client.ts";
import { DEMO_SESSION_IDS } from "./demo-sessions.ts";
import { acquireExperimentalServiceProfile } from "./service-profile.ts";
import { startExperimentalSessionWorker } from "./session-worker.ts";

const SOCKET_RELEASE_TIMEOUT_MS = 10_000;
const SOCKET_RELEASE_POLL_MS = 10;

export interface ExperimentalMemoryServer {
	readonly serviceId: string;
	readonly socketPath: string;
	readonly server: PiServer;
	readonly workerPids: ReadonlyMap<string, number>;
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

export type ExperimentalClientResult =
	| {
			readonly kind: "list";
			readonly sessions: readonly { serviceId: string; sessionId: string }[];
	  }
	| { readonly kind: "attached"; readonly serviceId: string; readonly sessionId: string };

export interface StartExperimentalMemoryServerOptions {
	/** Directory for service-addressed Unix sockets. Defaults to ~/.pi/server. */
	readonly directory?: string;
	readonly path?: string;
	readonly serviceId?: string;
}

export interface StartExperimentalServerGenerationOptions {
	/** One directory represents one experimental local service profile. */
	readonly directory?: string;
}

export interface RunExperimentalClientOptions {
	/** Directory searched when --connect is omitted. Defaults to ~/.pi/server. */
	readonly directory?: string;
}

/** Start the temporary in-memory list-and-attach server composition. */
export async function startExperimentalMemoryServer(
	options: StartExperimentalMemoryServerOptions = {},
): Promise<ExperimentalMemoryServer> {
	const serviceId = options.serviceId ?? generateServiceId();
	const repo = new MemorySessionRepo();
	for (const id of DEMO_SESSION_IDS) {
		const session = await repo.create({ id });
		await session.close();
	}

	const workerPids = new Map<string, number>();
	const host: PiServerHost = {
		sessions: repo,
		createHarness: async (session) => {
			const sessionId = session.metadata.id;
			const worker = await startExperimentalSessionWorker(sessionId);
			try {
				// Prototype-only adapter: the server opened this parent-repository
				// facade, while the child owns its independently restored Session.
				await session.close();
			} catch (error) {
				await worker.close();
				throw error;
			}
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
	const socketPath = options.path ?? getUnixSocketPath(serviceId, options.directory);
	const server = createUnixServer(host, { serviceId, path: socketPath, mode: 0o600 });
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
		serviceId,
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

/** Start the experimental local service, replacing an existing generation for the same service directory. */
export async function startExperimentalServerGeneration(
	options: StartExperimentalServerGenerationOptions = {},
): Promise<ExperimentalMemoryServer> {
	const directory = options.directory ?? join(homedir(), ".pi", "server");
	const { serviceId, release } = await acquireExperimentalServiceProfile(directory);
	let runtime: ExperimentalMemoryServer;
	try {
		const socketPath = getUnixSocketPath(serviceId, directory);
		await drainExistingGeneration(serviceId, socketPath);
		runtime = await startExperimentalMemoryServer({
			directory,
			path: socketPath,
			serviceId,
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

async function drainExistingGeneration(serviceId: string, socketPath: string): Promise<void> {
	try {
		await requestServerDrain({
			serviceId,
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

/** Discover local services, then list sessions or attach to one selected session. */
export async function runExperimentalClient(
	command: ClientCommand,
	options: RunExperimentalClientOptions = {},
): Promise<ExperimentalClientResult> {
	if (command.auth !== undefined) throw new Error("Authentication is not supported by the local demo server");
	const routes = command.connect ? [routeFromExplicitPath(command.connect.path)] : await discoverUnixServices(options);
	const discovered: { route: UnixServiceRoute; sessionIds: string[] }[] = [];

	for (const route of routes) {
		const client = await PiClient.connect({
			serviceId: route.serviceId,
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
					sessionIds.map((sessionId) => ({ serviceId: route.serviceId, sessionId })),
				)
				.sort(
					(left, right) =>
						left.serviceId.localeCompare(right.serviceId) || left.sessionId.localeCompare(right.sessionId),
				),
		};
	}

	const matches = discovered.filter((candidate) => candidate.sessionIds.includes(sessionId));
	if (matches.length === 0) throw new Error(`No discovered service contains session ${sessionId}`);
	if (matches.length > 1) throw new Error(`Session ${sessionId} is available from more than one service`);
	const route = matches[0]!.route;
	const client = await PiClient.connect({
		serviceId: route.serviceId,
		transportFactory: createUnixTransportFactory({ path: route.path }),
	});
	try {
		const attached = await client.attachSession(sessionId);
		return { kind: "attached", serviceId: route.serviceId, sessionId: attached.sessionId };
	} finally {
		await client.dispose();
	}
}

function routeFromExplicitPath(path: string): UnixServiceRoute {
	const name = basename(path);
	const serviceId = name.endsWith(".sock") ? name.slice(0, -".sock".length) : "";
	if (!isServiceId(serviceId)) {
		throw new Error("--connect path must end with <32-character-service-id>.sock");
	}
	return { serviceId, path };
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

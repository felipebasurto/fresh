import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { type JsonlSessionMetadata, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory, discoverUnixServers, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { isServerId, type ServerId } from "@earendil-works/pi-protocol";
import type { HostedHarnessHandle, PiServer, PiServerHost } from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ClientCommand } from "./commands/client.ts";
import { CoordinatedSessionWorkers } from "./coordinated-session-workers.ts";
import {
	CoordinatorServer,
	type CoordinatorStartupLease,
	ensureExperimentalCoordinator,
} from "./coordinator-client.ts";
import { ENV_SERVER_ID, ensurePrivateServerDirectory, resolveExperimentalServerDirectory } from "./server-directory.ts";
import { acquireExperimentalServerProfile } from "./server-profile.ts";
import { startExperimentalSessionWorker } from "./session-worker.ts";

export interface ExperimentalServer {
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

export interface StartExperimentalServerOptions {
	/** Directory for server sockets. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
	readonly path?: string;
	readonly serverId?: ServerId;
	/** Durable session directory. Defaults to the experimental directory under the configured agent directory. */
	readonly sessionDir?: string;
}

export interface StartExperimentalCoordinatedServerOptions {
	/** Server profile and socket directory. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
	/** Logical service ID. Defaults to PI_SERVER_ID or the directory's default-server-id. */
	readonly serverId?: ServerId;
	/** Durable session directory. Defaults to the experimental directory under the configured agent directory. */
	readonly sessionDir?: string;
}

export interface RunExperimentalClientOptions {
	/** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
}

export function resolveExperimentalSessionDirectory(sessionDir?: string): string {
	return resolvePath(sessionDir ?? join(getAgentDir(), "experimental", "sessions"));
}

interface ExperimentalWorkerController {
	readonly workerPids: ReadonlyMap<string, number>;
	readonly trackedSessions: readonly JsonlSessionMetadata[];
	createHarness(metadata: JsonlSessionMetadata): Promise<HostedHarnessHandle>;
}

/** Start the experimental durable list-and-attach server composition. */
export async function startExperimentalServer(
	options: StartExperimentalServerOptions = {},
): Promise<ExperimentalServer> {
	const sessionDir = resolveExperimentalSessionDirectory(options.sessionDir);
	const workerPids = new Map<string, number>();
	const controller: ExperimentalWorkerController = {
		workerPids,
		trackedSessions: [],
		createHarness: async (metadata) => {
			const sessionId = metadata.id;
			const worker = await startExperimentalSessionWorker(metadata, {
				sessionDir,
				controlDirectory: options.directory,
			});
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
	return startExperimentalServerBackend(options, controller);
}

async function startExperimentalServerBackend(
	options: StartExperimentalServerOptions,
	workers: ExperimentalWorkerController,
): Promise<ExperimentalServer> {
	const serverId = options.serverId ?? randomUUID();
	const sessionDir = resolveExperimentalSessionDirectory(options.sessionDir);
	const executionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
	const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot: sessionDir });
	const host: PiServerHost<JsonlSessionMetadata> = {
		sessions: {
			list: async () => {
				const sessions = new Map((await repo.list()).map((metadata) => [metadata.path, metadata]));
				for (const metadata of workers.trackedSessions) sessions.set(metadata.path, metadata);
				return [...sessions.values()];
			},
		},
		createHarness: (metadata) => workers.createHarness(metadata),
	};
	let socketPath = options.path;
	if (socketPath === undefined) {
		const serverDirectory = resolveExperimentalServerDirectory(options.directory);
		await ensurePrivateServerDirectory(serverDirectory);
		socketPath = getUnixSocketPath(serverId, serverDirectory);
	}
	const closeCatalog = async (): Promise<void> => {
		const cleanup = await Promise.allSettled([repo.close(), executionEnv.cleanup()]);
		const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Experimental session catalog cleanup failed");
	};
	const server = createUnixServer(host, { serverId, path: socketPath, mode: 0o600 });
	try {
		await server.start();
	} catch (error) {
		const cleanup = await Promise.allSettled([server.close(), closeCatalog()]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Experimental server startup and cleanup failed");
		}
		throw error;
	}

	let closePromise: Promise<void> | undefined;
	const closed = server.closed.then(
		() => closeCatalog(),
		async (serverError: unknown) => {
			try {
				await closeCatalog();
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
		workerPids: workers.workerPids,
		closed,
		close() {
			closePromise ??= server.close().then(
				() => closed,
				() => closed,
			);
			return closePromise;
		},
	};
}

/** Start a replaceable experimental server behind the stable coordinator endpoint. */
export async function startExperimentalCoordinatedServer(
	options: StartExperimentalCoordinatedServerOptions = {},
): Promise<ExperimentalServer> {
	const directory = resolveExperimentalServerDirectory(options.directory);
	const { serverId, release } = await acquireExperimentalServerProfile(
		directory,
		options.serverId ?? process.env[ENV_SERVER_ID],
	);
	let backend: ExperimentalServer | undefined;
	let coordinator: CoordinatorServer | undefined;
	let startupLease: CoordinatorStartupLease | undefined;
	let workers: CoordinatedSessionWorkers | undefined;
	let released = false;
	try {
		await ensurePrivateServerDirectory(directory);
		const socketPath = getUnixSocketPath(serverId, directory);
		const controlPath = join(directory, `control-${serverId}.sock`);
		const serverNonce = randomUUID().replaceAll("-", "").slice(0, 12);
		const serverPath = join(directory, `server-${serverId}-${serverNonce}.sock`);
		startupLease = await ensureExperimentalCoordinator(socketPath, controlPath);
		coordinator = new CoordinatorServer({ controlPath, endpoint: serverPath });
		const sessionDir = resolveExperimentalSessionDirectory(options.sessionDir);
		workers = new CoordinatedSessionWorkers(coordinator, sessionDir);
		backend = await startExperimentalServerBackend(
			{ path: serverPath, serverId, sessionDir: options.sessionDir },
			workers,
		);
		await coordinator.connect();
		startupLease.close();
		startupLease = undefined;
		await workers.discover(coordinator.peerIds);

		const activeBackend = backend;
		const activeCoordinator = coordinator;
		const activeWorkers = workers;
		void activeCoordinator.replaced
			.then(async () => {
				activeWorkers.detach();
				await activeBackend.close();
			})
			.finally(() => activeCoordinator.close())
			.catch(() => {});
		let closePromise: Promise<void> | undefined;
		const runtime: ExperimentalServer = {
			serverId,
			sessionDir: activeBackend.sessionDir,
			socketPath,
			server: activeBackend.server,
			workerPids: activeWorkers.workerPids,
			closed: activeBackend.closed,
			close() {
				closePromise ??= (async () => {
					try {
						await activeBackend.close();
					} finally {
						try {
							if (activeCoordinator.wasReplaced) activeWorkers.detach();
							else await activeWorkers.shutdown();
						} finally {
							activeCoordinator.close();
						}
					}
				})();
				return closePromise;
			},
		};
		released = true;
		await release();
		return runtime;
	} catch (error) {
		startupLease?.close();
		if (coordinator?.wasReplaced) workers?.detach();
		const cleanup = await Promise.allSettled([
			backend?.close(),
			coordinator?.wasReplaced ? undefined : workers?.shutdown(),
			Promise.resolve(coordinator?.close()),
			released ? undefined : release(),
		]);
		const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (cleanupErrors.length > 0) {
			throw new AggregateError([error, ...cleanupErrors], "Coordinated server startup and cleanup failed");
		}
		throw error;
	}
}

/** Discover local servers, then list sessions or attach to one selected session. */
export async function runExperimentalClient(
	command: ClientCommand,
	options: RunExperimentalClientOptions = {},
): Promise<ExperimentalClientResult> {
	if (command.auth !== undefined) throw new Error("Authentication is not supported by the experimental local server");
	const routes = command.connect
		? [routeFromExplicitPath(command.connect.path)]
		: await discoverUnixServers({ directory: resolveExperimentalServerDirectory(options.directory) });
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

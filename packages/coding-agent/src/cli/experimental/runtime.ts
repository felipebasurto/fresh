import { basename } from "node:path";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { PiClient } from "@earendil-works/pi-client";
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
import { startExperimentalSessionWorker } from "./session-worker.ts";

export interface ExperimentalMemoryServer {
	readonly serviceId: string;
	readonly socketPath: string;
	readonly server: PiServer;
	readonly workerPids: ReadonlyMap<string, number>;
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
}

export interface RunExperimentalClientOptions {
	/** Directory searched when --connect is omitted. Defaults to ~/.pi/server. */
	readonly directory?: string;
}

/** Start the temporary in-memory list-and-attach server composition. */
export async function startExperimentalMemoryServer(
	options: StartExperimentalMemoryServerOptions = {},
): Promise<ExperimentalMemoryServer> {
	const serviceId = generateServiceId();
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
	const server = createUnixServer(host, { serviceId, path: socketPath });
	try {
		await server.start();
	} catch (error) {
		await repo.close();
		throw error;
	}

	let closePromise: Promise<void> | undefined;
	return {
		serviceId,
		socketPath,
		server,
		workerPids,
		close() {
			if (closePromise === undefined) closePromise = server.close().finally(() => repo.close());
			return closePromise;
		},
	};
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

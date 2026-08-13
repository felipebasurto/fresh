import { basename } from "node:path";
import { MemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { PiClient } from "@earendil-works/pi-client";
import {
	createUnixTransportFactory,
	discoverUnixServices,
	type UnixServiceRoute,
} from "@earendil-works/pi-client/unix";
import { isServiceId } from "@earendil-works/pi-protocol";
import { generateServiceId, type PiServer, type PiServerService } from "@earendil-works/pi-server";
import { createUnixServer, getUnixSocketPath } from "@earendil-works/pi-server/unix";
import type { ClientCommand } from "./commands/client.ts";

const DEMO_SESSION_IDS = ["demo-1", "demo-2"] as const;

export interface ExperimentalMemoryServer {
	readonly serviceId: string;
	readonly socketPath: string;
	readonly server: PiServer;
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

	// The list-and-attach protocol only needs ownership and close semantics. The
	// complete AgentHarness implementation will replace this session owner when
	// remote Harness methods are added.
	const service: PiServerService = {
		sessions: repo,
		createHarness: (session: Session) => Promise.resolve({ close: () => session.close() }),
	};
	const socketPath = options.path ?? getUnixSocketPath(serviceId, options.directory);
	const server = createUnixServer(service, { serviceId, path: socketPath });
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

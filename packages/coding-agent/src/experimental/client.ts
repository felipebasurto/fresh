import { basename } from "node:path";
import { BACKGROUND_CONTEXT, type RemoteServiceNamespace, type RemoteState } from "@earendil-works/pi-agent-core";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory, discoverUnixServers, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { isServerId, type LaneEvent, type SessionAddress } from "@earendil-works/pi-protocol";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { activateServer, ENV_SERVER_ID, resolveServerDirectory, resolveSessionDirectory } from "./server.ts";
import { createPiServerServiceNamespace } from "./services/connection.ts";
import { SessionDirectory, SessionManagement, type SessionManagementService } from "./services/sessions.ts";

export type ClientResult =
	| {
			readonly kind: "list";
			readonly sessions: readonly SessionAddress[];
	  }
	| { readonly kind: "attached"; readonly serverId: string; readonly sessionId: string }
	| { readonly kind: "prompted"; readonly serverId: string; readonly sessionId: string; readonly text: string };

export interface RunClientOptions {
	/** Directory searched when --connect is omitted. Defaults to PI_SERVER_DIR or ~/.pi/server. */
	readonly directory?: string;
	/** Reserved for snapshot-ordered main-lane events once remote harness prompting is implemented. */
	readonly onEvent?: (event: LaneEvent) => void | Promise<void>;
}

/** Discover servers, then list Sessions, attach to one, or create one for a prompt. */
export async function runClient(command: ClientCommand, options: RunClientOptions = {}): Promise<ClientResult> {
	if (command.auth !== undefined) throw new Error("Authentication is not supported by the experimental local server");
	if (command.provider !== undefined && command.model === undefined) {
		throw new Error("Server model provider requires a model");
	}
	// The current protocol cannot forward model selection to an already-running server or Session.
	if (command.connect && command.model !== undefined) {
		throw new Error("Model selection is only valid when automatically activating a new server");
	}
	const directory = resolveServerDirectory(options.directory);
	let routes: UnixServerRoute[];
	let activatedClient: PiClient | undefined;
	if (command.connect) {
		routes = [routeFromExplicitPath(command.connect.path)];
	} else {
		routes = await discoverUnixServers({ directory });
		if (routes.length > 0 && command.model !== undefined) {
			throw new Error("Model selection is only valid when automatically activating a new server");
		}
		if (routes.length === 0) {
			const activated = await activateServer({
				directory,
				requestedServerId: process.env[ENV_SERVER_ID],
				sessionDir: resolveSessionDirectory(),
				provider: command.provider,
				model: command.model,
			});
			routes = [activated.route];
			activatedClient = activated.client;
		}
	}
	const openedClients = new Set<PiClient>();
	const serviceNamespaces = new Set<RemoteServiceNamespace>();
	if (activatedClient) openedClients.add(activatedClient);
	const discovered: {
		route: UnixServerRoute;
		sessionIds: string[];
		client: PiClient;
		management: SessionManagementService;
	}[] = [];

	try {
		for (const route of routes) {
			const client =
				activatedClient ??
				(await PiClient.connect({
					serverId: route.serverId,
					transportFactory: createUnixTransportFactory({ path: route.path }),
				}));
			activatedClient = undefined;
			openedClients.add(client);
			const services = createPiServerServiceNamespace(client, {
				services: [SessionDirectory, SessionManagement],
			});
			serviceNamespaces.add(services);
			const directory = services.use(SessionDirectory);
			const management = services.use(SessionManagement);
			const state = await waitForState(directory.state);
			discovered.push({ route, sessionIds: state.sessions.map(({ sessionId }) => sessionId), client, management });
		}

		let sessionId = command.sessionId;
		if (sessionId === undefined && command.prompt === undefined) {
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

		let match: (typeof discovered)[number];
		if (sessionId === undefined) {
			if (discovered.length !== 1) {
				throw new Error("Client prompt requires exactly one discovered server to create a Session");
			}
			match = discovered[0]!;
			sessionId = (await match.management.create({}, BACKGROUND_CONTEXT)).sessionId;
		} else {
			const selectedSessionId = sessionId;
			const matches = discovered.filter((candidate) => candidate.sessionIds.includes(selectedSessionId));
			if (matches.length > 1) {
				throw new Error(`Session ${selectedSessionId} is available from more than one server`);
			}
			const existing = matches[0];
			if (existing) {
				match = existing;
			} else {
				if (command.prompt === undefined || discovered.length !== 1) {
					throw new Error(`No discovered server contains session ${selectedSessionId}`);
				}
				match = discovered[0]!;
				await match.management.create({ id: selectedSessionId }, BACKGROUND_CONTEXT);
			}
		}
		await match.management.attach(sessionId, BACKGROUND_CONTEXT);
		if (command.prompt === undefined) {
			return { kind: "attached", serverId: match.route.serverId, sessionId };
		}

		const watch = options.onEvent === undefined ? undefined : await match.client.watchSession(sessionId);
		if (watch && options.onEvent) await watch.start(options.onEvent);
		try {
			const result = await match.client.promptSession(sessionId, command.prompt);
			if (!result.ok) throw new Error(result.error.message);
			const value = result.value;
			if (value.kind === "failed") throw new Error(value.error.message);
			const text =
				"finalMessage" in value
					? value.finalMessage.content
							.filter((content) => content.type === "text")
							.map((content) => content.text)
							.join("")
					: "";
			return { kind: "prompted", serverId: match.route.serverId, sessionId, text };
		} finally {
			await watch?.dispose();
		}
	} finally {
		await Promise.all([...serviceNamespaces].map((services) => services.dispose(BACKGROUND_CONTEXT)));
		await Promise.all([...openedClients].map((client) => client.dispose()));
	}
}

function waitForState<T>(state: RemoteState<T>): Promise<T> {
	if (state.value !== undefined) return Promise.resolve(state.value);
	return new Promise((resolve) => {
		let unsubscribe: (() => void) | undefined;
		unsubscribe = state.subscribe((value) => {
			queueMicrotask(() => unsubscribe?.());
			resolve(value);
		});
	});
}

function routeFromExplicitPath(path: string): UnixServerRoute {
	const name = basename(path);
	const serverId = name.endsWith(".sock") ? name.slice(0, -".sock".length) : "";
	if (!isServerId(serverId)) {
		throw new Error("--connect path must end with <uuidv4-server-id>.sock");
	}
	return { serverId, path };
}

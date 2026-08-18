import { basename } from "node:path";
import { BACKGROUND_CONTEXT, RemoteSession, type RemoteSessionRpc } from "@earendil-works/pi-agent-core";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory, discoverUnixServers, type UnixServerRoute } from "@earendil-works/pi-client/unix";
import { isServerId, type LaneEvent } from "@earendil-works/pi-protocol";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { activateServer, ENV_SERVER_ID, resolveServerDirectory, resolveSessionDirectory } from "./server.ts";

export type ClientResult =
	| {
			readonly kind: "list";
			readonly sessions: readonly { serverId: string; sessionId: string }[];
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
	if (activatedClient) openedClients.add(activatedClient);
	const discovered: { route: UnixServerRoute; sessionIds: string[]; client: PiClient }[] = [];

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
			const sessions = await client.listSessions();
			discovered.push({ route, sessionIds: sessions.map(({ id }) => id), client });
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
			sessionId = (await match.client.createSession({ cwd: process.cwd() })).id;
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
				await match.client.createSession({ id: selectedSessionId, cwd: process.cwd() });
			}
		}
		const rpc: RemoteSessionRpc = {
			invoke: (method, args, context) => match.client.invoke(method, args, context.abortSignal),
		};
		const session = await RemoteSession.open(rpc, sessionId, BACKGROUND_CONTEXT);
		if (command.prompt === undefined) {
			await session.close(BACKGROUND_CONTEXT);
			return { kind: "attached", serverId: match.route.serverId, sessionId: session.metadata.id };
		}
		try {
			throw new Error("Experimental client prompting through AgentHarness is not implemented");
		} finally {
			await session.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await Promise.all([...openedClients].map((client) => client.dispose()));
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

import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { LaneEvent, PromptMessage, SessionAddress } from "@earendil-works/pi-protocol";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { activateBuiltinClientServices, openClientRuntime } from "./client-runtime.ts";
import type { ChatPromptResponse } from "./services/chat.ts";

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
	/** Receives snapshot-ordered main-lane events while a prompt is active. */
	readonly onEvent?: (event: LaneEvent) => void | Promise<void>;
}

/** Discover servers, then list Sessions, attach to one, or create one for a prompt. */
export async function runClient(command: ClientCommand, options: RunClientOptions = {}): Promise<ClientResult> {
	const runtime = await openClientRuntime(command, { directory: options.directory });
	try {
		const discovered = await Promise.all(runtime.servers.map(activateBuiltinClientServices));
		let sessionId = command.sessionId;
		if (sessionId === undefined && command.prompt === undefined) {
			return {
				kind: "list",
				sessions: discovered
					.flatMap(({ route, directory }) =>
						directory.state.value!.sessions.map(({ sessionId }) => ({ serverId: route.serverId, sessionId })),
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
			const matches = discovered.filter((candidate) =>
				candidate.directory.state.value!.sessions.some(({ sessionId }) => sessionId === selectedSessionId),
			);
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

		const chat = match.chat;
		const completedText = new Map<string, string>();
		// Chat deliberately returns no transcript content. Keep the compatibility watch until Transcript is implemented.
		const watch = await match.client.watchSession(sessionId);
		await watch.start(async (event) => {
			if (event.type === "message_end" && event.runId !== undefined && event.message.role === "assistant") {
				completedText.set(event.runId, messageText(event.message));
			}
			await options.onEvent?.(event);
		});
		let response: ChatPromptResponse;
		try {
			response = await chat.prompt({ message: command.prompt, images: null }, BACKGROUND_CONTEXT);
		} finally {
			await watch.dispose();
		}
		if (!response.accepted) throw new Error(response.error.message);
		if (response.error !== null) throw new Error(response.error.message);
		return {
			kind: "prompted",
			serverId: match.route.serverId,
			sessionId,
			text: completedText.get(response.operationId) ?? "",
		};
	} finally {
		await runtime.dispose();
	}
}

function messageText(message: Extract<PromptMessage, { role: "assistant" }>): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
}

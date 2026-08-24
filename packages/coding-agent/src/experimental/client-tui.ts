import { BACKGROUND_CONTEXT, type ReplicatedState } from "@earendil-works/pi-agent-core";
import type { SessionSummary } from "@earendil-works/pi-protocol";
import {
	type Component,
	Container,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { type OpenClientRuntimeOptions, openClientRuntime } from "./client-runtime.ts";
import type { SessionAttachmentState } from "./services/connection.ts";
import type { Models } from "./services/models.ts";
import type { SessionDirectory, SessionDirectoryEvent, SessionManagement } from "./services/sessions.ts";

export interface ClientTuiServer {
	readonly serverId: string;
	readonly directory: SessionDirectory;
	readonly management: Pick<SessionManagement, "create" | "attach" | "detach">;
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	readonly models: Models;
}

type ClientTuiAction =
	| { readonly kind: "attach"; readonly server: ClientTuiServer; readonly sessionId: string }
	| { readonly kind: "create"; readonly server: ClientTuiServer }
	| { readonly kind: "model"; readonly provider: string; readonly modelId: string }
	| { readonly kind: "sessions" }
	| { readonly kind: "quit" };

const selectTheme = {
	selectedPrefix: (text: string) => chalk.cyan(text),
	selectedText: (text: string) => chalk.cyan(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.yellow(text),
};

/** Minimal service-only presentation used before Harness execution is available. */
export class ExperimentalClientTui implements Component {
	readonly #servers: readonly ClientTuiServer[];
	readonly #requestRender: () => void;
	readonly #finish: () => void;
	readonly #container = new Container();
	readonly #subscriptions: (() => void)[] = [];
	readonly #actions = new Map<string, ClientTuiAction>();
	#selectList: SelectList | undefined;
	#screen: "sessions" | "models" = "sessions";
	#selectedServer: ClientTuiServer | undefined;
	#removeModelsListener: (() => void) | undefined;
	#status = "Select a Session or create one.";
	#busy = false;

	constructor(options: {
		readonly servers: readonly ClientTuiServer[];
		requestRender(): void;
		finish(): void;
	}) {
		this.#servers = options.servers;
		this.#requestRender = options.requestRender;
		this.#finish = options.finish;
		for (const server of this.#servers) {
			this.#subscriptions.push(
				server.directory.state.subscribe(() => this.#rebuild()),
				server.directory.events.subscribe((event) => this.#directoryChanged(event)),
				server.attachment.subscribe(() => this.#rebuild()),
			);
		}
		this.#rebuild();
	}

	render(width: number): string[] {
		return this.#container.render(width);
	}

	handleInput(data: string): void {
		if (!this.#busy) this.#selectList?.handleInput(data);
	}

	invalidate(): void {
		this.#container.invalidate();
	}

	dispose(): void {
		this.#removeModelsListener?.();
		this.#removeModelsListener = undefined;
		for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
	}

	#directoryChanged(event: SessionDirectoryEvent): void {
		this.#status =
			event.type === "deleted"
				? `Session removed: ${event.sessionId}`
				: `Session ${event.type}: ${event.session.sessionId}`;
		this.#rebuild();
	}

	#rebuild(): void {
		this.#container.clear();
		this.#actions.clear();
		const title = this.#screen === "sessions" ? "Experimental Sessions" : "Experimental Models";
		this.#container.addChild(new Text(chalk.bold(title), 1, 1));
		this.#container.addChild(new Text(this.#status, 1, 0));
		const items = this.#screen === "sessions" ? this.#sessionItems() : this.#modelItems();
		this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectTheme);
		this.#selectList.onSelect = (item) => {
			const action = this.#actions.get(item.value);
			if (action !== undefined) void this.#runAction(action);
		};
		this.#selectList.onCancel = () => {
			if (this.#screen === "models") {
				this.#screen = "sessions";
				this.#status = "Select a Session or create one.";
				this.#rebuild();
			} else {
				this.#finish();
			}
		};
		this.#container.addChild(this.#selectList);
		this.#container.addChild(
			new Text(
				chalk.dim(this.#screen === "sessions" ? "enter select · esc quit" : "enter select · esc sessions"),
				1,
				1,
			),
		);
		this.#requestRender();
	}

	#sessionItems(): SelectItem[] {
		const items: SelectItem[] = [];
		for (const server of this.#servers) {
			const createKey = `create:${server.serverId}`;
			this.#actions.set(createKey, { kind: "create", server });
			items.push({ value: createKey, label: "+ New Session", description: server.serverId });
			for (const session of server.directory.state.value?.sessions ?? []) {
				const key = `session:${server.serverId}:${session.sessionId}`;
				const attachment = server.attachment.value;
				const attached = attachment?.status === "attached" && attachment.sessionId === session.sessionId;
				this.#actions.set(key, { kind: "attach", server, sessionId: session.sessionId });
				items.push({
					value: key,
					label: attached ? `* ${session.sessionId}` : session.sessionId,
					description: attached ? `attached · ${server.serverId}` : server.serverId,
				});
			}
		}
		const quitKey = "quit";
		this.#actions.set(quitKey, { kind: "quit" });
		items.push({ value: quitKey, label: "Quit" });
		return items;
	}

	#modelItems(): SelectItem[] {
		const server = this.#selectedServer;
		const state = server?.models.state.value;
		const selected = state?.configuration.model;
		const items: SelectItem[] = [];
		for (const model of state?.catalog.availableModels ?? []) {
			const key = `model:${model.provider}:${model.modelId}`;
			this.#actions.set(key, { kind: "model", provider: model.provider, modelId: model.modelId });
			items.push({
				value: key,
				label:
					selected?.provider === model.provider && selected.modelId === model.modelId
						? `${model.name} (selected)`
						: model.name,
				description: `${model.provider}/${model.modelId}`,
			});
		}
		this.#actions.set("sessions", { kind: "sessions" });
		items.push({ value: "sessions", label: "Back to Sessions" });
		this.#actions.set("quit", { kind: "quit" });
		items.push({ value: "quit", label: "Quit" });
		return items;
	}

	async #runAction(action: ClientTuiAction): Promise<void> {
		if (this.#busy) return;
		if (action.kind === "quit") {
			this.#finish();
			return;
		}
		if (action.kind === "sessions") {
			this.#screen = "sessions";
			this.#status = "Select a Session or create one.";
			this.#rebuild();
			return;
		}
		this.#busy = true;
		try {
			if (action.kind === "model") {
				if (this.#selectedServer === undefined) throw new Error("No Session is attached");
				await this.#selectedServer.models.select(
					{ provider: action.provider, modelId: action.modelId },
					BACKGROUND_CONTEXT,
				);
				this.#status = `Selected ${action.provider}/${action.modelId}`;
				return;
			}
			const summary =
				action.kind === "create"
					? await action.server.management.create({}, BACKGROUND_CONTEXT)
					: findSession(action.server, action.sessionId);
			this.#status = `Attaching ${summary.sessionId}…`;
			this.#rebuild();
			if (this.#selectedServer !== undefined && this.#selectedServer !== action.server) {
				await this.#selectedServer.management.detach(BACKGROUND_CONTEXT);
			}
			await action.server.management.attach(summary.sessionId, BACKGROUND_CONTEXT);
			this.#selectedServer = action.server;
			this.#removeModelsListener?.();
			this.#removeModelsListener = action.server.models.state.subscribe(() => this.#rebuild());
			this.#screen = "models";
			this.#status = `Attached ${summary.sessionId}. Select a model.`;
		} catch (error) {
			this.#status = `Error: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.#busy = false;
			this.#rebuild();
		}
	}
}

export async function runClientTui(command: ClientCommand, options: OpenClientRuntimeOptions = {}): Promise<void> {
	const runtime = await openClientRuntime(command, options);
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	let component: ExperimentalClientTui | undefined;
	try {
		await new Promise<void>((resolve) => {
			const finish = (): void => {
				tui.stop();
				resolve();
			};
			component = new ExperimentalClientTui({
				servers: runtime.servers.map((server) => ({
					serverId: server.route.serverId,
					directory: server.directory,
					management: server.management,
					attachment: server.session.attachment,
					models: server.models,
				})),
				requestRender: () => tui.requestRender(),
				finish,
			});
			tui.addChild(component);
			tui.setFocus(component);
			tui.start();
		});
	} finally {
		component?.dispose();
		await runtime.dispose();
	}
}

function findSession(server: ClientTuiServer, sessionId: string): SessionSummary {
	const session = server.directory.state.value?.sessions.find((candidate) => candidate.sessionId === sessionId);
	if (session === undefined) throw new Error(`Unknown Session: ${sessionId}`);
	return session;
}

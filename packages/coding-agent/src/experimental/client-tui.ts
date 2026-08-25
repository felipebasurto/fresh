import { BACKGROUND_CONTEXT, type Context, defineService, type ReplicatedState } from "@earendil-works/pi-agent-core";
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
import { activateRemoteFacets, bindService, defineFacet, type RemoteFacetActivation } from "./facets.ts";
import type { ServerServices, SessionAttachmentState, SessionServices } from "./services/connection.ts";
import { Models, type Models as ModelsService } from "./services/models.ts";
import {
	SessionDirectory,
	SessionManagement,
	type SessionManagement as SessionManagementService,
} from "./services/sessions.ts";

export interface ClientTuiServer {
	readonly serverId: string;
	readonly server: ServerServices;
	readonly session: SessionServices;
}

interface SessionPickerFeature {
	readonly serverId: string;
	readonly directory: SessionDirectory;
	readonly management: Pick<SessionManagementService, "create" | "attach" | "detach">;
	readonly attachment: ReplicatedState<SessionAttachmentState>;
}

interface ModelSelectionFeature {
	readonly serverId: string;
	readonly models: ModelsService;
}

interface Tui {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	whenAttached(sessionId: string, context: Context): Promise<void>;
	whenDetached(context: Context): Promise<void>;
	registerSessionPicker(feature: Omit<SessionPickerFeature, "serverId">): () => void;
	registerModelSelection(feature: Omit<ModelSelectionFeature, "serverId">): () => void;
	refresh(): void;
	setStatus(status: string): void;
}

const Tui = defineService<Tui>("pi.local.tui");

type ClientTuiAction =
	| { readonly kind: "attach"; readonly feature: SessionPickerFeature; readonly sessionId: string }
	| { readonly kind: "create"; readonly feature: SessionPickerFeature }
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

export const sessionPickerTuiFacet = defineFacet({
	id: "@pi/session-picker",
	setup(env) {
		const tui = env.use(Tui);
		const directory = env.use(SessionDirectory);
		const remoteManagement = env.use(SessionManagement);
		const management: SessionPickerFeature["management"] = {
			create: (options, context) => remoteManagement.create(options, context),
			async attach(sessionId, context) {
				await remoteManagement.attach(sessionId, context);
				await tui.whenAttached(sessionId, context);
			},
			async detach(context) {
				await remoteManagement.detach(context);
				await tui.whenDetached(context);
			},
		};
		env.onActivate(() => {
			env.own(tui.registerSessionPicker({ directory, management, attachment: tui.attachment }));
			env.own(directory.state.subscribe(tui.refresh));
			env.own(
				directory.events.subscribe((event) => {
					tui.setStatus(
						event.type === "deleted"
							? `Session removed: ${event.sessionId}`
							: `Session ${event.type}: ${event.session.sessionId}`,
					);
				}),
			);
			env.own(tui.attachment.subscribe(tui.refresh));
		});
	},
});

export const modelSelectionTuiFacet = defineFacet({
	id: "@pi/model-selection",
	setup(env) {
		const tui = env.use(Tui);
		const models = env.use(Models);
		env.onActivate(() => {
			env.own(tui.registerModelSelection({ models }));
			env.own(models.state.subscribe(tui.refresh));
		});
	},
});

/** Minimal service-only presentation used before Harness execution is available. */
export class ExperimentalClientTui implements Component {
	readonly #requestRender: () => void;
	readonly #finish: () => void;
	readonly #container = new Container();
	readonly #remoteFacetActivations: RemoteFacetActivation[] = [];
	readonly #sessionPickers = new Map<string, SessionPickerFeature>();
	readonly #modelSelections = new Map<string, ModelSelectionFeature>();
	readonly #actions = new Map<string, ClientTuiAction>();
	#selectList: SelectList | undefined;
	#screen: "sessions" | "models" = "sessions";
	#selectedServerId: string | undefined;
	#status = "Select a Session or create one.";
	#busy = false;
	#closePromise: Promise<void> | undefined;

	private constructor(requestRender: () => void, finish: () => void) {
		this.#requestRender = requestRender;
		this.#finish = finish;
	}

	static async create(options: {
		readonly servers: readonly ClientTuiServer[];
		requestRender(): void;
		finish(): void;
	}): Promise<ExperimentalClientTui> {
		const component = new ExperimentalClientTui(options.requestRender, options.finish);
		try {
			await component.#start(options.servers);
			return component;
		} catch (error) {
			try {
				await component.close();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Experimental TUI startup and cleanup failed");
			}
			throw error;
		}
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
		void this.close().catch(() => {});
	}

	close(): Promise<void> {
		this.#closePromise ??= disposeRemoteFacetActivations(this.#remoteFacetActivations.splice(0).reverse());
		return this.#closePromise;
	}

	async #start(servers: readonly ClientTuiServer[]): Promise<void> {
		for (const server of servers) {
			const bindings = [
				bindService(Tui, {
					attachment: server.session.attachment,
					whenAttached: (sessionId, context) => server.session.whenAttached(sessionId, context),
					whenDetached: (context) => server.session.whenDetached(context),
					registerSessionPicker: (feature) =>
						this.#register(this.#sessionPickers, "Session picker", { ...feature, serverId: server.serverId }),
					registerModelSelection: (feature) =>
						this.#register(this.#modelSelections, "Model selection", { ...feature, serverId: server.serverId }),
					refresh: () => this.#rebuild(),
					setStatus: (status) => {
						this.#status = status;
						this.#rebuild();
					},
				}),
			];
			const serverActivation = await activateRemoteFacets({
				facets: [sessionPickerTuiFacet],
				bindings,
				source: server.server,
				connect: () => server.server.activate(BACKGROUND_CONTEXT),
			});
			this.#remoteFacetActivations.push(serverActivation);
			const sessionActivation = await activateRemoteFacets({
				facets: [modelSelectionTuiFacet],
				bindings,
				source: server.session,
				connect: () => server.session.activate(BACKGROUND_CONTEXT),
			});
			this.#remoteFacetActivations.push(sessionActivation);
		}
		this.#rebuild();
	}

	#register<T extends { readonly serverId: string }>(features: Map<string, T>, label: string, feature: T): () => void {
		if (features.has(feature.serverId)) {
			throw new Error(`${label} is already registered for server ${feature.serverId}`);
		}
		features.set(feature.serverId, feature);
		try {
			this.#rebuild();
		} catch (error) {
			features.delete(feature.serverId);
			throw error;
		}
		return () => {
			if (features.get(feature.serverId) !== feature) return;
			features.delete(feature.serverId);
			this.#rebuild();
		};
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
		for (const feature of this.#sessionPickers.values()) {
			const createKey = `create:${feature.serverId}`;
			this.#actions.set(createKey, { kind: "create", feature });
			items.push({ value: createKey, label: "+ New Session", description: feature.serverId });
			for (const session of feature.directory.state.value?.sessions ?? []) {
				const key = `session:${feature.serverId}:${session.sessionId}`;
				const attachment = feature.attachment.value;
				const attached = attachment?.status === "attached" && attachment.sessionId === session.sessionId;
				this.#actions.set(key, { kind: "attach", feature, sessionId: session.sessionId });
				items.push({
					value: key,
					label: attached ? `* ${session.sessionId}` : session.sessionId,
					description: attached ? `attached · ${feature.serverId}` : feature.serverId,
				});
			}
		}
		this.#actions.set("quit", { kind: "quit" });
		items.push({ value: "quit", label: "Quit" });
		return items;
	}

	#modelItems(): SelectItem[] {
		const feature =
			this.#selectedServerId === undefined ? undefined : this.#modelSelections.get(this.#selectedServerId);
		const state = feature?.models.state.value;
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
				const feature =
					this.#selectedServerId === undefined ? undefined : this.#modelSelections.get(this.#selectedServerId);
				if (feature === undefined) throw new Error("No Session model selection is available");
				await feature.models.select({ provider: action.provider, modelId: action.modelId }, BACKGROUND_CONTEXT);
				this.#status = `Selected ${action.provider}/${action.modelId}`;
				return;
			}
			const summary =
				action.kind === "create"
					? await action.feature.management.create({}, BACKGROUND_CONTEXT)
					: findSession(action.feature, action.sessionId);
			this.#status = `Attaching ${summary.sessionId}…`;
			this.#rebuild();
			const selectedFeature =
				this.#selectedServerId === undefined ? undefined : this.#sessionPickers.get(this.#selectedServerId);
			if (selectedFeature !== undefined && selectedFeature !== action.feature) {
				await selectedFeature.management.detach(BACKGROUND_CONTEXT);
			}
			await action.feature.management.attach(summary.sessionId, BACKGROUND_CONTEXT);
			this.#selectedServerId = action.feature.serverId;
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
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = () => {
				tui.stop();
				resolve();
			};
		});
		component = await ExperimentalClientTui.create({
			servers: runtime.servers.map((server) => ({
				serverId: server.route.serverId,
				server: server.server,
				session: server.session,
			})),
			requestRender: () => tui.requestRender(),
			finish,
		});
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		await finished;
	} finally {
		await component?.close();
		await runtime.dispose();
	}
}

async function disposeRemoteFacetActivations(activations: readonly RemoteFacetActivation[]): Promise<void> {
	const results = await Promise.allSettled(activations.map((activation) => activation.dispose()));
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental TUI facets");
}

function findSession(feature: SessionPickerFeature, sessionId: string): SessionSummary {
	const session = feature.directory.state.value?.sessions.find((candidate) => candidate.sessionId === sessionId);
	if (session === undefined) throw new Error(`Unknown Session: ${sessionId}`);
	return session;
}

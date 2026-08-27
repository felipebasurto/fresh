import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { SessionSummary } from "@earendil-works/pi-protocol";
import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	setKeybindings,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ClientCommand } from "../cli/experimental/commands/client.ts";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { createChatViewport } from "../modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../modes/interactive/components/custom-editor.ts";
import { getEditorTheme, setRegisteredThemes, stopThemeWatcher, theme } from "../modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../modes/interactive/theme/theme-controller.ts";
import { createInteractiveTui } from "../modes/interactive/tui-renderer.ts";
import { type OpenClientRuntimeOptions, openClientRuntime } from "./client-runtime.ts";
import { ExperimentalChatView } from "./client-tui-chat.ts";
import { combineFacetLoaders, type FacetLoader, type LoadedFacets } from "./facet-loader.ts";
import { createFacetHost, defineFacet, type FacetHost } from "./facets.ts";
import { type LaneReplica, type LaneWatchSource, openLaneReplica } from "./lane-replica.ts";
import { AgentController, type AgentOperationResponse, type AgentQueueResponse } from "./services/agent-controller.ts";
import type { ServerServiceConnection, SessionServiceConnection } from "./services/connection.ts";
import { Models } from "./services/models.ts";
import { SessionDirectory, SessionManagement } from "./services/sessions.ts";

export interface RunClientTuiOptions extends OpenClientRuntimeOptions {
	readonly facetLoader?: FacetLoader;
}

export interface ClientTuiServer {
	readonly serverId: string;
	readonly laneWatches: LaneWatchSource;
	readonly server: ServerServiceConnection;
	readonly session: SessionServiceConnection;
}

interface SessionFeature {
	readonly serverId: string;
	readonly directory: SessionDirectory;
	readonly management: SessionManagement;
	readonly session: SessionServiceConnection;
	readonly laneWatches: LaneWatchSource;
}

interface ModelSelectionFeature {
	readonly serverId: string;
	readonly models: Models;
}

interface AgentFeature {
	readonly serverId: string;
	readonly controller: AgentController;
}

interface ModelAction {
	readonly provider: string;
	readonly modelId: string;
}

const selectTheme = {
	selectedPrefix: (text: string) => theme.fg("accent", text),
	selectedText: (text: string) => theme.fg("accent", text),
	description: (text: string) => theme.fg("muted", text),
	scrollInfo: (text: string) => theme.fg("dim", text),
	noMatch: (text: string) => theme.fg("warning", text),
};

/** Service-only presentation driven by a replicated main-lane snapshot. */
export class ExperimentalClientTui implements Component {
	readonly #ui: TUI;
	readonly #requestRender: () => void;
	readonly #finish: () => void;
	readonly #documentContainer = new Container();
	readonly #sessionHeading = new Text("", 1, 0);
	readonly #pendingMessagesContainer = new Container();
	readonly #statusContainer = new Container();
	readonly #editorContainer = new Container();
	readonly #footerComponent = new Text("", 1, 0);
	readonly #layoutRoot: Component;
	readonly #loadedFacets: LoadedFacets;
	readonly #facetHosts: FacetHost[] = [];
	readonly #sessions = new Map<string, SessionFeature>();
	readonly #modelSelections = new Map<string, ModelSelectionFeature>();
	readonly #agents = new Map<string, AgentFeature>();
	readonly #modelActions = new Map<string, ModelAction>();
	readonly #chatInput: CustomEditor;
	#selectList: SelectList | undefined;
	#screen: "models" | "chat" = "chat";
	#selectedServerId: string | undefined;
	#sessionId: string | undefined;
	#status = "Starting Session…";
	#busy = false;
	#closePromise: Promise<void> | undefined;
	#laneReplica: LaneReplica | undefined;
	#laneUnsubscribe: (() => void) | undefined;
	#chatView: ExperimentalChatView | undefined;

	private constructor(ui: TUI, requestRender: () => void, finish: () => void, loadedFacets: LoadedFacets) {
		this.#ui = ui;
		this.#requestRender = requestRender;
		this.#finish = finish;
		this.#loadedFacets = loadedFacets;
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.#chatInput = new CustomEditor(ui, getEditorTheme(), keybindings, { paddingX: 1 });
		this.#chatInput.onSubmit = (message) => void this.#runPrompt(message);
		this.#chatInput.onEscape = () => this.#interrupt();
		this.#chatInput.onCtrlD = finish;
		this.#chatInput.onAction("app.clear", finish);
		this.#chatInput.onAction("app.model.select", () => this.#showModels());
		this.#chatInput.onAction("app.message.followUp", () => {
			const text = this.#chatInput.getText().trim();
			if (text.length === 0) return;
			this.#chatInput.setText("");
			void this.#queueFollowUp(text);
		});
		this.#editorContainer.addChild(this.#chatInput);
		this.#layoutRoot = createChatViewport({
			document: this.#documentContainer,
			pendingMessages: this.#pendingMessagesContainer,
			status: this.#statusContainer,
			editor: this.#editorContainer,
			footer: this.#footerComponent,
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		}).root;
		this.#rebuild();
	}

	static async create(options: {
		readonly command: ClientCommand;
		readonly ui: TUI;
		readonly servers: readonly ClientTuiServer[];
		readonly facetLoader?: FacetLoader;
		requestRender(): void;
		finish(): void;
	}): Promise<ExperimentalClientTui> {
		const loadedFacets = await combineFacetLoaders(
			options.facetLoader === undefined ? [] : [options.facetLoader],
		).load();
		const component = new ExperimentalClientTui(options.ui, options.requestRender, options.finish, loadedFacets);
		try {
			await component.#start(options.servers);
			await component.#openInitialSession(options.command);
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

	get layoutRoot(): Component {
		return this.#layoutRoot;
	}

	render(width: number): string[] {
		return [
			...this.#documentContainer.render(width),
			...this.#pendingMessagesContainer.render(width),
			...this.#statusContainer.render(width),
			...this.#editorContainer.render(width),
			...this.#footerComponent.render(width),
		];
	}

	handleInput(data: string): void {
		if (this.#busy) return;
		if (this.#screen === "chat") {
			this.#chatInput.handleInput(data);
			this.#requestRender();
			return;
		}
		this.#selectList?.handleInput(data);
	}

	invalidate(): void {
		this.#layoutRoot.invalidate();
	}

	dispose(): void {
		void this.close().catch(() => {});
	}

	refreshTheme(): void {
		const snapshot = this.#laneReplica?.state();
		if (snapshot !== undefined) this.#chatView?.refreshTheme(snapshot);
		this.#rebuild();
	}

	showError(error: string): void {
		this.#status = `Error: ${error}`;
		this.#rebuild();
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #start(servers: readonly ClientTuiServer[]): Promise<void> {
		for (const server of servers) {
			const presentationBridgeFacet = defineFacet({
				id: "@pi/presentation-bridge",
				setup: (env) => {
					const directory = env.use(SessionDirectory);
					const management = env.use(SessionManagement);
					const models = env.use(Models);
					const controller = env.use(AgentController);
					env.onActivate(() => {
						env.own(
							this.#register(this.#sessions, "Sessions", {
								serverId: server.serverId,
								directory,
								management,
								session: server.session,
								laneWatches: server.laneWatches,
							}),
						);
						env.own(
							this.#register(this.#modelSelections, "Model selection", { serverId: server.serverId, models }),
						);
						env.own(this.#register(this.#agents, "Agent controller", { serverId: server.serverId, controller }));
						env.own(directory.state.subscribe(() => this.#rebuild()));
						env.own(models.state.subscribe(() => this.#rebuild()));
					});
				},
			});
			const facetHost = await createFacetHost({
				facets: [presentationBridgeFacet, ...this.#loadedFacets.facets],
				connections: [server.server, server.session],
			});
			this.#facetHosts.push(facetHost);
		}
	}

	async #openInitialSession(command: ClientCommand): Promise<void> {
		const features = [...this.#sessions.values()];
		if (features.length === 0) throw new Error("No Session service is available");
		let selected: { feature: SessionFeature; summary: SessionSummary } | undefined;

		if (command.sessionId !== undefined) {
			const matches = features.flatMap((feature) =>
				(feature.directory.state.value?.sessions ?? [])
					.filter((session) => session.sessionId === command.sessionId)
					.map((summary) => ({ feature, summary })),
			);
			if (matches.length > 1) throw new Error(`Session ${command.sessionId} is available from more than one server`);
			selected = matches[0];
			if (selected === undefined) {
				const feature = requireSingleServer(features);
				selected = {
					feature,
					summary: await feature.management.create({ id: command.sessionId }, BACKGROUND_CONTEXT),
				};
			}
		} else if (command.continue === true || command.resume === true) {
			selected = features
				.flatMap((feature) =>
					(feature.directory.state.value?.sessions ?? []).map((summary) => ({ feature, summary })),
				)
				.sort(
					(left, right) =>
						right.summary.createdAt - left.summary.createdAt ||
						left.summary.serverId.localeCompare(right.summary.serverId) ||
						left.summary.sessionId.localeCompare(right.summary.sessionId),
				)[0];
		}

		if (selected === undefined) {
			const feature = requireSingleServer(features);
			selected = { feature, summary: await feature.management.create({}, BACKGROUND_CONTEXT) };
		}
		await this.#attachSession(selected.feature, selected.summary);
	}

	async #attachSession(feature: SessionFeature, summary: SessionSummary): Promise<void> {
		this.#status = `Attaching ${summary.sessionId}…`;
		this.#rebuild();
		await feature.management.attach(summary.sessionId, BACKGROUND_CONTEXT);
		await feature.session.whenAttached(summary.sessionId, BACKGROUND_CONTEXT);
		this.#selectedServerId = feature.serverId;
		this.#sessionId = summary.sessionId;
		await this.#openLane(feature, summary.sessionId);
		this.#screen = "chat";
		this.#status = "";
		this.#rebuild();
	}

	async #close(): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.#closeLane();
		} catch (error) {
			errors.push(error);
		}
		const results = await Promise.allSettled(
			this.#facetHosts
				.splice(0)
				.reverse()
				.map((host) => host.dispose()),
		);
		errors.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
		try {
			await this.#loadedFacets.dispose();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose experimental TUI facets");
	}

	#register<T extends { readonly serverId: string }>(features: Map<string, T>, label: string, feature: T): () => void {
		if (features.has(feature.serverId))
			throw new Error(`${label} is already registered for server ${feature.serverId}`);
		features.set(feature.serverId, feature);
		return () => {
			if (features.get(feature.serverId) !== feature) return;
			features.delete(feature.serverId);
		};
	}

	#rebuild(): void {
		this.#sessionHeading.setText(this.#sessionId === undefined ? "" : theme.fg("dim", this.#sessionId));
		this.#statusContainer.clear();
		if (this.#status.length > 0) {
			this.#statusContainer.addChild(new Text(theme.fg("dim", this.#status), 1, 0));
		}
		if (this.#chatView !== undefined) this.#statusContainer.addChild(this.#chatView.status);
		this.#footerComponent.setText(theme.fg("dim", this.#footer()));
		this.#editorContainer.clear();
		this.#modelActions.clear();
		if (this.#screen === "models") {
			this.#chatInput.focused = false;
			const selector = new Container();
			selector.addChild(new Text(theme.bold("Select model:"), 1, 1));
			const items = this.#modelItems();
			this.#selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectTheme);
			this.#selectList.onSelect = (item) => {
				const action = this.#modelActions.get(item.value);
				if (action !== undefined) void this.#selectModel(action);
			};
			this.#selectList.onCancel = () => {
				this.#screen = "chat";
				this.#rebuild();
			};
			selector.addChild(this.#selectList);
			this.#editorContainer.addChild(selector);
		} else {
			this.#selectList = undefined;
			this.#chatInput.focused = !this.#busy;
			this.#editorContainer.addChild(this.#chatInput);
		}
		this.#layoutRoot.invalidate();
		this.#requestRender();
	}

	#modelItems(): SelectItem[] {
		const feature =
			this.#selectedServerId === undefined ? undefined : this.#modelSelections.get(this.#selectedServerId);
		const state = feature?.models.state.value;
		const selected = state?.configuration.model;
		return (state?.catalog.availableModels ?? []).map((model) => {
			const key = `model:${model.provider}:${model.modelId}`;
			this.#modelActions.set(key, { provider: model.provider, modelId: model.modelId });
			return {
				value: key,
				label:
					selected?.provider === model.provider && selected.modelId === model.modelId
						? `${model.name} (selected)`
						: model.name,
				description: `${model.provider}/${model.modelId}`,
			};
		});
	}

	async #selectModel(action: ModelAction): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			const feature =
				this.#selectedServerId === undefined ? undefined : this.#modelSelections.get(this.#selectedServerId);
			if (feature === undefined) throw new Error("No Session model selection is available");
			await feature.models.select({ provider: action.provider, modelId: action.modelId }, BACKGROUND_CONTEXT);
			this.#screen = "chat";
			this.#status = `Selected ${action.provider}/${action.modelId}.`;
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
		} finally {
			this.#busy = false;
			this.#rebuild();
		}
	}

	async #openLane(feature: SessionFeature, sessionId: string): Promise<void> {
		await this.#closeLane();
		const replica = await openLaneReplica(feature.laneWatches, sessionId);
		const view = new ExperimentalChatView(this.#ui, process.cwd());
		view.apply(replica.state());
		this.#laneReplica = replica;
		this.#chatView = view;
		this.#documentContainer.addChild(this.#sessionHeading);
		this.#documentContainer.addChild(view.transcript);
		this.#pendingMessagesContainer.addChild(view.pendingMessages);
		this.#laneUnsubscribe = replica.subscribe(() => {
			view.apply(replica.state());
			this.#rebuild();
		});
	}

	async #closeLane(): Promise<void> {
		this.#laneUnsubscribe?.();
		this.#laneUnsubscribe = undefined;
		this.#chatView?.dispose();
		this.#chatView = undefined;
		this.#documentContainer.clear();
		this.#pendingMessagesContainer.clear();
		this.#statusContainer.clear();
		const replica = this.#laneReplica;
		this.#laneReplica = undefined;
		await replica?.close();
	}

	async #runPrompt(messageText: string): Promise<void> {
		const prompt = messageText.trim();
		if (prompt.length === 0) return;
		if (prompt === "/model") {
			this.#showModels();
			return;
		}
		const controller = this.#selectedController();
		if (controller === undefined) {
			this.#status = "No Session AgentController service is available.";
			this.#rebuild();
			return;
		}
		this.#chatInput.setText("");
		try {
			if (prompt === "/compact" || prompt.startsWith("/compact ")) {
				const instructions = prompt.slice("/compact".length).trim();
				this.#status = "Compacting…";
				this.#rebuild();
				this.#reportOperation(
					await controller.compact(
						{ customInstructions: instructions.length === 0 ? null : instructions },
						BACKGROUND_CONTEXT,
					),
				);
				return;
			}
			const operation = this.#laneReplica?.state().operation;
			const running = operation !== null && operation !== undefined;
			this.#status = running ? "Queueing steering message…" : "Running turn…";
			this.#rebuild();
			if (running) this.#reportQueue(await controller.steer({ message: prompt, images: null }, BACKGROUND_CONTEXT));
			else this.#reportOperation(await controller.prompt({ message: prompt, images: null }, BACKGROUND_CONTEXT));
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	async #queueFollowUp(text: string): Promise<void> {
		const controller = this.#selectedController();
		if (controller === undefined) return;
		try {
			this.#status = "Queueing follow-up…";
			this.#rebuild();
			this.#reportQueue(await controller.followUp({ message: text, images: null }, BACKGROUND_CONTEXT));
		} catch (error) {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		}
	}

	#reportOperation(response: AgentOperationResponse): void {
		this.#status = response.accepted
			? response.error === null
				? ""
				: `Operation failed: ${response.error.message}`
			: `Operation rejected: ${response.error.message}`;
		this.#rebuild();
	}

	#reportQueue(response: AgentQueueResponse): void {
		this.#status = response.accepted ? `Queued ${response.entryId}.` : `Message rejected: ${response.error.message}`;
		this.#rebuild();
	}

	#interrupt(): void {
		const operation = this.#laneReplica?.state().operation;
		const controller = this.#selectedController();
		if (operation === null || operation === undefined || controller === undefined) return;
		this.#status = `Aborting ${operation.id}…`;
		this.#rebuild();
		void controller.requestAbort(operation.id, BACKGROUND_CONTEXT).catch((error: unknown) => {
			this.#status = `Error: ${message(error)}`;
			this.#rebuild();
		});
	}

	#showModels(): void {
		this.#screen = "models";
		this.#rebuild();
	}

	#selectedController(): AgentController | undefined {
		return this.#selectedServerId === undefined ? undefined : this.#agents.get(this.#selectedServerId)?.controller;
	}

	#footer(): string {
		const snapshot = this.#laneReplica?.state();
		if (!snapshot) return "/model · /compact";
		return `${snapshot.configuration.model.provider}/${snapshot.configuration.model.modelId} · thinking:${snapshot.configuration.thinkingLevel} · ${snapshot.stats.messageCount} messages · /model · /compact`;
	}
}

export async function runClientTui(command: ClientCommand, options: RunClientTuiOptions = {}): Promise<void> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	setRegisteredThemes(resourceLoader.getThemes().themes);
	const runtime = await openClientRuntime(command, options);
	const tui = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: settingsManager.getShowHardwareCursor(),
		logDirectory: agentDir,
	});
	tui.setClearOnShrink(settingsManager.getClearOnShrink());
	let component: ExperimentalClientTui | undefined;
	let tuiStarted = false;
	const themeController = new InteractiveThemeController(tui, {
		getSettingsManager: () => settingsManager,
		showError: (error) => component?.showError(error),
		onChanged: () => component?.refreshTheme(),
	});
	try {
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = () => {
				themeController.disableAutoSync();
				if (tuiStarted) {
					tui.stop();
					tuiStarted = false;
				}
				resolve();
			};
		});
		component = await ExperimentalClientTui.create({
			command,
			ui: tui,
			servers: runtime.servers.map((server) => ({
				serverId: server.route.serverId,
				laneWatches: server.client,
				server: server.server,
				session: server.session,
			})),
			facetLoader: options.facetLoader,
			requestRender: () => tui.requestRender(),
			finish,
		});
		tui.addChild(component);
		tui.setLayoutRoot(component.layoutRoot);
		tui.setFocus(component);
		tuiStarted = true;
		tui.start();
		await themeController.applyFromSettings();
		await finished;
	} finally {
		themeController.dispose();
		stopThemeWatcher();
		if (tuiStarted) tui.stop();
		await component?.close();
		await runtime.dispose();
	}
}

function requireSingleServer(features: readonly SessionFeature[]): SessionFeature {
	if (features.length !== 1) throw new Error("Starting a Session requires exactly one server");
	return features[0]!;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

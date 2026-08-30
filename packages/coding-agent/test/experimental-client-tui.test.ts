import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	createRemoteServiceBinding,
	RemoteServiceProvider,
	type RemoteServiceTransport,
	replicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	FACET_BUNDLE_ARTIFACT_FORMAT,
	FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
	type FacetBundleArtifact,
} from "@earendil-works/chord/node";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import type { LaneEvent, LaneSnapshot } from "@earendil-works/pi-protocol";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type ClientTuiServer, ExperimentalClientTui } from "../src/experimental/client-tui.ts";
import { createPresentationFacetData } from "../src/experimental/plugins/bundled.ts";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { createAgentController } from "../src/experimental/services/agent-controller-provider.ts";
import type {
	ServerConnectionState,
	ServerServiceSource,
	SessionAttachmentState,
	SessionServiceSource,
} from "../src/experimental/services/connection.ts";
import { Models, type ModelsState } from "../src/experimental/services/models.ts";
import { PresentationPlugins, SessionPlugins } from "../src/experimental/services/plugins.ts";
import {
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "../src/experimental/services/sessions.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

function session(sessionId: string, createdAt: number): SessionSummary {
	return { serverId, sessionId, createdAt };
}

function createLoopbackServiceTransport(provider: RemoteServiceProvider): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, (update) => listener(update, BACKGROUND_CONTEXT));
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}

function laneSnapshot(): LaneSnapshot {
	return {
		lane: "main",
		transcript: [],
		tipId: null,
		configuration: {
			model: { provider: "test", modelId: "one" },
			thinkingLevel: "off",
			activeToolNames: [],
		},
		stats: {
			messageCount: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		operation: null,
		queues: [],
		faulted: false,
	};
}

describe("experimental client TUI", () => {
	beforeAll(() => initTheme("dark"));

	test.each([
		["new", { command: "client" as const }, "two", 1],
		["continued", { command: "client" as const, continue: true }, "one", 0],
		["plugin-selected", { command: "client" as const, pluginPackages: ["./example-plugin"] }, "two", 1],
	] as const)(
		"opens a %s Session directly and exercises the full lifecycle only for a new Session",
		async (kind, command, sessionId, creates) => {
			const directoryState = replicatedState<SessionDirectoryState>({ revision: 1, sessions: [session("one", 1)] });
			const attachment = replicatedState<SessionAttachmentState>({ status: "detached" });
			const connectionState = replicatedState<ServerConnectionState>({ status: "connected", since: "now" });
			const modelsState = replicatedState<ModelsState>({
				catalog: {
					revision: 1,
					availableModels: [
						{ provider: "test", modelId: "one", name: "Model One", reasoning: false },
						{ provider: "test", modelId: "two", name: "Model Two", reasoning: true },
					],
				},
				configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
				refresh: { status: "idle" },
			});
			const create = vi.fn(async () => {
				const created = session("two", 2);
				directoryState.set(
					{ revision: 2, sessions: [...directoryState.value.sessions, created] },
					BACKGROUND_CONTEXT,
				);
				return created;
			});
			const select = vi.fn(async (model: { provider: string; modelId: string }) => {
				modelsState.set(
					{ ...modelsState.value, configuration: { ...modelsState.value.configuration, model } },
					BACKGROUND_CONTEXT,
				);
			});
			const selectThinking = vi.fn(async (thinkingLevel: "off" | "high") => {
				modelsState.set(
					{ ...modelsState.value, configuration: { ...modelsState.value.configuration, thinkingLevel } },
					BACKGROUND_CONTEXT,
				);
			});
			let watchListener: ((event: LaneEvent) => void | Promise<void>) | undefined;
			const snapshot = laneSnapshot();
			const watchSession = vi.fn(async (sessionId: string) => ({
				id: "watch-1",
				sessionId,
				snapshot,
				async start(listener: (event: LaneEvent) => void | Promise<void>) {
					watchListener = listener;
				},
				async resnapshot() {
					return snapshot;
				},
				async dispose() {},
			}));
			const prompt = vi.fn(async () => {
				await watchListener?.({
					type: "entry_added",
					lane: "main",
					entry: {
						id: "entry-user",
						parentId: null,
						seq: 1,
						timestamp: 1,
						type: "message",
						message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
					},
				});
				await watchListener?.({
					type: "entry_added",
					lane: "main",
					entry: {
						id: "entry-assistant",
						parentId: "entry-user",
						seq: 2,
						timestamp: 2,
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "remote answer" }],
							provider: "test",
							model: "one",
							api: "test",
							usage: snapshot.stats.usage,
							stopReason: "stop",
							timestamp: 2,
						},
					},
				});
				return {
					ok: true as const,
					value: {
						operationId: "run-1",
						kind: "run" as const,
						status: "completed" as const,
						fromTipId: null,
						tipId: "entry-assistant",
						startedAt: 1,
						endedAt: 2,
					},
				};
			});

			const reloadSource =
				'"use strict";\nconst { defineFacet, defineService } = require("@earendil-works/chord");\nconst Models = defineService("pi.models");\nmodule.exports = { __esModule: true, default: defineFacet({ id: "test-tui-facet", setup(env) { env.use(Models); } }) };\n';
			const reloadArtifact: FacetBundleArtifact = {
				format: FACET_BUNDLE_ARTIFACT_FORMAT,
				formatVersion: FACET_BUNDLE_ARTIFACT_FORMAT_VERSION,
				plugin: { id: "test-tui-plugin" },
				entryName: "tui",
				entry: {
					file: "tui.cjs",
					integrity: `sha256-${createHash("sha256").update(reloadSource).digest("base64")}`,
					externalImports: ["@earendil-works/chord"],
				},
				source: reloadSource,
			};
			const reloadData = createPresentationFacetData([reloadArtifact]);
			const prepareSessionPlugins = vi.fn(async () => reloadData);
			const reloadPresentationPlugins = vi.fn(async () => reloadData);
			const reloadSessionPlugins = vi.fn(async () => {});
			const serverProvider = new RemoteServiceProvider([SessionDirectory, SessionManagement, PresentationPlugins]);
			serverProvider.provide(SessionDirectory, { state: directoryState });
			serverProvider.provide(PresentationPlugins, {
				prepareSession: prepareSessionPlugins,
				reload: reloadPresentationPlugins,
			});
			serverProvider.provide(SessionManagement, {
				create,
				async remove() {},
				async attach(sessionId) {
					attachment.set({ status: "attaching", sessionId }, BACKGROUND_CONTEXT);
				},
				async detach() {
					attachment.set({ status: "detached" }, BACKGROUND_CONTEXT);
				},
			});
			const sessionProvider = new RemoteServiceProvider([Models, AgentController, SessionPlugins]);
			sessionProvider.provide(SessionPlugins, { reload: reloadSessionPlugins });
			sessionProvider.provide(Models, {
				state: modelsState,
				async cycleThinking() {},
				async getThinkingLevels() {
					return ["off", "high"];
				},
				async refresh() {},
				select,
				selectThinking,
			});
			sessionProvider.provide(AgentController, createAgentController({ prompt } as unknown as AgentLane));

			const serverNamespace = createRemoteServiceBinding({
				services: [SessionDirectory, SessionManagement, PresentationPlugins],
				transport: createLoopbackServiceTransport(serverProvider),
				bound: false,
			});
			const serverNamespaceReady = serverNamespace.ready.bind(serverNamespace);
			const serverServices: ServerServiceSource = Object.assign(serverNamespace, {
				acceptsUnavailableServices: false,
				connection: connectionState,
				async catalogue() {
					return serverProvider.catalogue;
				},
				open() {
					return {
						use: serverNamespace.use.bind(serverNamespace),
						observe: serverNamespace.observe.bind(serverNamespace),
						async ready() {
							await serverNamespace.rebind(true, BACKGROUND_CONTEXT);
							await serverNamespaceReady(BACKGROUND_CONTEXT);
						},
						async dispose() {},
					};
				},
				async ready() {
					await serverNamespace.rebind(true, BACKGROUND_CONTEXT);
					await serverNamespaceReady(BACKGROUND_CONTEXT);
				},
			});
			const sessionNamespace = createRemoteServiceBinding({
				services: [Models, AgentController, SessionPlugins],
				transport: createLoopbackServiceTransport(sessionProvider),
				bound: false,
			});
			const sessionServices: SessionServiceSource = Object.assign(sessionNamespace, {
				acceptsUnavailableServices: true,
				attachment,
				async catalogue() {
					return [];
				},
				open() {
					return {
						use: sessionNamespace.use.bind(sessionNamespace),
						observe: sessionNamespace.observe.bind(sessionNamespace),
						ready: sessionNamespace.ready.bind(sessionNamespace),
						async dispose() {},
					};
				},
				async whenAttached(sessionId: string) {
					await sessionNamespace.rebind(true, BACKGROUND_CONTEXT);
					await sessionNamespace.ready(BACKGROUND_CONTEXT);
					attachment.set({ status: "attached", sessionId }, BACKGROUND_CONTEXT);
				},
				async whenDetached() {
					await sessionNamespace.rebind(false, BACKGROUND_CONTEXT);
					attachment.set({ status: "detached" }, BACKGROUND_CONTEXT);
				},
			});
			const server: ClientTuiServer = {
				serverId,
				radius: true,
				laneWatches: { watchSession },
				server: serverServices,
				session: sessionServices,
			};
			let finished = false;
			const requestRender = vi.fn();
			const ui = new TuiMainScreen(new ProcessTerminal());
			const component = await ExperimentalClientTui.create({
				command,
				ui,
				servers: [server],
				requestRender,
				finish() {
					finished = true;
				},
			});
			try {
				expect(create).toHaveBeenCalledTimes(creates);
				expect(prepareSessionPlugins).toHaveBeenCalledWith(
					{
						sessionId,
						packagePaths:
							"pluginPackages" in command
								? command.pluginPackages.map((packagePath) => resolve(packagePath))
								: null,
					},
					expect.anything(),
				);
				expect(attachment.value).toEqual({ status: "attached", sessionId });
				expect(watchSession).toHaveBeenCalledWith(sessionId);
				expect(select).not.toHaveBeenCalled();
				expect(component.render(80).join("\n")).toContain(`Server: ${serverId}`);
				expect(component.render(80).join("\n")).toContain(`Session: ${sessionId}`);
				expect(component.render(80).join("\n")).toContain("test/one");
				expect(component.render(80).join("\n")).not.toContain("Experimental Sessions");
				expect(component.render(80).join("\n")).not.toContain("Experimental Models");

				// Startup selection is the only behavior specific to continue and plugin-selected Sessions.
				if (kind !== "new") return;

				component.handleInput("hello");
				component.handleInput("\r");
				await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("hello", undefined, BACKGROUND_CONTEXT));
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("remote answer"));
				expect(component.render(80).join("\n")).toContain("hello");
				expect(component.render(80).join("\n")).not.toContain("Operation run-1 completed");

				component.handleInput("/reload");
				component.handleInput("\u001b");
				component.handleInput("\r");
				await vi.waitFor(() => {
					expect(reloadPresentationPlugins).toHaveBeenCalledOnce();
					expect(reloadSessionPlugins).toHaveBeenCalledOnce();
				});
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Reloaded plugins."));

				attachment.set({ status: "detached" }, BACKGROUND_CONTEXT);
				connectionState.set(
					{ status: "disconnected", since: "later", reason: "network lost", retryAt: null },
					BACKGROUND_CONTEXT,
				);
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("retrying"));
				component.handleInput("\u0003");
				expect(finished).toBe(true);
				finished = false;
				component.handleInput("\u0004");
				expect(finished).toBe(true);
				finished = false;
				connectionState.set({ status: "connecting", attempt: 1 }, BACKGROUND_CONTEXT);
				connectionState.set({ status: "connected", since: "reconnected" }, BACKGROUND_CONTEXT);
				attachment.set({ status: "attached", sessionId }, BACKGROUND_CONTEXT);
				await vi.waitFor(() => expect(watchSession).toHaveBeenCalledTimes(2));
				await vi.waitFor(() => expect(component.render(80).join("\n")).not.toContain("Reattaching"));

				component.handleInput("/model");
				component.handleInput("\u001b");
				component.handleInput("\r");
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Select model:"));
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				await vi.waitFor(() =>
					expect(select).toHaveBeenCalledWith({ provider: "test", modelId: "two" }, expect.anything()),
				);
				expect(modelsState.value.configuration.model).toEqual({ provider: "test", modelId: "two" });
				await vi.waitFor(() => expect(component.render(80).join("\n")).not.toContain("Select model:"));

				component.handleInput("/thinking");
				component.handleInput("\u001b");
				component.handleInput("\r");
				await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Select thinking level:"));
				component.handleInput("\u001b[B");
				component.handleInput("\r");
				await vi.waitFor(() => expect(selectThinking).toHaveBeenCalledWith("high", expect.anything()));
				expect(modelsState.value.configuration.thinkingLevel).toBe("high");

				component.handleInput("\u0003");
				await vi.waitFor(() => expect(finished).toBe(true));

				await component.close();
				const rendersAfterClose = requestRender.mock.calls.length;
				directoryState.set({ revision: 3, sessions: [] }, BACKGROUND_CONTEXT);
				attachment.set({ status: "detached" }, BACKGROUND_CONTEXT);
				modelsState.set({ ...modelsState.value, refresh: { status: "refreshing" } }, BACKGROUND_CONTEXT);
				expect(requestRender).toHaveBeenCalledTimes(rendersAfterClose);
			} finally {
				await component.close();
				await Promise.all([
					serverNamespace.dispose(BACKGROUND_CONTEXT),
					sessionNamespace.dispose(BACKGROUND_CONTEXT),
				]);
				serverProvider.dispose();
				sessionProvider.dispose();
			}
		},
	);
});

import {
	type AgentLane,
	BACKGROUND_CONTEXT,
	createLoopbackServiceConnection,
	RemoteServiceNamespace,
	RemoteServiceProvider,
	replicatedState,
} from "@earendil-works/pi-agent-core";
import type { SessionSummary } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { type ClientTuiServer, ExperimentalClientTui } from "../src/experimental/client-tui.ts";
import type { FacetLoader } from "../src/experimental/facet-loader.ts";
import { defineFacet } from "../src/experimental/facets.ts";
import { Chat } from "../src/experimental/services/chat.ts";
import { createChatService } from "../src/experimental/services/chat-provider.ts";
import type {
	ServerConnectionState,
	ServerServiceConnection,
	SessionAttachmentState,
	SessionServiceConnection,
} from "../src/experimental/services/connection.ts";
import { Models, type ModelsState } from "../src/experimental/services/models.ts";
import {
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
} from "../src/experimental/services/sessions.ts";
import { Tui } from "../src/experimental/services/tui.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

function session(sessionId: string, createdAt: number): SessionSummary {
	return { serverId, sessionId, createdAt };
}

describe("experimental client TUI", () => {
	test("creates a Session, selects a model, and runs a turn through facet service handles", async () => {
		const directoryState = replicatedState<SessionDirectoryState>({ revision: 1, sessions: [session("one", 1)] });
		const attachment = replicatedState<SessionAttachmentState>({ status: "detached" });
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
			directoryState.set({ revision: 2, sessions: [...directoryState.value.sessions, created] }, BACKGROUND_CONTEXT);
			return created;
		});
		const select = vi.fn(async (model: { provider: string; modelId: string }) => {
			modelsState.set(
				{ ...modelsState.value, configuration: { ...modelsState.value.configuration, model } },
				BACKGROUND_CONTEXT,
			);
		});
		const prompt = vi.fn(async () => ({
			ok: true as const,
			value: {
				operation: "run" as const,
				kind: "completed" as const,
				runId: "run-1",
				tipId: "entry-1",
			},
		}));

		const serverProvider = new RemoteServiceProvider([SessionDirectory, SessionManagement]);
		serverProvider.provide(SessionDirectory, { state: directoryState });
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
		const sessionProvider = new RemoteServiceProvider([Models, Chat]);
		sessionProvider.provide(Models, {
			state: modelsState,
			async cycleThinking() {},
			async refresh() {},
			select,
		});
		sessionProvider.provide(Chat, createChatService({ prompt } as unknown as AgentLane));

		const serverNamespace = new RemoteServiceNamespace({
			services: [SessionDirectory, SessionManagement],
			connection: createLoopbackServiceConnection(serverProvider),
			bound: false,
		});
		const serverServices: ServerServiceConnection = Object.assign(serverNamespace, {
			acceptsUnavailableServices: false,
			connection: replicatedState<ServerConnectionState>({ status: "connected", since: "now" }),
			async catalogue() {
				return serverProvider.catalogue;
			},
			open() {
				return serverNamespace;
			},
			async activate() {
				await serverNamespace.rebind(true, BACKGROUND_CONTEXT);
				await serverNamespace.ready(BACKGROUND_CONTEXT);
			},
		});
		const sessionNamespace = new RemoteServiceNamespace({
			services: [Models, Chat],
			connection: createLoopbackServiceConnection(sessionProvider),
			bound: false,
		});
		const sessionServices: SessionServiceConnection = Object.assign(sessionNamespace, {
			acceptsUnavailableServices: true,
			attachment,
			async catalogue() {
				return [];
			},
			open() {
				return sessionNamespace;
			},
			async activate() {
				await sessionNamespace.ready(BACKGROUND_CONTEXT);
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
		const server: ClientTuiServer = { serverId, server: serverServices, session: sessionServices };
		let finished = false;
		const requestRender = vi.fn();
		const disposeLoadedFacets = vi.fn(async () => {});
		const facetLoader: FacetLoader = {
			async load() {
				return {
					facets: [
						defineFacet({
							id: "test-tui-facet",
							setup(env) {
								const tui = env.use(Tui);
								env.onActivate(() => tui.setStatus("Loaded test TUI facet"));
							},
						}),
					],
					dispose: disposeLoadedFacets,
				};
			},
		};
		const component = await ExperimentalClientTui.create({
			servers: [server],
			facetLoader,
			requestRender,
			finish() {
				finished = true;
			},
		});
		try {
			expect(component.render(80).join("\n")).toContain("one");
			expect(component.render(80).join("\n")).toContain("Loaded test TUI facet");

			component.handleInput("\r");
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Experimental Models"));
			expect(create).toHaveBeenCalledOnce();
			expect(attachment.value).toEqual({ status: "attached", sessionId: "two" });

			component.handleInput("\u001b[B");
			component.handleInput("\r");
			await vi.waitFor(() =>
				expect(select).toHaveBeenCalledWith({ provider: "test", modelId: "two" }, expect.anything()),
			);
			expect(modelsState.value.configuration.model).toEqual({ provider: "test", modelId: "two" });
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Experimental Chat"));
			expect(component.render(80).join("\n")).toContain("Selected test/two");

			component.handleInput("hello");
			expect(component.render(80).join("\n")).toContain("hello");
			component.handleInput("\r");
			await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("hello", undefined, expect.anything()));
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Turn run-1 completed."));

			component.handleInput("\u001b");
			expect(component.render(80).join("\n")).toContain("Experimental Models");
			component.handleInput("\u001b");
			expect(component.render(80).join("\n")).toContain("Experimental Sessions");
			component.handleInput("\u001b");
			expect(finished).toBe(true);

			await component.close();
			expect(disposeLoadedFacets).toHaveBeenCalledOnce();
			const rendersAfterClose = requestRender.mock.calls.length;
			directoryState.set({ revision: 3, sessions: [] }, BACKGROUND_CONTEXT);
			attachment.set({ status: "detached" }, BACKGROUND_CONTEXT);
			modelsState.set({ ...modelsState.value, refresh: { status: "refreshing" } }, BACKGROUND_CONTEXT);
			expect(requestRender).toHaveBeenCalledTimes(rendersAfterClose);
		} finally {
			await component.close();
			await Promise.all([serverNamespace.dispose(BACKGROUND_CONTEXT), sessionNamespace.dispose(BACKGROUND_CONTEXT)]);
			serverProvider.dispose();
			sessionProvider.dispose();
		}
	});
});

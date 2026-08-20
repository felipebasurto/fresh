import { BACKGROUND_CONTEXT, remoteEvents, remoteState } from "@earendil-works/pi-agent-core";
import type { SessionSummary } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { type ClientTuiServer, ExperimentalClientTui } from "../src/experimental/client-tui.ts";
import type { SessionAttachmentState } from "../src/experimental/services/connection.ts";
import type { ModelsState } from "../src/experimental/services/models.ts";
import type { SessionDirectoryEvent, SessionDirectoryState } from "../src/experimental/services/sessions.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

function session(sessionId: string, createdAt: number): SessionSummary {
	return { serverId, sessionId, createdAt };
}

describe("experimental client TUI", () => {
	test("creates and switches Sessions, then selects a model using only service facades", async () => {
		const directoryState = remoteState<SessionDirectoryState>({ revision: 1, sessions: [session("one", 1)] });
		const directoryEvents = remoteEvents<SessionDirectoryEvent>();
		const attachment = remoteState<SessionAttachmentState>({ status: "detached" });
		const modelsState = remoteState<ModelsState>({
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
			directoryEvents.emit({ type: "created", session: created }, BACKGROUND_CONTEXT);
			return created;
		});
		const attach = vi.fn(async (sessionId: string) => {
			attachment.set({ status: "attaching", sessionId }, BACKGROUND_CONTEXT);
			attachment.set({ status: "attached", sessionId }, BACKGROUND_CONTEXT);
		});
		const detach = vi.fn(async () => {
			attachment.set({ status: "detached" }, BACKGROUND_CONTEXT);
		});
		const select = vi.fn(async (model: { provider: string; modelId: string }) => {
			modelsState.set(
				{ ...modelsState.value, configuration: { ...modelsState.value.configuration, model } },
				BACKGROUND_CONTEXT,
			);
		});
		const server: ClientTuiServer = {
			serverId,
			directory: { state: directoryState, events: directoryEvents },
			management: { create, attach, detach },
			attachment,
			models: {
				state: modelsState,
				async cycleThinking() {},
				async refresh() {},
				select,
			},
		};
		let finished = false;
		const component = new ExperimentalClientTui({
			servers: [server],
			requestRender() {},
			finish() {
				finished = true;
			},
		});
		try {
			expect(component.render(80).join("\n")).toContain("one");
			component.handleInput("\r");
			await vi.waitFor(() => expect(component.render(80).join("\n")).toContain("Experimental Models"));
			expect(create).toHaveBeenCalledOnce();
			expect(attach).toHaveBeenCalledWith("two", expect.anything());
			expect(attachment.value).toEqual({ status: "attached", sessionId: "two" });

			component.handleInput("\u001b[B");
			component.handleInput("\r");
			await vi.waitFor(() =>
				expect(select).toHaveBeenCalledWith({ provider: "test", modelId: "two" }, expect.anything()),
			);
			expect(modelsState.value.configuration.model).toEqual({ provider: "test", modelId: "two" });

			component.handleInput("\u001b");
			expect(component.render(80).join("\n")).toContain("Experimental Sessions");
			component.handleInput("\u001b");
			expect(finished).toBe(true);
		} finally {
			component.dispose();
		}
	});
});

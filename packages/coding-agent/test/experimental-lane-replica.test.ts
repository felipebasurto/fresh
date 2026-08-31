import { replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LaneTranscriptSnapshot } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { openLaneReplica } from "../src/experimental/lane-replica.ts";
import type { TranscriptState } from "../src/experimental/services/transcript.ts";

function snapshot(tipId: string | null = null): LaneTranscriptSnapshot {
	return {
		lane: "main",
		transcript: [],
		tipId,
		configuration: {
			model: { provider: "test", modelId: "model" },
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

describe("experimental lane replica", () => {
	test("installs complete transcript state and forwards only live events", async () => {
		const staleEvent = { type: "run_start", lane: "main", runId: "stale", startedAt: 1 } as const;
		const state = replicatedState<TranscriptState>({ snapshot: snapshot(), event: staleEvent });
		const onEvent = vi.fn();
		const replica = await openLaneReplica({ state }, onEvent);
		const changed = vi.fn();
		replica.subscribe(changed);
		expect(onEvent).not.toHaveBeenCalled();

		state.state.snapshot = snapshot("replacement-tip");
		state.state.event = null;
		state.publish(BACKGROUND_CONTEXT);
		expect(replica.state().tipId).toBe("replacement-tip");
		expect(changed).toHaveBeenCalledOnce();

		const liveEvent = { type: "run_resume", lane: "main", runId: "run-1" } as const;
		state.state.event = liveEvent;
		state.publish(BACKGROUND_CONTEXT);
		await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(liveEvent));
		await replica.close();
	});

	test("waits for the first initialized transcript value", async () => {
		const state = replicatedState<TranscriptState>({ snapshot: null, event: null });
		const opening = openLaneReplica({ state });
		state.state.snapshot = snapshot("ready");
		state.publish(BACKGROUND_CONTEXT);
		const replica = await opening;
		expect(replica.state().tipId).toBe("ready");
		await replica.close();
	});
});

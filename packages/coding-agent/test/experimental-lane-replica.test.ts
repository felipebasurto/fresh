import { cloneJsonValue, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LaneSnapshot } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import { openLaneReplica } from "../src/experimental/lane-replica.ts";
import type { TranscriptUpdate } from "../src/experimental/services/transcript.ts";

function snapshot(tipId: string | null = null): LaneSnapshot {
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
	test("uses the Harness reducer and installs provider rebases", async () => {
		const updates = replicatedState<TranscriptUpdate | null>(null);
		const readSnapshot = vi.fn(async () => ({ revision: 0, snapshot: cloneJsonValue(snapshot()) }));
		const replica = await openLaneReplica({ updates, snapshot: readSnapshot }, "session-1");
		const changed = vi.fn();
		replica.subscribe(changed);

		updates.set(
			{
				type: "event",
				revision: 1,
				event: { type: "run_start", lane: "main", runId: "run-1", startedAt: 1 },
			},
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(() => expect(replica.state().operation).toMatchObject({ id: "run-1", kind: "run" }));
		expect(changed).toHaveBeenCalledOnce();

		updates.set(
			{
				type: "event",
				revision: 2,
				event: {
					type: "navigation_end",
					lane: "main",
					runId: "navigation-1",
					status: "completed",
					fromTipId: null,
					tipId: "replacement-tip",
					endedAt: 2,
				},
			},
			BACKGROUND_CONTEXT,
		);
		updates.set(
			{ type: "snapshot", revision: 3, snapshot: cloneJsonValue(snapshot("replacement-tip")) },
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(() => expect(replica.state().tipId).toBe("replacement-tip"));
		expect(readSnapshot).toHaveBeenCalledOnce();

		await replica.close();
	});

	test("repairs an application revision gap from a fresh snapshot", async () => {
		const updates = replicatedState<TranscriptUpdate | null>(null);
		const readSnapshot = vi
			.fn()
			.mockResolvedValueOnce({ revision: 0, snapshot: cloneJsonValue(snapshot()) })
			.mockResolvedValueOnce({ revision: 2, snapshot: cloneJsonValue(snapshot("caught-up")) });
		const replica = await openLaneReplica({ updates, snapshot: readSnapshot }, "session-1");

		updates.set(
			{
				type: "event",
				revision: 2,
				event: { type: "run_start", lane: "main", runId: "run-2", startedAt: 2 },
			},
			BACKGROUND_CONTEXT,
		);

		await vi.waitFor(() => expect(replica.state().tipId).toBe("caught-up"));
		expect(readSnapshot).toHaveBeenCalledTimes(2);
		await replica.close();
	});
});

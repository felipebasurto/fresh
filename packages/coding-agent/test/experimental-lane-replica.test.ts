import type { LaneEvent, LaneSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test, vi } from "vitest";
import { openLaneReplica } from "../src/experimental/lane-replica.ts";

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
	test("uses the Harness reducer and resnapshots navigation rebases", async () => {
		let listener: ((event: LaneEvent) => void | Promise<void>) | undefined;
		const replacement = snapshot("replacement-tip");
		const resnapshot = vi.fn(async () => replacement);
		const dispose = vi.fn(async () => {});
		const replica = await openLaneReplica(
			{
				async watchSession(sessionId) {
					return {
						id: "watch-1",
						sessionId,
						snapshot: snapshot(),
						async start(next) {
							listener = next;
						},
						resnapshot,
						dispose,
					};
				},
			},
			"session-1",
		);
		const changed = vi.fn();
		replica.subscribe(changed);

		await listener?.({ type: "run_start", lane: "main", runId: "run-1", startedAt: 1 });
		expect(replica.state().operation).toMatchObject({ id: "run-1", kind: "run" });
		expect(changed).toHaveBeenCalledOnce();

		await listener?.({
			type: "navigation_end",
			lane: "main",
			runId: "navigation-1",
			status: "completed",
			fromTipId: null,
			tipId: "replacement-tip",
			endedAt: 2,
		});
		expect(resnapshot).toHaveBeenCalledOnce();
		expect(replica.state().tipId).toBe("replacement-tip");

		await replica.close();
		expect(dispose).toHaveBeenCalledOnce();
	});
});

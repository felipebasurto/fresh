import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateRevalidationEntries, runSucceeded } from "./freshctx-ab-metrics.mjs";

describe("aggregateRevalidationEntries", () => {
	it("keeps request verdict counts separate from engine unit-state counts", () => {
		const aggregated = aggregateRevalidationEntries([
			{
				type: "custom",
				customType: "freshctx_revalidation",
				data: {
					outcome: "STABLE",
					blocked: false,
					planId: "p1",
					selectionGranularity: "region",
					selectedUnits: ["u1"],
					selectedFiles: ["a.py"],
					regionBytes: 40,
					wholeFileEquivalentBytes: 400,
					unitStates: { stable: 3, relocated: 1 },
				},
			},
			{
				type: "custom",
				customType: "freshctx_revalidation",
				data: {
					outcome: "WRONG",
					blocked: true,
					planId: "p2",
					selectionGranularity: "region",
					selectedUnits: ["u2"],
					selectedFiles: ["a.py"],
					regionBytes: 12,
					wholeFileEquivalentBytes: 400,
					unitStates: { stable: 2 },
				},
			},
		]);
		assert.equal(aggregated.requestVerdictCounts.total, 2);
		assert.equal(aggregated.requestVerdictCounts.stable, 1);
		assert.equal(aggregated.requestVerdictCounts.wrong, 1);
		assert.equal(aggregated.requestVerdictCounts.driftBlocked, 1);
		assert.deepEqual(aggregated.unitStateCounts, { stable: 5, relocated: 1 });
		assert.notEqual(aggregated.requestVerdictCounts.stable, aggregated.unitStateCounts.stable);
		assert.equal(aggregated.plans.length, 2);
		assert.deepEqual(aggregated.plans[0], {
			prepareRequestIndex: null,
			planId: "p1",
			selectionGranularity: "region",
			observedResultIds: [],
			selectedUnits: ["u1"],
			selectedFiles: ["a.py"],
			regionBytes: 40,
			wholeFileEquivalentBytes: 400,
			verdict: "STABLE",
			blocked: false,
		});
		assert.equal(aggregated.plans[1].blocked, true);
		assert.equal(aggregated.plans[1].planId, "p2");
	});
});

describe("runSucceeded", () => {
	it("requires a zero CLI exit code", () => {
		assert.equal(
			runSucceeded({ verifyStatus: "PASS", timedOut: false, exitCode: 0, driftBlocked: 0 }),
			true,
		);
		assert.equal(
			runSucceeded({ verifyStatus: "PASS", timedOut: false, exitCode: 1, driftBlocked: 0 }),
			false,
		);
		assert.equal(
			runSucceeded({ verifyStatus: "PASS", timedOut: false, exitCode: null, driftBlocked: 0 }),
			false,
		);
	});
});

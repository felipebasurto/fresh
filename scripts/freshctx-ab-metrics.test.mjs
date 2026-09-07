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
			requestedGranularity: null,
			engineGranularity: null,
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

	it("carries requested vs engine-echoed granularity per plan", () => {
		const aggregated = aggregateRevalidationEntries([
			{
				type: "custom",
				customType: "freshctx_revalidation",
				data: {
					outcome: "STABLE",
					blocked: false,
					planId: "p3",
					selectionGranularity: "file",
					requestedGranularity: "file",
					engineGranularity: "file",
					observedResultIds: ["r1"],
					selectedUnits: ["u3"],
					selectedFiles: ["a.py"],
					regionBytes: 100,
					wholeFileEquivalentBytes: null,
					unitStates: {},
				},
			},
		]);
		assert.deepEqual(aggregated.plans[0]?.requestedGranularity, "file");
		assert.deepEqual(aggregated.plans[0]?.engineGranularity, "file");
	});

	it("collects pre-commit rejections as prepare attempts with accepted=false", () => {
		const aggregated = aggregateRevalidationEntries([
			{
				type: "custom",
				customType: "freshctx_prepare_attempt",
				data: {
					requestedGranularity: "file",
					engineGranularity: "region",
					planId: "fp_mismatch",
					prepareAttemptIndex: 1,
					accepted: false,
					blockCode: "invalid-plan",
				},
			},
		]);
		assert.equal(aggregated.prepareAttempts.length, 1);
		assert.deepEqual(aggregated.prepareAttempts[0], {
			requestedGranularity: "file",
			engineGranularity: "region",
			planId: "fp_mismatch",
			prepareAttemptIndex: 1,
			accepted: false,
			blockCode: "invalid-plan",
		});
		assert.equal(aggregated.plans.length, 0);
	});

	it("collects attempts embedded in revalidation entries", () => {
		const aggregated = aggregateRevalidationEntries([
			{
				type: "custom",
				customType: "freshctx_revalidation",
				data: {
					outcome: "STABLE",
					blocked: false,
					planId: "p4",
					selectionGranularity: "file",
					observedResultIds: [],
					selectedUnits: [],
					selectedFiles: [],
					regionBytes: 10,
					wholeFileEquivalentBytes: null,
					unitStates: {},
					prepareAttempts: [
						{
							requestedGranularity: "file",
							engineGranularity: "file",
							planId: "p4",
							prepareAttemptIndex: 1,
							accepted: true,
							blockCode: null,
						},
					],
				},
			},
		]);
		assert.equal(aggregated.prepareAttempts.length, 1);
		assert.deepEqual(aggregated.prepareAttempts[0]?.accepted, true);
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

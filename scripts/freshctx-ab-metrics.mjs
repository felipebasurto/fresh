// Pure session-line aggregators for the FreshCtx A/B pilot.
// Kept separate so telemetry shape can be regression-tested without a live run.

/** Empty per-request verdict counters (never mixed with engine unit-states). */
export function emptyVerdictCounts() {
	return {
		total: 0,
		stable: 0,
		relocated: 0,
		updated: 0,
		ambiguous: 0,
		invalidated: 0,
		unchecked: 0,
		wrong: 0,
		driftBlocked: 0,
	};
}

/** Aggregate revalidation custom entries into distinct telemetry fields. */
export function aggregateRevalidationEntries(entries) {
	const requestVerdictCounts = emptyVerdictCounts();
	const unitStateCounts = {};
	const plans = [];
	const prepareAttempts = [];
	for (const entry of entries) {
		if (!entry || entry.type !== "custom") {
			continue;
		}
		if (entry.customType === "freshctx_prepare_attempt") {
			prepareAttempts.push(normalizeAttempt(entry.data));
			continue;
		}
		if (entry.customType !== "freshctx_revalidation") {
			continue;
		}
		const d = entry.data ?? {};
		requestVerdictCounts.total += 1;
		const key = typeof d.outcome === "string" ? d.outcome.toLowerCase() : "";
		if (key === "wrong") {
			requestVerdictCounts.wrong += 1;
		} else if (key in requestVerdictCounts) {
			requestVerdictCounts[key] += 1;
		}
		if (d.blocked) {
			requestVerdictCounts.driftBlocked += 1;
		}
		const states = d.unitStates ?? {};
		for (const [status, count] of Object.entries(states)) {
			if (typeof count !== "number") {
				continue;
			}
			const k = String(status).toLowerCase();
			unitStateCounts[k] = (unitStateCounts[k] ?? 0) + count;
		}
		plans.push({
			prepareRequestIndex: typeof d.prepareRequestIndex === "number" ? d.prepareRequestIndex : null,
			planId: d.planId ?? null,
			selectionGranularity: d.selectionGranularity ?? null,
			requestedGranularity: typeof d.requestedGranularity === "string" ? d.requestedGranularity : null,
			engineGranularity: typeof d.engineGranularity === "string" ? d.engineGranularity : null,
			observedResultIds: Array.isArray(d.observedResultIds) ? d.observedResultIds : [],
			selectedUnits: Array.isArray(d.selectedUnits) ? d.selectedUnits : [],
			selectedFiles: Array.isArray(d.selectedFiles) ? d.selectedFiles : [],
			regionBytes: typeof d.regionBytes === "number" ? d.regionBytes : null,
			wholeFileEquivalentBytes:
				typeof d.wholeFileEquivalentBytes === "number" ? d.wholeFileEquivalentBytes : null,
			verdict: d.outcome ?? null,
			blocked: Boolean(d.blocked),
		});
		for (const attempt of Array.isArray(d.prepareAttempts) ? d.prepareAttempts : []) {
			prepareAttempts.push(normalizeAttempt(attempt));
		}
	}
	return { requestVerdictCounts, unitStateCounts, plans, prepareAttempts };
}

/** Normalize one prepare-attempt record (standalone entry or embedded in a verdict). */
function normalizeAttempt(d) {
	const data = d ?? {};
	return {
		requestedGranularity:
			typeof data.requestedGranularity === "string" ? data.requestedGranularity : null,
		engineGranularity: typeof data.engineGranularity === "string" ? data.engineGranularity : null,
		planId: typeof data.planId === "string" ? data.planId : null,
		prepareAttemptIndex:
			typeof data.prepareAttemptIndex === "number" ? data.prepareAttemptIndex : null,
		accepted: data.accepted === true,
		blockCode: typeof data.blockCode === "string" ? data.blockCode : null,
	};
}

/** Success gate: verify pass, contract ok, no timeout, zero CLI exit. */
export function runSucceeded({ verifyStatus, timedOut, exitCode, driftBlocked, contractOk }) {
	return (
		verifyStatus === "PASS" &&
		timedOut !== true &&
		exitCode === 0 &&
		(driftBlocked ?? 0) === 0 &&
		contractOk !== false
	);
}

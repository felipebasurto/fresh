import type { SessionEntry } from "../session-manager.ts";
import {
	FRESHCTX_OBSERVATION_CUSTOM_TYPE,
	type FreshCtxReadObservation,
	isFreshCtxReadObservation,
	toWorkspaceRelativePath,
} from "./observations.ts";

/**
 * Resume/branch observation state (Phase D).
 *
 * Derives the active observation set from persisted session entries on the
 * current branch. Rules:
 * - Only entries on the current branch are active (abandoned branches never
 *   leak into preparation).
 * - Malformed entries are excluded, never trusted (hardened further in
 *   compaction handling).
 * - Duplicate identities keep the first occurrence.
 * - Workspace-relative paths are recomputed against the current workspace:
 *   sessions that moved still resolve; files outside the workspace are
 *   excluded (outside the freshness guarantee, like shell output).
 * - Files that changed on disk are KEPT active: preparation re-observes the
 *   original bytes from the payload while the server projects current disk
 *   bytes (refresh, not exclusion).
 */

export const FRESHCTX_UNITS_CUSTOM_TYPE = "freshctx_units";
export const FRESHCTX_REVALIDATION_CUSTOM_TYPE = "freshctx_revalidation";
export const FRESHCTX_SESSION_STATE_VERSION = 1;
/** Marker on default-path compaction details: the input view was applied. */
export const FRESHCTX_VIEW_MARKER = "freshctxView";

/** Stamp default-path compaction details; pre-integration summaries lack it. */
export function withFreshCtxViewMarker(details: unknown): unknown {
	if (details === undefined || details === null) {
		return { [FRESHCTX_VIEW_MARKER]: 1 };
	}
	if (typeof details !== "object") {
		return details;
	}
	return { ...(details as Record<string, unknown>), [FRESHCTX_VIEW_MARKER]: 1 };
}

/** True when the compaction entry was produced with the FreshCtx input view. */
export function hasFreshCtxViewMarker(entry: { details?: unknown }): boolean {
	const details: unknown = entry.details;
	return (
		typeof details === "object" &&
		details !== null &&
		(details as Record<string, unknown>)[FRESHCTX_VIEW_MARKER] === 1
	);
}

export type FreshCtxExclusionReason = "corrupt" | "duplicate" | "outside-workspace";

export interface FreshCtxExcludedObservation {
	obsId: string;
	reason: FreshCtxExclusionReason;
}

export interface FreshCtxSessionRefresh {
	active: FreshCtxReadObservation[];
	excluded: FreshCtxExcludedObservation[];
}

export function refreshSessionObservations(entries: SessionEntry[], cwd: string): FreshCtxSessionRefresh {
	const active: FreshCtxReadObservation[] = [];
	const excluded: FreshCtxExcludedObservation[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== FRESHCTX_OBSERVATION_CUSTOM_TYPE) {
			continue;
		}
		const data: unknown = entry.data;
		if (!isFreshCtxReadObservation(data)) {
			excluded.push({ obsId: "unknown", reason: "corrupt" });
			continue;
		}
		if (seen.has(data.obsId)) {
			excluded.push({ obsId: data.obsId, reason: "duplicate" });
			continue;
		}
		seen.add(data.obsId);
		const workspaceRelativePath = toWorkspaceRelativePath(data.absolutePath, cwd);
		if (!workspaceRelativePath) {
			excluded.push({ obsId: data.obsId, reason: "outside-workspace" });
			continue;
		}
		active.push({ ...data, workspaceRelativePath });
	}
	return { active, excluded };
}

export interface FreshCtxResolvedUnit {
	resultId: string;
	unitId: string;
	revision: string;
	path: string;
}

export interface FreshCtxUnitsData {
	version: number;
	units: FreshCtxResolvedUnit[];
	timestamp: string;
}

/** Resolved units from the latest persisted `freshctx_units` entry, if any. */
export function collectPersistedUnits(entries: SessionEntry[]): FreshCtxResolvedUnit[] {
	let latest: FreshCtxUnitsData | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== FRESHCTX_UNITS_CUSTOM_TYPE) {
			continue;
		}
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null || !Array.isArray((data as { units?: unknown }).units)) {
			continue;
		}
		latest = data as FreshCtxUnitsData;
	}
	return latest?.units ?? [];
}

/** Order-insensitive comparison for unit-set change detection. */
export function resolvedUnitsEqual(previous: FreshCtxResolvedUnit[], next: FreshCtxResolvedUnit[]): boolean {
	if (previous.length !== next.length) {
		return false;
	}
	const key = (unit: FreshCtxResolvedUnit): string => `${unit.unitId}\n${unit.revision}\n${unit.path}`;
	const left = new Set(previous.map(key));
	return next.every((unit) => left.has(key(unit)));
}

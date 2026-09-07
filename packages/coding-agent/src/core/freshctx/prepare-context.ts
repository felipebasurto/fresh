import { randomUUID } from "node:crypto";
import { DEFAULT_MAX_BYTES, formatSize } from "../tools/truncate.ts";
import { type FreshCtxReadObservation, sha256Hex } from "./observations.ts";
import type { FreshCtxClient } from "./runtime.ts";
import type { FreshCtxResolvedUnit } from "./session-state.ts";

/**
 * Atomic FreshCtx request preparation (Phase C).
 *
 * For each outgoing model request:
 *  1. Clone the payload (the original is never mutated).
 *  2. Reconstruct each tracked observation's original bytes from the
 *     payload's tool text and verify them against the recorded hash.
 *     Anything unverifiable blocks dispatch — never silently reverts.
 *  3. Observe verified results, prepare a plan, validate the projection
 *     hash and every replacement, apply markers to the clone, append
 *     exactly one projection, validate pairing/size, and commit.
 *  4. Dispatch only after a successful commit. Any failure throws
 *     FreshCtxBlockedError before any HTTP is sent.
 *
 * Scope: OpenAI Chat Completions serialization only. Other providers and
 * payload shapes are blocked, never passed through as compatible.
 */

export const FRESHCTX_PREPARE_ADAPTER = "freshctx-pi-native/openai-completions";
export const FRESHCTX_DEFAULT_BUDGET_BYTES = 131072;

export type FreshCtxBlockCode =
	| "invalid-payload"
	| "tampered-result"
	| "unsupported-provider"
	| "budget-exhausted"
	| "invalid-plan"
	| "unexpected-replacement"
	| "commit-failed"
	| "transport"
	| "drift-blocked";

export class FreshCtxBlockedError extends Error {
	readonly code: FreshCtxBlockCode;
	constructor(code: FreshCtxBlockCode, message: string, options?: { cause?: unknown }) {
		super(`FreshCtx blocked dispatch (${code}): ${message}`, options);
		this.name = "FreshCtxBlockedError";
		this.code = code;
	}
}

export interface FreshCtxPrepareSettings {
	/** Projection byte budget cap. Default: 131072. */
	budgetBytes?: number;
	/** Selection granularity sent to the engine. Default: region. */
	selectionGranularity?: FreshCtxSelectionGranularity;
	/** Disk-text reader for independent revalidation. Absent skips WRONG detection (fail-open, recorded). */
	readDiskText?: (absolutePath: string) => string | null;
	/** Optional cap on total serialized request bytes (checked after commit). */
	maxRequestBytes?: number;
	/**
	 * Optional hard cap on estimated outgoing tokens. Estimated with the
	 * chars/4 heuristic shared with Pi's compaction estimator (conservative
	 * overestimate for text). Checked before commit with reserved output
	 * subtracted; oversize blocks with guidance to compact.
	 */
	maxRequestTokens?: number;
	/** Tokens reserved for the model's reply, subtracted from the token cap. */
	reservedOutputTokens?: number;
}

interface VerifiedObservation {
	obs: FreshCtxReadObservation;
	/** Original shown bytes reconstructed from the payload. */
	shownText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** revisionFor from the FreshCtx protocol: "sha256:" + hex(sha256(utf8)). */
export function revisionForText(text: string): string {
	return `sha256:${sha256Hex(Buffer.from(text, "utf-8"))}`;
}

/** Re-derive the exact continuation notice read.ts appended after shown text. */
export function deriveReadNotice(obs: FreshCtxReadObservation): string | null {
	if (obs.truncatedBy === null) {
		return null;
	}
	if (obs.truncatedBy === "user-limit") {
		const remaining = obs.totalLines - obs.endLine;
		const nextOffset = obs.endLine + 1;
		return `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	}
	const nextOffset = obs.endLine + 1;
	if (obs.truncatedBy === "lines") {
		return `\n\n[Showing lines ${obs.startLine}-${obs.endLine} of ${obs.totalLines}. Use offset=${nextOffset} to continue.]`;
	}
	return `\n\n[Showing lines ${obs.startLine}-${obs.endLine} of ${obs.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
}

/**
 * Recover the exact originally-shown bytes from payload tool text and verify
 * them against the recorded hash. Throws FreshCtxBlockedError on any mismatch.
 */
export function reconstructShownText(content: string, obs: FreshCtxReadObservation): string {
	const notice = deriveReadNotice(obs);
	let shown = content;
	if (notice !== null) {
		if (!content.endsWith(notice)) {
			throw new FreshCtxBlockedError(
				"tampered-result",
				`tool result ${obs.obsId} no longer carries its read notice`,
			);
		}
		shown = content.slice(0, content.length - notice.length);
	}
	if (sha256Hex(Buffer.from(shown, "utf-8")) !== obs.shownSha256) {
		throw new FreshCtxBlockedError("tampered-result", `tool result ${obs.obsId} bytes differ from observation`);
	}
	return shown;
}

interface CompletionsToolMessage {
	index: number;
	toolCallId: string;
	content: string;
}

function collectToolMessages(payload: unknown): { toolById: Map<string, CompletionsToolMessage>; allIds: string[] } {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) {
		throw new FreshCtxBlockedError("invalid-payload", "expected a Chat Completions request with messages");
	}
	const calls = new Set<string>();
	for (const message of payload.messages) {
		if (!isRecord(message)) {
			throw new FreshCtxBlockedError("invalid-payload", "invalid native message");
		}
		if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				if (!isRecord(call) || typeof call.id !== "string" || calls.has(call.id)) {
					throw new FreshCtxBlockedError("invalid-payload", "duplicate or invalid tool call ID");
				}
				calls.add(call.id);
			}
		}
	}
	const toolById = new Map<string, CompletionsToolMessage>();
	const allIds: string[] = [];
	payload.messages.forEach((message: unknown, index: number) => {
		if (!isRecord(message) || message.role !== "tool") {
			return;
		}
		if (typeof message.tool_call_id !== "string" || toolById.has(message.tool_call_id)) {
			throw new FreshCtxBlockedError("invalid-payload", "unpaired or duplicate tool result");
		}
		if (!calls.has(message.tool_call_id)) {
			throw new FreshCtxBlockedError("invalid-payload", "unpaired or duplicate tool result");
		}
		allIds.push(message.tool_call_id);
		if (typeof message.content === "string") {
			toolById.set(message.tool_call_id, {
				index,
				toolCallId: message.tool_call_id,
				content: message.content,
			});
		}
		// Non-string tool content (e.g. image blocks) cannot be hash-verified:
		// left untouched below; server markers for it are ignored, never applied.
	});
	return { toolById, allIds };
}

export type FreshCtxSelectionGranularity = "region" | "file";

export interface ValidatedPlan {
	planId: string;
	replacements: Array<{ resultId: string; expectedSha256: string; marker: string }>;
	/** Unit IDs selected for the projection (opaque strings). */
	selected: string[];
	/** Omitted units keyed by unit ID. */
	omitted: Array<{ unitId: string; reason: string }>;
	projection: string;
	/** Engine-reported selection granularity. Defaults to region for legacy plans. */
	selectionGranularity: FreshCtxSelectionGranularity;
	/** Engine-reported per-unit relocation statuses, keyed by unit ID. */
	unitStates: Record<string, { status: string; previousRange: unknown; currentRange: unknown }>;
	/**
	 * Structural counterfactual (region mode only): synchronized whole-file
	 * bytes of every distinct selected file, measured but never injected.
	 */
	wholeFileEquivalent: { files: Array<{ path: string; bytes: number }>; whole_file_bytes: number } | null;
}

function validatePlan(plan: unknown, budgetBytes: number): ValidatedPlan {
	if (!isRecord(plan) || typeof plan.plan_id !== "string" || !Array.isArray(plan.replacements)) {
		throw new FreshCtxBlockedError("invalid-plan", "malformed prepare response");
	}
	if (typeof plan.projection_utf8_base64 !== "string" || typeof plan.projection_sha256 !== "string") {
		throw new FreshCtxBlockedError("invalid-plan", "malformed projection");
	}
	const projection = Buffer.from(plan.projection_utf8_base64, "base64").toString("utf-8");
	if (revisionForText(projection) !== plan.projection_sha256) {
		throw new FreshCtxBlockedError("invalid-plan", "projection hash mismatch");
	}
	if (Buffer.byteLength(projection, "utf-8") > budgetBytes) {
		throw new FreshCtxBlockedError("invalid-plan", "projection exceeds budget");
	}
	const replacements: ValidatedPlan["replacements"] = [];
	const seen = new Set<string>();
	for (const replacement of plan.replacements) {
		if (
			!isRecord(replacement) ||
			typeof replacement.result_id !== "string" ||
			typeof replacement.expected_sha256 !== "string" ||
			typeof replacement.marker !== "string" ||
			seen.has(replacement.result_id)
		) {
			throw new FreshCtxBlockedError("invalid-plan", "malformed replacement");
		}
		seen.add(replacement.result_id);
		replacements.push({
			resultId: replacement.result_id,
			expectedSha256: replacement.expected_sha256,
			marker: replacement.marker,
		});
	}
	if (!Array.isArray(plan.selected) || !plan.selected.every((entry) => typeof entry === "string")) {
		throw new FreshCtxBlockedError("invalid-plan", "malformed selected units");
	}
	const selected: string[] = [...plan.selected];
	if (!Array.isArray(plan.omitted)) {
		throw new FreshCtxBlockedError("invalid-plan", "malformed omitted units");
	}
	const omitted: ValidatedPlan["omitted"] = [];
	for (const entry of plan.omitted) {
		if (!isRecord(entry) || typeof entry.unitId !== "string" || typeof entry.reason !== "string") {
			throw new FreshCtxBlockedError("invalid-plan", "malformed omitted unit");
		}
		omitted.push({ unitId: entry.unitId, reason: entry.reason });
	}
	// Additive engine fields: absent on legacy servers/fakes means region mode
	// with no per-unit states or counterfactual. selectionGranularity is
	// authoritative when present — never infer strategy from payload shape.
	const raw = plan as Record<string, unknown>;
	const selectionGranularity: FreshCtxSelectionGranularity = raw.selection_granularity === "file" ? "file" : "region";
	const unitStates: ValidatedPlan["unitStates"] =
		isRecord(raw.unit_states) &&
		Object.values(raw.unit_states).every(
			(entry): entry is { status: string; previousRange: unknown; currentRange: unknown } =>
				isRecord(entry) && typeof entry.status === "string",
		)
			? (raw.unit_states as ValidatedPlan["unitStates"])
			: {};
	const wholeFileEquivalent: ValidatedPlan["wholeFileEquivalent"] =
		isRecord(raw.whole_file_equivalent) &&
		typeof raw.whole_file_equivalent.whole_file_bytes === "number" &&
		Array.isArray(raw.whole_file_equivalent.files) &&
		(raw.whole_file_equivalent.files as unknown[]).every(
			(entry): entry is { path: string; bytes: number } =>
				isRecord(entry) && typeof entry.path === "string" && typeof entry.bytes === "number",
		)
			? (raw.whole_file_equivalent as ValidatedPlan["wholeFileEquivalent"])
			: null;
	return {
		planId: plan.plan_id,
		replacements,
		selected,
		omitted,
		projection,
		selectionGranularity,
		unitStates,
		wholeFileEquivalent,
	};
}

export type FreshCtxRevalidationOutcome =
	| "STABLE"
	| "RELOCATED"
	| "UPDATED"
	| "AMBIGUOUS"
	| "INVALIDATED"
	| "WRONG"
	| "UNCHECKED";

export interface FreshCtxReferent {
	resultId: string;
	/** Exact bytes originally shown for this observation. */
	shownText: string;
	/** Current disk text of the observed file, when readable. Null skips WRONG detection for that referent. */
	diskText: string | null;
	/**
	 * The engine-projected section for this referent's file, when the caller
	 * can split the multi-file projection per path. When null, the whole
	 * projection is used (single-file case). Prevents cross-file lines from
	 * failing the refresh check for multi-file plans.
	 */
	projectionSection?: string | null;
}

export interface FreshCtxRevalidationVerdict {
	outcome: FreshCtxRevalidationOutcome;
	/** Observed referents missing from the projection although selected. */
	missingReferents: string[];
}

/**
 * Independent Fresh-side revalidation of a committed plan.
 *
 * Pure function: no I/O. Compares each verified observation's original shown
 * bytes against the engine's projected text for the current disk state, and
 * trusts the engine's own unit_states for RELOCATED/UPDATED classification.
 * A missing referent whose disk text still contains it (or whose disk text
 * is unavailable and the projection does not cover current disk) is WRONG:
 * the engine claimed success but projects neither the referent nor a
 * faithful refresh. diskText=null referents never trigger WRONG alone —
 * they yield UNCHECKED when nothing else decides the outcome.
 */
export function classifyRevalidation(plan: ValidatedPlan, referents: FreshCtxReferent[]): FreshCtxRevalidationVerdict {
	const selected = new Set(plan.selected);
	const answered = new Set(plan.replacements.map((replacement) => replacement.resultId));
	const missingReferents: string[] = [];
	let judged = 0;
	let unchecked = 0;
	for (const referent of referents) {
		if (!answered.has(referent.resultId) || selected.size === 0) {
			continue;
		}
		judged += 1;
		// The referent check runs against the whole projection (the model sees
		// all of it); the refresh check runs against this referent's file
		// section only (multi-file plans must not fail on sibling content).
		const section = referent.projectionSection ?? plan.projection;
		if (referent.shownText.length > 0 && plan.projection.includes(referent.shownText)) {
			continue;
		}
		if (referent.shownText.length === 0) {
			continue;
		}
		if (referent.diskText === null) {
			unchecked += 1;
			continue;
		}
		if (!referent.diskText.includes(referent.shownText) && projectionCoversDisk(section, referent.diskText)) {
			continue;
		}
		missingReferents.push(referent.resultId);
	}
	if (missingReferents.length > 0) {
		return { outcome: "WRONG", missingReferents };
	}
	if (judged === 0 || plan.omitted.length > 0) {
		return { outcome: "INVALIDATED", missingReferents };
	}
	if (unchecked === judged) {
		return { outcome: "UNCHECKED", missingReferents };
	}
	return { outcome: "STABLE", missingReferents };
}

/**
 * Split a multi-file projection into per-path sections. Headers render as
 * `path:bytes` (file) or `path:kind:bytes` (region/symbol) envelope lines;
 * the section for a path is the text between its header and the next header
 * (or end). Unknown shapes yield an empty map (callers fall back to the
 * whole projection).
 */
export function splitProjectionSections(projection: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = projection.split("\n");
	let current: string | null = null;
	let start = 0;
	const flush = (end: number) => {
		if (current !== null) {
			sections.set(current, lines.slice(start, end).join("\n"));
		}
	};
	for (let i = 0; i < lines.length; i++) {
		// Engine envelope: `path:bytes` or `path:kind:bytes` where kind is
		// file|symbol|region. Paths may contain colons, so anchor on the
		// trailing :bytes / :kind:bytes suffix and strip the kind.
		const fileMatch = /^(.+):(?:(?:file|symbol|region):)?\d+$/.exec(lines[i]);
		if (fileMatch) {
			flush(i);
			current = fileMatch[1].replace(/:(?:file|symbol|region)$/, "");
			start = i + 1;
		}
	}
	flush(lines.length);
	return sections;
}

/**
 * True when every non-empty projected body line appears in the current disk
 * text: the projection renders current bytes (refresh), not stale ones.
 * Engine envelope headers (`path:bytes`, `path:kind:bytes`) are skipped along
 * with blank lines.
 */
function projectionCoversDisk(projection: string, diskText: string): boolean {
	const lines = projection.split("\n");
	let bodyLines = 0;
	for (const line of lines) {
		if (/^(.+):(?:(?:file|symbol|region):)?\d+$/.test(line)) {
			continue;
		}
		if (line.length === 0) {
			continue;
		}
		bodyLines += 1;
		if (!diskText.includes(line)) {
			return false;
		}
	}
	return bodyLines > 0;
}

export class FreshCtxRequestPreparer {
	private readonly observed = new Set<string>();
	private readonly runtime: FreshCtxClient;
	private readonly budgetBytes: number;
	private readonly selectionGranularity: FreshCtxSelectionGranularity;
	private readonly maxRequestBytes: number | undefined;
	private readonly maxRequestTokens: number | undefined;
	private readonly reservedOutputTokens: number;
	private readonly readDiskText: ((absolutePath: string) => string | null) | undefined;
	private resolvedBuffer: FreshCtxResolvedUnit[] = [];
	private lastPlan: ValidatedPlan | null = null;
	private lastVerdict: FreshCtxRevalidationVerdict | null = null;
	private readonly revalidationCounts = {
		total: 0,
		stable: 0,
		relocated: 0,
		updated: 0,
		ambiguous: 0,
		invalidated: 0,
		unchecked: 0,
		driftBlocked: 0,
	};

	constructor(runtime: FreshCtxClient, settings?: FreshCtxPrepareSettings) {
		this.runtime = runtime;
		this.budgetBytes = settings?.budgetBytes ?? FRESHCTX_DEFAULT_BUDGET_BYTES;
		this.selectionGranularity = settings?.selectionGranularity ?? "region";
		this.readDiskText = settings?.readDiskText;
		this.maxRequestBytes = settings?.maxRequestBytes;
		this.maxRequestTokens = settings?.maxRequestTokens;
		this.reservedOutputTokens = settings?.reservedOutputTokens ?? 0;
	}

	/**
	 * Prepare a temporary outgoing-context copy. Returns the replacement
	 * payload on success; throws FreshCtxBlockedError (zero HTTP sent) on
	 * any verification, budget, or commit failure.
	 */
	async prepare(payload: unknown, observations: FreshCtxReadObservation[], signal?: AbortSignal): Promise<unknown> {
		const { toolById, allIds } = collectToolMessages(payload);
		const verified = this.verifyObservations(toolById, observations);
		if (verified.length === 0) {
			// Nothing tracked in this request: vacuous pass, payload untouched.
			return payload;
		}
		const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");
		const budget = Math.max(0, this.budgetBytes - payloadBytes);
		if (budget <= 0) {
			throw new FreshCtxBlockedError("budget-exhausted", "no projection budget remains for this request");
		}
		await this.observeAll(verified, signal);
		try {
			return await this.prepareAndCommit(payload, verified, allIds, budget, false, signal);
		} catch (error) {
			if (error instanceof FreshCtxBlockedError && error.code === "commit-failed") {
				// Stale commit: prepare again once with a new attempt ID.
				return await this.prepareAndCommit(payload, verified, allIds, budget, true, signal);
			}
			throw error;
		}
	}

	private verifyObservations(
		toolById: Map<string, CompletionsToolMessage>,
		observations: FreshCtxReadObservation[],
	): VerifiedObservation[] {
		const verified: VerifiedObservation[] = [];
		for (const obs of observations) {
			if (obs.status !== "observed" && obs.status !== "truncated") {
				continue;
			}
			const tool = toolById.get(obs.obsId);
			if (!tool) {
				continue;
			}
			verified.push({ obs, shownText: reconstructShownText(tool.content, obs) });
		}
		return verified;
	}

	private async observeAll(verified: VerifiedObservation[], signal?: AbortSignal): Promise<void> {
		for (const { obs, shownText } of verified) {
			if (this.observed.has(obs.obsId)) {
				continue;
			}
			if (!obs.workspaceRelativePath) {
				// Outside the FreshCtx workspace: outside the freshness
				// guarantee (like shell output). Left historical below by
				// skipping observation; never presented as tracked.
				continue;
			}
			try {
				const response = await this.runtime.request(
					"observe",
					{
						result_id: obs.obsId,
						path: obs.workspaceRelativePath,
						content_utf8_base64: Buffer.from(shownText, "utf-8").toString("base64"),
						...(obs.endByte > obs.startByte
							? { range: { start_byte: obs.startByte, end_byte: obs.endByte } }
							: {}),
						turn: 0,
					},
					signal,
				);
				if (!isRecord(response) || typeof response.unit_id !== "string") {
					throw new Error("malformed observe response");
				}
				// Unit discovery happens here: the observed revision doubles
				// as the recover revision for whole-unit observations (the
				// server archives it); partial observations may fail recover
				// later with unknown_revision, reported honestly.
				this.resolvedBuffer.push({
					resultId: obs.obsId,
					unitId: response.unit_id,
					revision: revisionForText(shownText),
					path: obs.workspaceRelativePath,
				});
			} catch (error) {
				if (error instanceof FreshCtxBlockedError) {
					throw error;
				}
				throw new FreshCtxBlockedError("transport", `observe failed for ${obs.obsId}`, { cause: error });
			}
			this.observed.add(obs.obsId);
		}
	}

	private async prepareAndCommit(
		original: unknown,
		verified: VerifiedObservation[],
		allIds: string[],
		budget: number,
		isRetry: boolean,
		signal?: AbortSignal,
	): Promise<unknown> {
		const verifiedById = new Map(verified.map((entry) => [entry.obs.obsId, entry]));
		let plan: ValidatedPlan;
		try {
			const response = await this.runtime.request(
				"prepare",
				{
					request_id: randomUUID(),
					result_ids: allIds,
					budget_bytes: budget,
					...(this.selectionGranularity === "file" ? { selection_granularity: "file" as const } : {}),
				},
				signal,
			);
			plan = validatePlan(response, budget);
			if (plan.selectionGranularity !== this.selectionGranularity) {
				throw new FreshCtxBlockedError(
					"invalid-plan",
					`engine granularity ${plan.selectionGranularity} differs from requested ${this.selectionGranularity}`,
				);
			}
		} catch (error) {
			if (error instanceof FreshCtxBlockedError) {
				throw error;
			}
			throw new FreshCtxBlockedError("transport", `prepare failed${isRetry ? " on retry" : ""}`, { cause: error });
		}
		const markers = new Map<string, string>();
		const budgetOmitted = plan.omitted.filter((entry) => entry.reason === "budget");
		if (budgetOmitted.length > 0) {
			// The server could not fit tracked units: dispatching would send
			// dangling markers without their projected source. Block with
			// guidance to compact and retry instead of degrading silently.
			throw new FreshCtxBlockedError(
				"budget-exhausted",
				`server omitted ${budgetOmitted.length} unit(s) for budget; compact and prepare again`,
			);
		}
		for (const replacement of plan.replacements) {
			const entry = verifiedById.get(replacement.resultId);
			if (!entry) {
				// The server answered for a result we never verified (e.g.
				// shell output): keep it historical, never apply blindly.
				continue;
			}
			if (revisionForText(entry.shownText) !== replacement.expectedSha256) {
				throw new FreshCtxBlockedError(
					"unexpected-replacement",
					`server expectation differs for ${replacement.resultId}`,
				);
			}
			markers.set(replacement.resultId, replacement.marker);
		}
		const copy = structuredClone(original);
		if (!isRecord(copy) || !Array.isArray(copy.messages)) {
			throw new FreshCtxBlockedError("invalid-payload", "payload changed shape during preparation");
		}
		for (const message of copy.messages) {
			if (isRecord(message) && message.role === "tool" && typeof message.tool_call_id === "string") {
				const marker = markers.get(message.tool_call_id);
				if (marker !== undefined) {
					message.content = marker;
				}
			}
		}
		if (plan.projection) {
			(copy.messages as unknown[]).push({ role: "user", content: plan.projection });
		}
		// Re-validate pairing on the outgoing copy (no orphans introduced).
		collectToolMessages(copy);
		if (
			this.maxRequestBytes !== undefined &&
			Buffer.byteLength(JSON.stringify(copy), "utf-8") > this.maxRequestBytes
		) {
			throw new FreshCtxBlockedError("budget-exhausted", "prepared request exceeds size cap");
		}
		if (this.maxRequestTokens !== undefined) {
			const estimated = Math.ceil(Buffer.byteLength(JSON.stringify(copy), "utf-8") / 4);
			if (estimated + this.reservedOutputTokens > this.maxRequestTokens) {
				throw new FreshCtxBlockedError(
					"budget-exhausted",
					`prepared request estimates ~${estimated} tokens plus ${this.reservedOutputTokens} reserved over cap ${this.maxRequestTokens}; compact and retry`,
				);
			}
		}
		let committed: unknown;
		try {
			committed = await this.runtime.request("commit", { plan_id: plan.planId }, signal);
		} catch (error) {
			throw new FreshCtxBlockedError("commit-failed", "commit rejected (stale or failed)", { cause: error });
		}
		if (!isRecord(committed) || committed.applied !== true) {
			throw new FreshCtxBlockedError("commit-failed", "commit rejected (stale or failed)");
		}
		this.recordRevalidation(plan, verified);
		this.lastPlan = plan;
		return copy;
	}

	/**
	 * Independent Fresh-side revalidation after a successful commit. WRONG
	 * blocks dispatch with drift-blocked (zero HTTP). Engine-reported
	 * RELOCATED/UPDATED/AMBIGUOUS unit_states refine STABLE verdicts without
	 * weakening WRONG detection. Emits counts for benchmark export.
	 */
	private recordRevalidation(plan: ValidatedPlan, verified: VerifiedObservation[]): void {
		const sections = splitProjectionSections(plan.projection);
		const referents: FreshCtxReferent[] = verified.map(({ obs, shownText }) => {
			const relPath = obs.workspaceRelativePath ?? null;
			return {
				resultId: obs.obsId,
				shownText,
				diskText: this.readDiskText ? this.readDiskText(obs.absolutePath) : null,
				projectionSection: relPath ? (sections.get(relPath) ?? null) : null,
			};
		});
		const verdict = classifyRevalidation(plan, referents);
		// Refine with engine-reported statuses: a Fresh-STABLE plan whose
		// units all report relocated/updated is genuinely relocated/updated;
		// any ambiguous unit makes the verdict ambiguous. WRONG is never
		// refined away.
		let outcome = verdict.outcome;
		if (outcome === "STABLE" && Object.keys(plan.unitStates).length > 0) {
			const statuses = new Set(Object.values(plan.unitStates).map((entry) => entry.status));
			if (statuses.has("ambiguous")) {
				outcome = "AMBIGUOUS";
			} else if (statuses.size === 1 && statuses.has("relocated")) {
				outcome = "RELOCATED";
			} else if (statuses.size === 1 && statuses.has("updated")) {
				outcome = "UPDATED";
			} else if (statuses.has("relocated") || statuses.has("updated")) {
				outcome = "UPDATED";
			}
		}
		const refined: FreshCtxRevalidationVerdict = { outcome, missingReferents: verdict.missingReferents };
		this.lastVerdict = refined;
		this.revalidationCounts.total += 1;
		if (outcome === "WRONG") {
			this.revalidationCounts.driftBlocked += 1;
			throw new FreshCtxBlockedError(
				"drift-blocked",
				`FreshCtx region drift blocked for ${verdict.missingReferents.join(", ")}: engine claimed success but the projection no longer carries the observed referent`,
			);
		}
		if (outcome === "STABLE") {
			this.revalidationCounts.stable += 1;
		} else if (outcome === "RELOCATED") {
			this.revalidationCounts.relocated += 1;
		} else if (outcome === "UPDATED") {
			this.revalidationCounts.updated += 1;
		} else if (outcome === "AMBIGUOUS") {
			this.revalidationCounts.ambiguous += 1;
		} else if (outcome === "INVALIDATED") {
			this.revalidationCounts.invalidated += 1;
		} else if (outcome === "UNCHECKED") {
			this.revalidationCounts.unchecked += 1;
		}
	}

	/** Most recent revalidation verdict, if any preparation committed. */
	lastRevalidation(): FreshCtxRevalidationVerdict | null {
		return this.lastVerdict;
	}

	/** Cumulative revalidation counters for observatory/benchmark export. */
	revalidationStats(): {
		total: number;
		stable: number;
		relocated: number;
		updated: number;
		ambiguous: number;
		invalidated: number;
		unchecked: number;
		driftBlocked: number;
	} {
		return { ...this.revalidationCounts };
	}

	/** Most recent committed plan, if any. Cleared only when the preparer is replaced. */
	lastCommittedPlan(): ValidatedPlan | null {
		return this.lastPlan;
	}

	/**
	 * Units resolved by recent successful preparations (for discovery +
	 * persistence). Returns and clears the buffer, deduplicated.
	 */
	drainResolvedUnits(): FreshCtxResolvedUnit[] {
		const seen = new Set<string>();
		const units: FreshCtxResolvedUnit[] = [];
		for (const unit of this.resolvedBuffer) {
			const key = `${unit.unitId}\n${unit.revision}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			units.push(unit);
		}
		this.resolvedBuffer = [];
		return units;
	}
}

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../session-manager.ts";
import { type FreshCtxReadObservation, isFreshCtxReadObservation } from "./observations.ts";

/**
 * Compaction input view + retained references (Phase E).
 *
 * The summarizer must never see tracked raw source: bodies are replaced
 * structurally (not by prompt plea) with small reference tokens before
 * serialization. The summary therefore references files instead of quoting
 * code, and the next preparation cannot resurrect old tracked bodies.
 *
 * Retained observations (whose entries fall before the compaction cut) are
 * kept as code-free reference metadata, bounded deterministically. The model
 * re-reads a retained file when it needs current source; the re-read creates
 * a fresh observation through the normal flow.
 */

export const FRESHCTX_REFS_CUSTOM_TYPE = "freshctx_refs";
export const FRESHCTX_RETAINED_BOUND = 8;

/** Deterministic, exactly-reproducible reference token for an observation. */
export function referenceTokenFor(obs: FreshCtxReadObservation): string {
	const path = obs.workspaceRelativePath ?? obs.absolutePath;
	return `[freshctx:ref obsId=${obs.obsId} path=${path} bytes=${obs.startByte}-${obs.endByte} sha256=${obs.shownSha256}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function trackedObsOf(message: AgentMessage): FreshCtxReadObservation | null {
	if (message.role !== "toolResult") {
		return null;
	}
	const details: unknown = (message as { details?: unknown }).details;
	if (!isRecord(details) || !isFreshCtxReadObservation(details.freshctxObs)) {
		return null;
	}
	const obs = details.freshctxObs;
	return obs.status === "observed" || obs.status === "truncated" ? obs : null;
}

export interface StrippedView {
	messages: AgentMessage[];
	strippedIds: string[];
}

/**
 * Replace tracked raw source in tool results with reference tokens.
 * Untracked, unsupported, image, and non-tool messages pass through
 * untouched. Never mutates the input.
 */
export function stripTrackedBodies(messages: AgentMessage[]): StrippedView {
	const strippedIds: string[] = [];
	const stripped = messages.map((message) => {
		const obs = trackedObsOf(message);
		const content: unknown = (message as { content?: unknown }).content;
		if (!obs || !Array.isArray(content)) {
			return message;
		}
		strippedIds.push(obs.obsId);
		const token = { type: "text" as const, text: referenceTokenFor(obs) };
		const kept: unknown[] = [];
		let replaced = false;
		for (const block of content) {
			if (isRecord(block) && block.type === "text") {
				if (!replaced) {
					kept.push(token);
					replaced = true;
				}
				continue;
			}
			kept.push(block);
		}
		return {
			...message,
			content: replaced ? kept : [token],
		} as unknown as AgentMessage;
	});
	return { messages: stripped, strippedIds };
}

export interface FreshCtxRef {
	obsId: string;
	path: string;
	startByte: number;
	endByte: number;
	shownSha256: string;
	status: string;
}

export interface RetainedRefsMessage {
	content: string;
	details: { refs: FreshCtxRef[] };
}

/**
 * Build the code-free retained-references message for entries dropped by
 * compaction (those before firstKeptEntryId). Newest-first bound; null when
 * nothing tracked was dropped.
 */
export function buildRetainedRefsMessage(
	branch: SessionEntry[],
	firstKeptEntryId: string,
	bound: number = FRESHCTX_RETAINED_BOUND,
): RetainedRefsMessage | null {
	const cutIndex = branch.findIndex((entry) => entry.id === firstKeptEntryId);
	if (cutIndex < 0) {
		return null;
	}
	const seen = new Set<string>();
	const refs: FreshCtxRef[] = [];
	for (const entry of branch.slice(0, cutIndex)) {
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message as AgentMessage & { toolCallId?: string };
		const obs = trackedObsOf(message);
		if (!obs || seen.has(obs.obsId)) {
			continue;
		}
		seen.add(obs.obsId);
		refs.push({
			obsId: obs.obsId,
			path: obs.workspaceRelativePath ?? obs.absolutePath,
			startByte: obs.startByte,
			endByte: obs.endByte,
			shownSha256: obs.shownSha256,
			status: obs.status,
		});
	}
	const kept = refs.slice(-bound);
	if (kept.length === 0) {
		return null;
	}
	const lines = ["[FreshCtx retained references — read a file again for current source; these are not code:]"];
	for (const ref of kept) {
		lines.push(`- ${ref.path} (bytes ${ref.startByte}-${ref.endByte})`);
	}
	return { content: lines.join("\n"), details: { refs: kept } };
}

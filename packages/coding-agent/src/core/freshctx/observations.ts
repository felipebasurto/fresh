import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

/**
 * Exact read observations for native FreshCtx integration (Phase B).
 *
 * An observation links a tool result to the exact source bytes that were
 * shown: the full-file hash detects later changes, and the byte range
 * identifies the shown portion without re-reading the file. Hashes always
 * refer to raw source bytes, never to decorated output (continuation
 * notices are appended outside the hashed portion by the read tool).
 *
 * Observations are persisted as `custom` session entries (which never enter
 * LLM context) and are consumed by FreshCtx request preparation (Phase C).
 * Line numbers are display metadata only; never derive byte offsets from them.
 */

export const FRESHCTX_OBSERVATION_VERSION = 1;
export const FRESHCTX_OBSERVATION_CUSTOM_TYPE = "freshctx_obs";
/** FreshCtx workspace rule: files larger than this are not tracked. */
export const FRESHCTX_MAX_TRACKED_BYTES = 512 * 1024;

export type FreshCtxObservationStatus = "observed" | "truncated" | "unsupported" | "error";
export type FreshCtxTruncatedBy = "lines" | "bytes" | "user-limit" | null;

/** Structural guard for persisted entries (malformed entries are skipped, never trusted). */
export function isFreshCtxReadObservation(data: unknown): data is FreshCtxReadObservation {
	if (typeof data !== "object" || data === null) {
		return false;
	}
	const record = data as Record<string, unknown>;
	return (
		typeof record.version === "number" &&
		record.toolName === "read" &&
		typeof record.obsId === "string" &&
		typeof record.absolutePath === "string" &&
		(typeof record.workspaceRelativePath === "string" || record.workspaceRelativePath === null) &&
		typeof record.contentSha256 === "string" &&
		typeof record.fileBytes === "number" &&
		typeof record.startByte === "number" &&
		typeof record.endByte === "number" &&
		typeof record.startLine === "number" &&
		typeof record.endLine === "number" &&
		typeof record.totalLines === "number" &&
		typeof record.shownSha256 === "string" &&
		(record.status === "observed" ||
			record.status === "truncated" ||
			record.status === "unsupported" ||
			record.status === "error") &&
		(record.truncatedBy === null ||
			record.truncatedBy === "lines" ||
			record.truncatedBy === "bytes" ||
			record.truncatedBy === "user-limit") &&
		(record.reason === null || typeof record.reason === "string") &&
		(record.symlink === null || typeof record.symlink === "boolean") &&
		typeof record.timestamp === "string"
	);
}

export interface FreshCtxReadObservation {
	/** Schema version for persisted entries. */
	version: number;
	/** Stable identity: the tool call id, scoped to the session lineage. */
	obsId: string;
	toolName: "read";
	/** Resolved absolute path that was actually read. */
	absolutePath: string;
	/** Path relative to the workspace cwd, or null when outside the workspace. */
	workspaceRelativePath: string | null;
	/** SHA-256 of the complete raw file buffer (change detection). */
	contentSha256: string;
	/** Raw file size in bytes. */
	fileBytes: number;
	/** Byte offset of the shown portion within the source file. */
	startByte: number;
	/** Byte offset of the end of the shown portion (startByte + shown bytes). */
	endByte: number;
	/** 1-indexed first shown line (display metadata only). */
	startLine: number;
	/** 1-indexed last shown line, inclusive (display metadata only). */
	endLine: number;
	/** Total lines in the source file as split by the read tool. */
	totalLines: number;
	/** SHA-256 of the shown source slice (buffer[startByte:endByte)). */
	shownSha256: string;
	status: FreshCtxObservationStatus;
	truncatedBy: FreshCtxTruncatedBy;
	reason: string | null;
	/** Symlink probe result: true/false when known, null when undeterminable. */
	symlink: boolean | null;
	timestamp: string;
}

export function sha256Hex(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Check that a buffer is valid UTF-8 by round-tripping the decode.
 * Invalid sequences decode to U+FFFD, which re-encodes to different bytes.
 */
export function isValidUtf8(buffer: Buffer): boolean {
	return Buffer.from(buffer.toString("utf-8"), "utf-8").equals(buffer);
}

/** Workspace-relative path, or null when the file is outside the workspace. */
export function toWorkspaceRelativePath(absolutePath: string, cwd: string): string | null {
	const resolvedCwd = resolve(cwd);
	const resolvedPath = resolve(absolutePath);
	if (resolvedPath === resolvedCwd) {
		return null;
	}
	if (!resolvedPath.startsWith(resolvedCwd + sep)) {
		return null;
	}
	return relative(resolvedCwd, resolvedPath);
}

/**
 * Best-effort symlink probe. Returns null when the check cannot run
 * (for example remote/custom read operations), never throws.
 */
export async function detectLocalSymlink(absolutePath: string): Promise<boolean | null> {
	try {
		const stats = await lstat(absolutePath);
		return stats.isSymbolicLink();
	} catch {
		return null;
	}
}

/** Byte offset of the start of a 0-indexed line within the split lines. */
export function lineStartByte(lines: string[], startLine: number): number {
	let bytes = 0;
	for (let i = 0; i < startLine; i++) {
		bytes += Buffer.byteLength(lines[i], "utf-8") + 1; // +1 for the "\n" removed by split
	}
	return bytes;
}

/** Byte range of `shownLineCount` consecutive lines starting at `startLine`. */
export function shownByteRange(
	lines: string[],
	startLine: number,
	shownLineCount: number,
): { startByte: number; endByte: number } {
	const startByte = lineStartByte(lines, startLine);
	let shownBytes = 0;
	for (let i = 0; i < shownLineCount; i++) {
		shownBytes += Buffer.byteLength(lines[startLine + i], "utf-8") + (i > 0 ? 1 : 0);
	}
	return { startByte, endByte: startByte + shownBytes };
}

export interface TextReadObservationInput {
	obsId: string;
	absolutePath: string;
	cwd: string;
	buffer: Buffer;
	/** Source text split on "\n", exactly as the read tool splits it. */
	allLines: string[];
	/** 0-indexed first selected line. */
	startLine: number;
	/** Number of selected lines actually shown (before notices). */
	shownLineCount: number;
	totalFileLines: number;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	/** True when a user-specified limit stopped early with content remaining. */
	userLimited: boolean;
	/** True when the first line alone exceeded the byte limit (nothing shown). */
	firstLineExceedsLimit: boolean;
	symlink: boolean | null;
	timestamp?: string;
}

/** Build an observation from the same buffer used to produce the read result. */
export function buildTextReadObservation(input: TextReadObservationInput): FreshCtxReadObservation {
	const { startByte, endByte } = shownByteRange(input.allLines, input.startLine, input.shownLineCount);
	let status: FreshCtxObservationStatus = input.truncated || input.userLimited ? "truncated" : "observed";
	let truncatedBy: FreshCtxTruncatedBy = input.truncatedBy ?? (input.userLimited ? "user-limit" : null);
	let reason: string | null = null;
	if (input.firstLineExceedsLimit) {
		status = "unsupported";
		truncatedBy = "bytes";
		reason = "first-line-exceeds-limit";
	} else if (input.buffer.length > FRESHCTX_MAX_TRACKED_BYTES) {
		status = "unsupported";
		reason = "file-too-large";
	} else if (!isValidUtf8(input.buffer)) {
		status = "unsupported";
		reason = "non-utf8";
	}
	return {
		version: FRESHCTX_OBSERVATION_VERSION,
		obsId: input.obsId,
		toolName: "read",
		absolutePath: input.absolutePath,
		workspaceRelativePath: toWorkspaceRelativePath(input.absolutePath, input.cwd),
		contentSha256: sha256Hex(input.buffer),
		fileBytes: input.buffer.length,
		startByte,
		endByte,
		shownSha256: sha256Hex(input.buffer.slice(startByte, endByte)),
		startLine: input.startLine + 1,
		endLine: input.startLine + input.shownLineCount,
		totalLines: input.totalFileLines,
		status,
		truncatedBy,
		reason,
		symlink: input.symlink,
		timestamp: input.timestamp ?? new Date().toISOString(),
	};
}

export interface ImageReadObservationInput {
	obsId: string;
	absolutePath: string;
	cwd: string;
	buffer: Buffer;
	mimeType: string;
	symlink: boolean | null;
	timestamp?: string;
}

/** Image reads are never tracked source; the hash still supports change detection. */
export function buildImageReadObservation(input: ImageReadObservationInput): FreshCtxReadObservation {
	return {
		version: FRESHCTX_OBSERVATION_VERSION,
		obsId: input.obsId,
		toolName: "read",
		absolutePath: input.absolutePath,
		workspaceRelativePath: toWorkspaceRelativePath(input.absolutePath, input.cwd),
		contentSha256: sha256Hex(input.buffer),
		fileBytes: input.buffer.length,
		startByte: 0,
		endByte: 0,
		shownSha256: sha256Hex(Buffer.alloc(0)),
		startLine: 0,
		endLine: 0,
		totalLines: 0,
		status: "unsupported",
		truncatedBy: null,
		reason: `image:${input.mimeType}`,
		symlink: input.symlink,
		timestamp: input.timestamp ?? new Date().toISOString(),
	};
}

import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface SessionRow {
	rowid: number;
	created_at: number;
	parent_session_id: string | null;
	storage_version: number;
	metadata: string | null;
	message_count: number;
	usage_payload: string;
	next_seq: number;
}

export interface SqliteSessionMetadata extends SessionMetadata {
	path: string;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function readSingleSessionRow(db: SqliteDatabase): SessionRow {
	const rows = sql`SELECT rowid, created_at, parent_session_id, storage_version, metadata,
			message_count, usage_payload, next_seq
		FROM session`.all<SessionRow>(db);
	if (rows.length !== 1) throw new Error(`Expected exactly one session row, found ${rows.length}`);
	return rows[0]!;
}

export function readSessionRowCount(db: SqliteDatabase): number {
	return sql`SELECT rowid FROM session`.all<{ rowid: number }>(db).length;
}

export function metadataFromSessionRow(
	path: string,
	id: string,
	row: SessionRow,
	currentStorageVersion: number,
): SqliteSessionMetadata {
	if (row.storage_version > currentStorageVersion) {
		throw new Error(`SQLite session storage version ${row.storage_version} is newer than ${currentStorageVersion}`);
	}
	if (row.storage_version < currentStorageVersion) {
		throw new Error(`SQLite session storage version ${row.storage_version} requires migrations`);
	}
	return {
		id,
		createdAt: row.created_at,
		storageVersion: row.storage_version,
		...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
		path,
	};
}

export function insertSessionRow(
	db: SqliteDatabase,
	metadata: SqliteSessionMetadata,
	storageVersion: number,
	nextSeq: number,
): void {
	sql`INSERT INTO session
			(created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
		VALUES (
			${metadata.createdAt},
			${metadata.parentSessionId ?? null},
			${storageVersion},
			${null},
			${0},
			${JSON.stringify(zeroUsage())},
			${nextSeq}
		)`.run(db);
}

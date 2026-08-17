import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface WriterLeaseRow {
	rowid: number;
	owner_id: string;
	fence: number;
	expires_at_ms: number;
}

export function readWriterLease(db: SqliteDatabase): WriterLeaseRow | undefined {
	const rows = sql`SELECT rowid, owner_id, fence, expires_at_ms FROM writer_lease`.all<WriterLeaseRow>(db);
	if (rows.length > 1) throw new Error(`Expected at most one writer lease row, found ${rows.length}`);
	return rows[0];
}

export function claimWriterLease(db: SqliteDatabase, ownerId: string, now: number, leaseMs: number): WriterLeaseRow {
	const expiresAt = now + leaseMs;
	const current = readWriterLease(db);
	if (current === undefined) {
		sql`INSERT INTO writer_lease (owner_id, fence, expires_at_ms) VALUES (${ownerId}, ${1}, ${expiresAt})`.run(db);
		return { rowid: 1, owner_id: ownerId, fence: 1, expires_at_ms: expiresAt };
	}
	if (current.owner_id !== ownerId && current.expires_at_ms > now) {
		throw new Error(`SQLite session is already claimed by writer ${current.owner_id}`);
	}
	const fence = current.owner_id === ownerId ? current.fence : current.fence + 1;
	sql`UPDATE writer_lease SET owner_id = ${ownerId}, fence = ${fence}, expires_at_ms = ${expiresAt}
		WHERE rowid = ${current.rowid}`.run(db);
	return { rowid: current.rowid, owner_id: ownerId, fence, expires_at_ms: expiresAt };
}

export function renewWriterLease(
	db: SqliteDatabase,
	ownerId: string,
	fence: number,
	now: number,
	leaseMs: number,
): WriterLeaseRow {
	const expiresAt = now + leaseMs;
	const result = sql`UPDATE writer_lease SET expires_at_ms = ${expiresAt}
		WHERE owner_id = ${ownerId} AND fence = ${fence}`.run(db);
	if (result.changes !== 1) throw new Error("SQLite writer lease was lost");
	const row = sql`SELECT rowid, owner_id, fence, expires_at_ms FROM writer_lease
		WHERE owner_id = ${ownerId} AND fence = ${fence}`.get<WriterLeaseRow>(db);
	if (row === undefined) throw new Error("SQLite writer lease was lost");
	return row;
}

export function releaseWriterLease(db: SqliteDatabase, ownerId: string, fence: number): void {
	sql`DELETE FROM writer_lease WHERE owner_id = ${ownerId} AND fence = ${fence}`.run(db);
}

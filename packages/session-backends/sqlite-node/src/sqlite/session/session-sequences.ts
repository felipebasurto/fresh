import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export function readNextSeq(db: SqliteDatabase): number {
	const rows = sql`SELECT next_seq FROM session`.all<{ next_seq: number }>(db);
	if (rows.length !== 1) throw new Error(`Expected exactly one session row, found ${rows.length}`);
	return rows[0]!.next_seq;
}

export function advanceNextSeq(db: SqliteDatabase, nextSeq: number): void {
	const result = sql`UPDATE session SET next_seq = ${nextSeq}`.run(db);
	if (result.changes !== 1) throw new Error(`Expected to update exactly one session row, updated ${result.changes}`);
}

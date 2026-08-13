import type { UsageRow, UsageScan } from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export interface UsageLedgerRow {
	id: string;
	seq: number;
	entry_id: string | null;
	adjustment: number;
	usage: string;
	details: string | null;
}

export function insertUsageLedgerRow(db: SqliteDatabase, row: UsageRow): void {
	sql`INSERT INTO usage_ledger (id, seq, entry_id, adjustment, usage, details)
		VALUES (
			${row.id},
			${row.seq},
			${row.entryId ?? null},
			${row.adjustment ? 1 : 0},
			${JSON.stringify(row.usage)},
			${row.details === undefined ? null : JSON.stringify(row.details)}
		)`.run(db);
}

export function decodeUsageLedgerRow(row: UsageLedgerRow): UsageRow {
	return {
		id: row.id,
		seq: row.seq,
		usage: JSON.parse(row.usage) as UsageRow["usage"],
		...(row.entry_id === null ? {} : { entryId: row.entry_id }),
		adjustment: row.adjustment !== 0,
		...(row.details === null ? {} : { details: JSON.parse(row.details) as UsageRow["details"] }),
	};
}

export function scanUsageLedgerRows(db: SqliteDatabase, query: UsageScan): UsageLedgerRow[] {
	const filters: SqlQuery[] = [];
	if (query.fromSeq !== undefined) filters.push(sql`seq >= ${query.fromSeq}`);
	if (query.toSeq !== undefined) filters.push(sql`seq <= ${query.toSeq}`);

	const where = filters.length === 0 ? sql`` : sql`WHERE ${joinSqlFragments(filters, " AND ")}`;
	const order = query.order === "desc" ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`;
	const limit = query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`;
	return sql`SELECT id, seq, entry_id, adjustment, usage, details
		FROM usage_ledger ${where} ${order} ${limit}`.all<UsageLedgerRow>(db);
}

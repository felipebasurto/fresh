import type { UsageRow } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
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

import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	Entry,
	EntryScan,
	EntryStructure,
	MessageEntry,
} from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase, SqliteStatement } from "../types.ts";

export interface EntryRow {
	id: string;
	parent_id: string | null;
	seq: number;
	type: Entry["type"];
	custom_type: string | null;
	timestamp: number;
	payload: string;
}

type StoredEntryPayload<TEntry extends Entry> = Omit<
	TEntry,
	"id" | "parentId" | "seq" | "timestamp" | "type" | "customType"
>;

function entryPayload(entry: Entry): StoredEntryPayload<Entry> {
	switch (entry.type) {
		case "message": {
			const payload: StoredEntryPayload<MessageEntry> = {
				message: entry.message,
				...(entry.terminate === undefined ? {} : { terminate: entry.terminate }),
			};
			return payload;
		}
		case "compaction": {
			const payload: StoredEntryPayload<CompactionEntry> = {
				summary: entry.summary,
				retainedTail: entry.retainedTail,
				tokensBefore: entry.tokensBefore,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: entry.usage }),
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "branch_summary": {
			const payload: StoredEntryPayload<BranchSummaryEntry> = {
				fromId: entry.fromId,
				summary: entry.summary,
				...(entry.details === undefined ? {} : { details: entry.details }),
				...(entry.usage === undefined ? {} : { usage: entry.usage }),
				fromHook: entry.fromHook,
			};
			return payload;
		}
		case "custom": {
			const payload: StoredEntryPayload<CustomEntry> = entry.data === undefined ? {} : { data: entry.data };
			return payload;
		}
	}
}

function parsePayload<TEntry extends Entry>(row: EntryRow): StoredEntryPayload<TEntry> {
	return JSON.parse(row.payload) as StoredEntryPayload<TEntry>;
}

const INSERT_ENTRY_SQL = `INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
	VALUES (?, ?, ?, ?, ?, ?, ?)`;

function entryRowParams(entry: Entry): unknown[] {
	return [
		entry.id,
		entry.parentId,
		entry.seq,
		entry.type,
		entry.type === "custom" ? entry.customType : null,
		entry.timestamp,
		JSON.stringify(entryPayload(entry)),
	];
}

export class EntryRowWriter {
	private readonly insertStatement: SqliteStatement;

	constructor(db: SqliteDatabase) {
		this.insertStatement = db.prepare(INSERT_ENTRY_SQL);
	}

	insert(entry: Entry): void {
		this.insertStatement.run(...entryRowParams(entry));
	}
}

export function insertEntryRow(db: SqliteDatabase, entry: Entry): void {
	db.prepare(INSERT_ENTRY_SQL).run(...entryRowParams(entry));
}

export function decodeEntryRow(row: EntryRow): Entry {
	const base = {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
	};
	switch (row.type) {
		case "message":
			return { ...base, type: "message", ...parsePayload<MessageEntry>(row) };
		case "compaction":
			return { ...base, type: "compaction", ...parsePayload<CompactionEntry>(row) };
		case "branch_summary":
			return { ...base, type: "branch_summary", ...parsePayload<BranchSummaryEntry>(row) };
		case "custom":
			if (row.custom_type === null) throw new Error(`Custom entry ${row.id} is missing custom_type`);
			return { ...base, type: "custom", customType: row.custom_type, ...parsePayload<CustomEntry>(row) };
	}
}

export function entryStructureFromRow(row: EntryRow): EntryStructure {
	return {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
	};
}

export function readEntryRows(db: SqliteDatabase, ids: readonly string[]): EntryRow[] {
	if (ids.length === 0) return [];
	const placeholders = joinSqlFragments(
		ids.map((id) => sql`${id}`),
		", ",
	);
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries
		WHERE id IN (${placeholders})`.all<EntryRow>(db);
}

export function readAllEntryRows(db: SqliteDatabase): EntryRow[] {
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries ORDER BY seq ASC`.all<EntryRow>(db);
}

export function scanEntryRows(db: SqliteDatabase, query: EntryScan): EntryRow[] {
	const filters: SqlQuery[] = [];
	if (query.type !== undefined) filters.push(sql`type = ${query.type}`);
	if (query.customType !== undefined) filters.push(sql`custom_type = ${query.customType}`);
	if (query.fromSeq !== undefined) filters.push(sql`seq >= ${query.fromSeq}`);
	if (query.toSeq !== undefined) filters.push(sql`seq <= ${query.toSeq}`);

	const where = filters.length === 0 ? sql`` : sql`WHERE ${joinSqlFragments(filters, " AND ")}`;
	const order = query.order === "desc" ? sql`ORDER BY seq DESC` : sql`ORDER BY seq ASC`;
	const limit = query.limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, query.limit)}`;
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries ${where} ${order} ${limit}`.all<EntryRow>(db);
}

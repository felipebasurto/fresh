import type { Entry, EntryStructure, StorageBranchScan } from "@earendil-works/pi-agent-core";
import { joinSqlFragments, type SqlQuery, sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
import { decodeEntryRow, type EntryRow } from "./entries.ts";

interface BranchMembershipRow {
	branch_id: string;
	entry_seq: number;
}

interface BranchMetaRow {
	branch_id: string;
	tip_entry_id: string;
	tip_seq: number;
	base_branch_id: string | null;
	base_seq: number | null;
}

interface BranchSegment {
	branchId: string;
	lowerSeq: number;
	upperSeq: number;
}

interface StopSeqRow {
	stop_seq: number | null;
}

interface EntryStructureRow {
	id: string;
	parent_id: string | null;
	seq: number;
	type: Entry["type"];
	custom_type: string | null;
	timestamp: number;
}

function readBranchMembership(db: SqliteDatabase, entryId: string): BranchMembershipRow {
	const row = sql`SELECT b.branch_id, b.entry_seq
		FROM branch_entries b
		JOIN branch_meta m ON m.branch_id = b.branch_id
		WHERE b.entry_id = ${entryId}
			AND ((m.base_seq IS NULL AND b.entry_seq > 0) OR (m.base_seq IS NOT NULL AND b.entry_seq > m.base_seq))
			AND b.entry_seq <= m.tip_seq
		ORDER BY m.tip_seq DESC, b.branch_id
		LIMIT 1`.get<BranchMembershipRow>(db);
	if (row === undefined) throw new Error(`Branch cache missing entry ${entryId}`);
	return row;
}

function readBranchMeta(db: SqliteDatabase, branchId: string): BranchMetaRow {
	const row = sql`SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq
		FROM branch_meta
		WHERE branch_id = ${branchId}`.get<BranchMetaRow>(db);
	if (row === undefined) throw new Error(`Branch metadata missing for branch ${branchId}`);
	return row;
}

function readBranchSegmentsNewestFirst(db: SqliteDatabase, start: string): BranchSegment[] {
	let { branch_id: branchId, entry_seq: upperSeq } = readBranchMembership(db, start);
	const segments: BranchSegment[] = [];
	while (true) {
		const meta = readBranchMeta(db, branchId);
		const lowerSeq = meta.base_seq ?? 0;
		segments.push({ branchId, lowerSeq, upperSeq });
		if (meta.base_branch_id === null) break;
		if (meta.base_seq === null) throw new Error(`Branch ${branchId} has base branch without base_seq`);
		branchId = meta.base_branch_id;
		upperSeq = meta.base_seq;
	}
	return segments;
}

function stopPredicates(query: StorageBranchScan): SqlQuery[] {
	const predicates: SqlQuery[] = [];
	if (query.stopAtType !== undefined) predicates.push(sql`b.entry_type = ${query.stopAtType}`);
	if (query.stopAtId !== undefined) predicates.push(sql`b.entry_id = ${query.stopAtId}`);
	return predicates;
}

function readStopSeq(
	db: SqliteDatabase,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
): number | undefined {
	const stop = stopPredicates(query);
	if (stop.length === 0) return undefined;
	const aggregate = oldestFirst ? sql`MIN(b.entry_seq)` : sql`MAX(b.entry_seq)`;
	const row = sql`SELECT ${aggregate} AS stop_seq
		FROM branch_entries b
		WHERE b.branch_id = ${segment.branchId}
			AND b.entry_seq > ${segment.lowerSeq}
			AND b.entry_seq <= ${segment.upperSeq}
			AND (${joinSqlFragments(stop, " OR ")})`.get<StopSeqRow>(db);
	return row?.stop_seq ?? undefined;
}

function branchScanPredicates(
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
): SqlQuery[] {
	const predicates: SqlQuery[] = [
		sql`b.branch_id = ${segment.branchId}`,
		sql`b.entry_seq > ${segment.lowerSeq}`,
		sql`b.entry_seq <= ${segment.upperSeq}`,
	];
	if (stopSeq !== undefined)
		predicates.push(oldestFirst ? sql`b.entry_seq <= ${stopSeq}` : sql`b.entry_seq >= ${stopSeq}`);
	if (query.type !== undefined) predicates.push(sql`b.entry_type = ${query.type}`);
	if (query.customType !== undefined) predicates.push(sql`e.custom_type = ${query.customType}`);
	if (query.cursor !== undefined) {
		predicates.push(oldestFirst ? sql`b.entry_seq > ${query.cursor.seq}` : sql`b.entry_seq < ${query.cursor.seq}`);
	}
	return predicates;
}

function limitSql(limit: number | undefined): SqlQuery {
	return limit === undefined ? sql`` : sql`LIMIT ${Math.max(0, limit)}`;
}

function scanEntrySegmentRows(
	db: SqliteDatabase,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
	limit: number | undefined,
): EntryRow[] {
	const predicates = branchScanPredicates(segment, query, oldestFirst, stopSeq);
	const order = oldestFirst ? sql`ASC` : sql`DESC`;
	return sql`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp, e.payload
		FROM branch_entries b
		CROSS JOIN entries e ON e.id = b.entry_id
		WHERE ${joinSqlFragments(predicates, " AND ")}
		ORDER BY b.entry_seq ${order} ${limitSql(limit)}`.all<EntryRow>(db);
}

function decodeEntryStructureRow(row: EntryStructureRow): EntryStructure {
	return {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
	};
}

function scanStructureSegmentRows(
	db: SqliteDatabase,
	segment: BranchSegment,
	query: StorageBranchScan,
	oldestFirst: boolean,
	stopSeq: number | undefined,
	limit: number | undefined,
): EntryStructure[] {
	const predicates = branchScanPredicates(segment, query, oldestFirst, stopSeq);
	const order = oldestFirst ? sql`ASC` : sql`DESC`;
	const rows = sql`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp
		FROM branch_entries b
		CROSS JOIN entries e ON e.id = b.entry_id
		WHERE ${joinSqlFragments(predicates, " AND ")}
		ORDER BY b.entry_seq ${order} ${limitSql(limit)}`.all<EntryStructureRow>(db);
	return rows.map(decodeEntryStructureRow);
}

function scanBranchSegments<T>(
	db: SqliteDatabase,
	query: StorageBranchScan,
	readSegment: (
		db: SqliteDatabase,
		segment: BranchSegment,
		query: StorageBranchScan,
		oldestFirst: boolean,
		stopSeq: number | undefined,
		limit: number | undefined,
	) => T[],
): T[] {
	const oldestFirst = query.order === "oldestFirst";
	const segmentsNewestFirst = readBranchSegmentsNewestFirst(db, query.start);
	const segments = oldestFirst ? [...segmentsNewestFirst].reverse() : segmentsNewestFirst;
	const limit = query.limit === undefined ? undefined : Math.max(0, query.limit);
	if (limit === 0) return [];

	const rows: T[] = [];
	for (const segment of segments) {
		const remaining = limit === undefined ? undefined : limit - rows.length;
		if (remaining !== undefined && remaining <= 0) break;
		const stopSeq = readStopSeq(db, segment, query, oldestFirst);
		rows.push(...readSegment(db, segment, query, oldestFirst, stopSeq, remaining));
		if (stopSeq !== undefined) break;
	}
	return rows;
}

export function scanBranchEntries(db: SqliteDatabase, query: StorageBranchScan): Entry[] {
	return scanBranchSegments(db, query, scanEntrySegmentRows).map(decodeEntryRow);
}

export function scanBranchEntryStructures(db: SqliteDatabase, query: StorageBranchScan): EntryStructure[] {
	return scanBranchSegments(db, query, scanStructureSegmentRows);
}

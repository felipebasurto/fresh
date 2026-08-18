import type {
	CommitResult,
	Context,
	Entry,
	EntryScan,
	EntryStructure,
	ForkOptions,
	ListElement,
	ListReadOptions,
	SessionStats,
	Storage,
	StorageBranchScan,
	StoredValue,
	UsageRow,
	UsageScan,
	Value,
	ValueList,
	Write,
} from "@earendil-works/pi-agent-core";
import { laneLeaf, prepareStorageCommit } from "@earendil-works/pi-agent-core";
import { appendEntryToBranchIndex, scanBranchEntries, scanBranchEntryStructures } from "./session/branch-entries.ts";
import { decodeEntryRow, EntryRowWriter, readAllEntryRows, readEntryRows, scanEntryRows } from "./session/entries.ts";
import { advanceNextSeq, readNextSeq } from "./session/session-sequences.ts";
import { addUsageToSessionStats, incrementMessageCount, readSessionStats } from "./session/session-stats.ts";
import { decodeUsageLedgerRow, scanUsageLedgerRows, UsageLedgerRowWriter } from "./session/usage-ledger.ts";
import {
	appendListValueRow,
	deleteListValueRows,
	deleteScalarValueRow,
	readAllScalarValueRows,
	readListValueRows,
	readScalarValueRow,
	scanScalarValueRows,
	setScalarValueRow,
} from "./session/values.ts";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteStorageOptions {
	now?: () => number;
	beforeCommit?: () => void;
}

export interface SqliteStorageSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	entriesComplete: boolean;
}

export class SqliteStorage implements Storage {
	private readonly db: SqliteDatabase;
	private readonly now: () => number;
	private readonly beforeCommit: () => void;
	private readonly entryWriter: EntryRowWriter;
	private readonly usageWriter: UsageLedgerRowWriter;
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(db: SqliteDatabase, options: SqliteStorageOptions = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
		this.beforeCommit = options.beforeCommit ?? (() => undefined);
		this.entryWriter = new EntryRowWriter(db);
		this.usageWriter = new UsageLedgerRowWriter(db);
	}

	async commit(writes: Write[], _context: Context): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("SqliteStorage is closed");
		const result = this.commitQueue.then(() => this.applyCommit(writes));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		const rowsById = new Map(readEntryRows(this.db, ids).map((row) => [row.id, row]));
		const entries = new Map<string, Entry>();
		for (const id of ids) {
			const row = rowsById.get(id);
			if (row !== undefined) entries.set(id, decodeEntryRow(row));
		}
		return Promise.resolve(entries);
	}

	getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(readScalarValueRow(this.db, address));
	}

	scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanScalarValueRows(this.db, prefix));
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		_context: Context,
	): Promise<ListElement<T>[]> {
		if (this.state !== "open") throw new Error("SqliteStorage is closed");
		return readListValueRows(this.db, address, options);
	}

	scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve().then(() => scanBranchEntries(this.db, query));
	}

	scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve().then(() => scanBranchEntryStructures(this.db, query));
	}

	scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanEntryRows(this.db, query).map(decodeEntryRow));
	}

	scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanUsageLedgerRows(this.db, query).map(decodeUsageLedgerRow));
	}

	getStats(_context: Context): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(readSessionStats(this.db));
	}

	snapshot(options: ForkOptions | undefined, _context: Context): Promise<SqliteStorageSnapshot> {
		options ??= {};
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		const result = this.commitQueue.then(() => this.readSnapshot(options));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private readSnapshot(options: ForkOptions): SqliteStorageSnapshot {
		const scalarValues = readAllScalarValueRows(this.db);
		return {
			entries: this.readSnapshotEntries(options, scalarValues),
			scalarValues,
			entriesComplete: options.scope === "tree",
		};
	}

	private readSnapshotEntries(options: ForkOptions, scalarValues: readonly StoredValue<unknown>[]): Entry[] {
		if (options.scope === "tree") return readAllEntryRows(this.db).map(decodeEntryRow);
		const mainAddress = laneLeaf("main");
		const mainLeaf = scalarValues.find(
			(stored) => stored.address.namespace === mainAddress.namespace && stored.address.key === mainAddress.key,
		) as StoredValue<string | null> | undefined;
		if (mainLeaf === undefined) throw new Error("Source session is missing main lane");
		const requested = options.entryId ?? mainLeaf.value;
		return requested === null ? [] : scanBranchEntries(this.db, { start: requested, order: "oldestFirst" });
	}

	private applyCommit(writes: Write[]): CommitResult {
		this.beforeCommit();
		return this.db.transaction(() => {
			const firstSeq = readNextSeq(this.db);
			const prepared = prepareStorageCommit(writes, firstSeq, this.now());
			for (const write of prepared.writes) {
				switch (write.kind) {
					case "entry": {
						const { kind: _kind, ...entry } = write;
						this.entryWriter.insert(entry);
						appendEntryToBranchIndex(this.db, entry);
						if (entry.type === "message") incrementMessageCount(this.db);
						break;
					}
					case "usage": {
						const { kind: _kind, ...row } = write;
						this.usageWriter.insert(row);
						addUsageToSessionStats(this.db, row.usage);
						break;
					}
					case "value":
						if (write.op === "delete") {
							deleteScalarValueRow(this.db, write.namespace, write.key);
						} else {
							setScalarValueRow(this.db, write.namespace, write.key, write.seq, write.value);
						}
						break;
					case "list":
						if (write.op === "delete") {
							deleteListValueRows(this.db, write.namespace, write.key);
						} else {
							appendListValueRow(this.db, write.namespace, write.key, write.seq, write.value);
						}
						break;
				}
			}
			advanceNextSeq(this.db, firstSeq + prepared.writes.length);
			return prepared.result;
		});
	}

	close(_context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}
}

import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	Register,
	RegisterNamespace,
	SessionStats,
	Storage,
	StorageBranchScan,
	Transaction,
	UsageRow,
	UsageScan,
} from "@earendil-works/pi-agent-core";
import { prepareStorageCommit } from "@earendil-works/pi-agent-core";
import { appendEntryToBranchIndex, scanBranchEntries, scanBranchEntryStructures } from "./session/branch-entries.ts";
import { decodeEntryRow, EntryRowWriter, readEntryRows, scanEntryRows } from "./session/entries.ts";
import { deleteRegisterRow, listRegisterRows, readRegisterRow, setRegisterRow } from "./session/registers.ts";
import { advanceNextSeq, readNextSeq } from "./session/session-sequences.ts";
import { addUsageToSessionStats, incrementMessageCount, readSessionStats } from "./session/session-stats.ts";
import { decodeUsageLedgerRow, scanUsageLedgerRows, UsageLedgerRowWriter } from "./session/usage-ledger.ts";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteStorageOptions {
	now?: () => number;
}

export class SqliteStorage implements Storage {
	private readonly db: SqliteDatabase;
	private readonly now: () => number;
	private readonly entryWriter: EntryRowWriter;
	private readonly usageWriter: UsageLedgerRowWriter;
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(db: SqliteDatabase, options: SqliteStorageOptions = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
		this.entryWriter = new EntryRowWriter(db);
		this.usageWriter = new UsageLedgerRowWriter(db);
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("SqliteStorage is closed");
		const result = this.commitQueue.then(() => this.applyCommit(transaction));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		const rowsById = new Map(readEntryRows(this.db, ids).map((row) => [row.id, row]));
		const entries = new Map<string, Entry>();
		for (const id of ids) {
			const row = rowsById.get(id);
			if (row !== undefined) entries.set(id, decodeEntryRow(row));
		}
		return Promise.resolve(entries);
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(readRegisterRow(this.db, namespace, key));
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(listRegisterRows(this.db, namespace, keyPrefix));
	}

	scanBranch(query: StorageBranchScan): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanBranchEntries(this.db, query));
	}

	scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanBranchEntryStructures(this.db, query));
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanEntryRows(this.db, query).map(decodeEntryRow));
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(scanUsageLedgerRows(this.db, query).map(decodeUsageLedgerRow));
	}

	getStats(): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("SqliteStorage is closed"));
		return Promise.resolve(readSessionStats(this.db));
	}

	private applyCommit(transaction: Transaction): CommitResult {
		return this.db.transaction(() => {
			const firstSeq = readNextSeq(this.db);
			const prepared = prepareStorageCommit(transaction, firstSeq, this.now());
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
					case "register":
						if (write.op === "delete") {
							deleteRegisterRow(this.db, write.namespace, write.key);
						} else {
							setRegisterRow(this.db, write.namespace, write.key, write.seq, write.value);
						}
						break;
				}
			}
			advanceNextSeq(this.db, firstSeq + prepared.writes.length);
			return prepared.result;
		});
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}
}

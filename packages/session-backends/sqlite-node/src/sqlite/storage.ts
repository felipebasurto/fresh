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
import { scanBranchEntries, scanBranchEntryStructures } from "./session/branch-entries.ts";
import { decodeEntryRow, readEntryRows, scanEntryRows } from "./session/entries.ts";
import { listRegisterRows, readRegisterRow } from "./session/registers.ts";
import { readSessionStats } from "./session/session-stats.ts";
import { decodeUsageLedgerRow, scanUsageLedgerRows } from "./session/usage-ledger.ts";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteStorageOptions {
	now?: () => number;
}

export class SqliteStorage implements Storage {
	private readonly db: SqliteDatabase;
	private readonly now: () => number;
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(db: SqliteDatabase, options: SqliteStorageOptions = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
	}

	commit(_transaction: Transaction): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("SqliteStorage is closed");
		// TODO: Implement atomic SQLite commits in one BEGIN IMMEDIATE transaction.
		void this.now;
		return Promise.reject(new Error("SqliteStorage.commit is not implemented"));
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

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}
}

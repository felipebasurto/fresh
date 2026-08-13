import type {
	BranchScan,
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
		this.assertOpen();
		// TODO: Implement atomic SQLite commits in one BEGIN IMMEDIATE transaction.
		void this.db;
		void this.now;
		return Promise.reject(new Error("SqliteStorage.commit is not implemented"));
	}

	getEntries(_ids: string[]): Promise<Map<string, Entry>> {
		this.assertOpen();
		// TODO: Implement using session/entries.ts helpers.
		return Promise.reject(new Error("SqliteStorage.getEntries is not implemented"));
	}

	getRegister<TNamespace extends RegisterNamespace>(
		_namespace: TNamespace,
		_key: string,
	): Promise<Register<TNamespace> | undefined> {
		this.assertOpen();
		// TODO: Implement using session/registers.ts helpers.
		return Promise.reject(new Error("SqliteStorage.getRegister is not implemented"));
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		_namespace: TNamespace,
		_keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		this.assertOpen();
		// TODO: Implement using session/registers.ts helpers.
		return Promise.reject(new Error("SqliteStorage.listRegisters is not implemented"));
	}

	scanBranch(_query: StorageBranchScan): Promise<Entry[]> {
		this.assertOpen();
		// TODO: Implement using the private branch index.
		return Promise.reject(new Error("SqliteStorage.scanBranch is not implemented"));
	}

	scanBranchStructure(_query: BranchScan & { start: string }): Promise<EntryStructure[]> {
		this.assertOpen();
		// TODO: Implement using the private branch index.
		return Promise.reject(new Error("SqliteStorage.scanBranchStructure is not implemented"));
	}

	scanEntries(_query: EntryScan): Promise<Entry[]> {
		this.assertOpen();
		// TODO: Implement using session/entries.ts helpers.
		return Promise.reject(new Error("SqliteStorage.scanEntries is not implemented"));
	}

	scanUsage(_query: UsageScan): Promise<UsageRow[]> {
		this.assertOpen();
		// TODO: Implement using session/usage-ledger.ts helpers.
		return Promise.reject(new Error("SqliteStorage.scanUsage is not implemented"));
	}

	getStats(): Promise<SessionStats> {
		this.assertOpen();
		// TODO: Implement using session/session-stats.ts helpers.
		return Promise.reject(new Error("SqliteStorage.getStats is not implemented"));
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}

	private assertOpen(): void {
		if (this.state !== "open") throw new Error("SqliteStorage is closed");
	}
}

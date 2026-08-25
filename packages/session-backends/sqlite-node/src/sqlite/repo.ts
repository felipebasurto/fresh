import { access, mkdir, open as openFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Entry, ForkOptions, SessionCreateOptions, StoredValue } from "@earendil-works/pi-agent-core";
import { branchTip, createForkSnapshot, StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { applyInitialSchema } from "./migrations.ts";
import { appendEntryToBranchIndex, scanBranchEntries } from "./session/branch-entries.ts";
import { decodeEntryRow, type EntryRow, EntryRowWriter } from "./session/entries.ts";
import {
	deleteSessionRows,
	hasSessionRow,
	insertSessionRow,
	metadataFromSessionRow,
	readAllSessionRows,
	readSessionRow,
	type SqliteSessionMetadata,
} from "./session/session-row.ts";
import { readAllScalarValueRows, setScalarValueRow } from "./session/values.ts";
import {
	claimWriterLease,
	readWriterLease,
	releaseWriterLease,
	renewWriterLease,
	type WriterLeaseRow,
} from "./session/writer-lease.ts";
import { SqliteOpenSession } from "./session.ts";
import { sql } from "./sql.ts";
import { SqliteStorage, type SqliteStorageSnapshot } from "./storage.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "./types.ts";

export const SQLITE_STORAGE_VERSION = 1;
export const SQLITE_SESSION_EXTENSION = ".sqlite";

const DEFAULT_WRITER_LEASE_MS = 30_000;
const WRITER_LEASE_RENEW_INTERVAL_MS = DEFAULT_WRITER_LEASE_MS / 2;
const FIRST_AVAILABLE_COMMIT_SEQ = 1;

export type SqliteSessionCreateOptions = SessionCreateOptions;

export interface SqliteSessionRepoOptions {
	directory: string;
	/** Optional single container path. Defaults to one `${id}.sqlite` file per session under directory. */
	databasePath?: string;
	databaseFactory: SqliteDatabaseFactory;
	now?: () => number;
}

function sessionPath(directory: string, id: string): string {
	return join(directory, `${id}${SQLITE_SESSION_EXTENSION}`);
}

async function removeSessionFiles(path: string, options: { force: boolean }): Promise<void> {
	await rm(path, { force: options.force });
	await rm(`${path}-wal`, { force: true });
	await rm(`${path}-shm`, { force: true });
}

function configureConnection(db: SqliteDatabase): void {
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}

interface ForkSnapshot {
	entries: Entry[];
	scalarValues: StoredValue<unknown>[];
	messageCount: number;
	nextSeq: number;
}

function readSourceEntries(db: SqliteDatabase, sessionId: string): Entry[] {
	return sql`SELECT id, parent_id, seq, type, custom_type, timestamp, payload
		FROM entries WHERE session_id = ${sessionId} ORDER BY seq ASC`
		.all<EntryRow>(db)
		.map(decodeEntryRow);
}

function buildForkSnapshot(source: SqliteStorageSnapshot, options: ForkOptions): ForkSnapshot {
	const snapshot = createForkSnapshot(
		{
			entries: source.entries,
			scalarValues: source.scalarValues,
			entriesComplete: source.entriesComplete,
		},
		options,
	);
	const entries = [...snapshot.entries.values()].sort((left, right) => left.seq - right.seq);
	return {
		entries,
		scalarValues: snapshot.scalarValues,
		messageCount: entries.filter((entry) => entry.type === "message").length,
		nextSeq: snapshot.nextSeq,
	};
}

function readForkSourceEntries(
	db: SqliteDatabase,
	sessionId: string,
	scalarValues: readonly StoredValue<unknown>[],
	options: ForkOptions,
): Entry[] {
	if (options.scope === "tree") return readSourceEntries(db, sessionId);
	const mainAddress = branchTip("main");
	const mainTip = scalarValues.find(
		(stored) => stored.address.namespace === mainAddress.namespace && stored.address.key === mainAddress.key,
	) as StoredValue<string | null> | undefined;
	if (mainTip === undefined) throw new Error("Source session is missing main branch");
	const requested = options.entryId ?? mainTip.value;
	return requested === null ? [] : scanBranchEntries(db, sessionId, { start: requested, order: "oldestFirst" });
}

function createSqliteForkSnapshot(sourceDb: SqliteDatabase, sessionId: string, options: ForkOptions): ForkSnapshot {
	sourceDb.exec("BEGIN");
	let committed = false;
	try {
		const scalarValues = readAllScalarValueRows(sourceDb, sessionId);
		const snapshot = buildForkSnapshot(
			{
				entries: readForkSourceEntries(sourceDb, sessionId, scalarValues, options),
				scalarValues,
				entriesComplete: options.scope === "tree",
			},
			options,
		);
		sourceDb.exec("COMMIT");
		committed = true;
		return snapshot;
	} catch (error) {
		if (!committed) sourceDb.exec("ROLLBACK");
		throw error;
	}
}

function insertForkValue(db: SqliteDatabase, sessionId: string, stored: StoredValue<unknown>): void {
	setScalarValueRow(db, sessionId, stored.address.namespace, stored.address.key, stored.seq, stored.value);
}

function updateForkSessionStats(db: SqliteDatabase, sessionId: string, messageCount: number): void {
	sql`UPDATE sessions SET message_count = ${messageCount} WHERE id = ${sessionId}`.run(db);
}

export class SqliteSessionRepo {
	private readonly directory: string;
	private readonly databasePath: string | undefined;
	private readonly databaseFactory: SqliteDatabaseFactory;
	private readonly now: () => number;
	private readonly pendingIds = new Set<string>();
	private readonly openStorages = new Map<string, SqliteStorage>();
	private readonly openSessions = new Set<SqliteOpenSession>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: SqliteSessionRepoOptions) {
		this.directory = options.directory;
		this.databasePath = options.databasePath;
		this.databaseFactory = options.databaseFactory;
		this.now = options.now ?? Date.now;
	}

	async create(options: SqliteSessionCreateOptions | undefined, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		options ??= {};
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const path = this.pathForSession(id);
		let db: SqliteDatabase | undefined;
		let lease: WriterLeaseRow | undefined;
		let reservedFile = false;
		let initialized = false;
		let session: SqliteOpenSession | undefined;
		try {
			await mkdir(this.directory, { recursive: true });
			if (!this.usesSharedDatabase()) {
				const file = await openFile(path, "wx");
				await file.close();
				reservedFile = true;
			}
			const activeDb = await this.databaseFactory.open(path);
			db = activeDb;
			configureConnection(activeDb);
			await applyInitialSchema(activeDb);
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				storageVersion: SQLITE_STORAGE_VERSION,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
				path,
			};
			lease = activeDb.transaction(() => {
				if (hasSessionRow(activeDb, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, FIRST_AVAILABLE_COMMIT_SEQ);
				return claimWriterLease(activeDb, id, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
			});
			initialized = true;
			session = this.openStorageBackedSession(metadata, activeDb, lease);
			return session;
		} catch (error) {
			if (reservedFile && !initialized) await removeSessionFiles(path, { force: true });
			throw error;
		} finally {
			if (session === undefined) {
				const failedDb = db;
				const failedLease = lease;
				if (failedDb !== undefined && failedLease !== undefined) {
					failedDb.transaction(() => releaseWriterLease(failedDb, id, failedLease.owner_id, failedLease.fence));
				}
				db?.close();
				this.pendingIds.delete(id);
			}
		}
	}

	async open(metadata: SqliteSessionMetadata, _context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		this.reserveId(metadata.id);
		let db: SqliteDatabase | undefined;
		let lease: WriterLeaseRow | undefined;
		let session: SqliteOpenSession | undefined;
		try {
			await access(metadata.path);
			const activeDb = await this.databaseFactory.open(metadata.path);
			db = activeDb;
			configureConnection(activeDb);
			const stored = activeDb.transaction(() => {
				const stored = metadataFromSessionRow(
					metadata.path,
					readSessionRow(activeDb, metadata.id),
					SQLITE_STORAGE_VERSION,
				);
				lease = claimWriterLease(activeDb, metadata.id, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
				return stored;
			});
			if (lease === undefined) throw new Error("Failed to claim SQLite writer lease");
			session = this.openStorageBackedSession(stored, activeDb, lease);
			return session;
		} finally {
			if (session === undefined) {
				const failedDb = db;
				const failedLease = lease;
				if (failedDb !== undefined && failedLease !== undefined) {
					failedDb.transaction(() =>
						releaseWriterLease(failedDb, metadata.id, failedLease.owner_id, failedLease.fence),
					);
				}
				db?.close();
				this.pendingIds.delete(metadata.id);
			}
		}
	}

	async list(_options: undefined, _context: Context): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		await mkdir(this.directory, { recursive: true });
		const paths = this.usesSharedDatabase()
			? [this.pathForSession("")]
			: (await readdir(this.directory))
					.filter((name) => name.endsWith(SQLITE_SESSION_EXTENSION))
					.map((name) => join(this.directory, name));
		const sessions: SqliteSessionMetadata[] = [];
		for (const path of paths) {
			let db: SqliteDatabase | undefined;
			try {
				await access(path);
				db = await this.databaseFactory.open(path);
				configureConnection(db);
				for (const row of readAllSessionRows(db)) {
					sessions.push(metadataFromSessionRow(path, row, SQLITE_STORAGE_VERSION));
				}
			} catch {
				// Discovery is best-effort: corrupt files, incompatible versions, and
				// unrelated *.sqlite files are reported when explicitly opened.
			} finally {
				db?.close();
			}
		}
		return sessions.sort((left, right) => right.createdAt - left.createdAt);
	}

	async delete(metadata: SqliteSessionMetadata, _context: Context): Promise<void> {
		this.assertOpen();
		if (this.pendingIds.has(metadata.id)) throw new Error(`Session is open: ${metadata.id}`);
		await access(metadata.path);
		const db = await this.databaseFactory.open(metadata.path);
		try {
			configureConnection(db);
			const lease = readWriterLease(db, metadata.id);
			if (lease !== undefined && lease.expires_at_ms > this.now()) {
				throw new Error(`SQLite session is already claimed by writer ${lease.owner_id}`);
			}
		} finally {
			db.close();
		}
		if (this.usesSharedDatabase()) {
			const deleteDb = await this.databaseFactory.open(metadata.path);
			try {
				configureConnection(deleteDb);
				deleteDb.transaction(() => deleteSessionRows(deleteDb, metadata.id));
			} finally {
				deleteDb.close();
			}
		} else {
			await removeSessionFiles(metadata.path, { force: false });
		}
	}

	async fork(source: SqliteSessionMetadata, options: ForkOptions, context: Context): Promise<SqliteOpenSession> {
		this.assertOpen();
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const sourceStorage = this.openStorages.get(source.id);
		const activeSourceSnapshot = sourceStorage?.snapshot(options, context);
		void activeSourceSnapshot?.catch(() => undefined);
		await mkdir(this.directory, { recursive: true });
		const path = this.pathForSession(id);
		let db: SqliteDatabase | undefined;
		let lease: WriterLeaseRow | undefined;
		let reservedFile = false;
		let initialized = false;
		let session: SqliteOpenSession | undefined;
		try {
			if (!this.usesSharedDatabase()) {
				const file = await openFile(path, "wx");
				await file.close();
				reservedFile = true;
			}

			const snapshot =
				activeSourceSnapshot === undefined
					? await this.createForkSnapshotFromClosedSource(source, options)
					: buildForkSnapshot(await activeSourceSnapshot, options);

			const activeDb = await this.databaseFactory.open(path);
			db = activeDb;
			configureConnection(activeDb);
			await applyInitialSchema(activeDb);
			const metadata: SqliteSessionMetadata = {
				id,
				createdAt,
				storageVersion: SQLITE_STORAGE_VERSION,
				parentSessionId: source.id,
				path,
			};
			lease = activeDb.transaction(() => {
				if (hasSessionRow(activeDb, id)) throw new Error(`SQLite session already exists: ${id}`);
				insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, snapshot.nextSeq);
				const entryWriter = new EntryRowWriter(activeDb, id);
				for (const entry of snapshot.entries) {
					entryWriter.insert(entry);
					appendEntryToBranchIndex(activeDb, id, entry);
				}
				for (const stored of snapshot.scalarValues) insertForkValue(activeDb, id, stored);
				updateForkSessionStats(activeDb, id, snapshot.messageCount);
				return claimWriterLease(activeDb, id, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
			});
			initialized = true;
			session = this.openStorageBackedSession(metadata, activeDb, lease);
			return session;
		} catch (error) {
			if (reservedFile && !initialized) await removeSessionFiles(path, { force: true });
			throw error;
		} finally {
			if (session === undefined) {
				const failedDb = db;
				const failedLease = lease;
				if (failedDb !== undefined && failedLease !== undefined) {
					failedDb.transaction(() => releaseWriterLease(failedDb, id, failedLease.owner_id, failedLease.fence));
				}
				db?.close();
				this.pendingIds.delete(id);
			}
		}
	}

	private async createForkSnapshotFromClosedSource(
		source: SqliteSessionMetadata,
		options: ForkOptions,
	): Promise<ForkSnapshot> {
		const sourceDb = await this.databaseFactory.open(source.path);
		try {
			configureConnection(sourceDb);
			metadataFromSessionRow(source.path, readSessionRow(sourceDb, source.id), SQLITE_STORAGE_VERSION);
			return createSqliteForkSnapshot(sourceDb, source.id, options);
		} finally {
			sourceDb.close();
		}
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.closePromise = Promise.all([...this.openSessions].map((session) => session.close(context))).then(
			() => undefined,
		);
		return this.closePromise;
	}

	private openStorageBackedSession(
		metadata: SqliteSessionMetadata,
		db: SqliteDatabase,
		initialLease: WriterLeaseRow,
	): SqliteOpenSession {
		let lease = initialLease;
		const renew = () => {
			lease = db.transaction(() =>
				renewWriterLease(db, metadata.id, lease.owner_id, lease.fence, this.now(), DEFAULT_WRITER_LEASE_MS),
			);
		};
		const storage = new SqliteStorage(db, { sessionId: metadata.id, now: this.now, beforeCommit: renew });
		this.openStorages.set(metadata.id, storage);
		const session = new StorageBackedSession(metadata, storage);
		const openSession = new SqliteOpenSession(session, {
			renewWriterLease: renew,
			releaseWriterLease: () =>
				db.transaction(() => releaseWriterLease(db, metadata.id, lease.owner_id, lease.fence)),
			renewIntervalMs: WRITER_LEASE_RENEW_INTERVAL_MS,
			onClose: () => {
				db.close();
				this.openStorages.delete(metadata.id);
				this.openSessions.delete(openSession);
				this.pendingIds.delete(metadata.id);
			},
		});
		this.openSessions.add(openSession);
		return openSession;
	}

	private reserveId(id: string): void {
		if (this.pendingIds.has(id)) throw new Error(`Session is already open: ${id}`);
		this.pendingIds.add(id);
	}

	private pathForSession(id: string): string {
		return this.databasePath ?? sessionPath(this.directory, id);
	}

	private usesSharedDatabase(): boolean {
		return this.databasePath !== undefined;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("SqliteSessionRepo is closed");
	}
}

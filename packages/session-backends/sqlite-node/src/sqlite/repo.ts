import { access, mkdir, open as openFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionCreateOptions } from "@earendil-works/pi-agent-core";
import { StorageBackedSession } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { applyInitialSchema } from "./migrations.ts";
import { insertInitialMainLaneRegisters } from "./session/registers.ts";
import {
	insertSessionRow,
	metadataFromSessionRow,
	readSessionRowCount,
	readSingleSessionRow,
	type SqliteSessionMetadata,
} from "./session/session-row.ts";
import { claimWriterLease, releaseWriterLease } from "./session/writer-lease.ts";
import { SqliteOpenSession } from "./session.ts";
import { SqliteStorage } from "./storage.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "./types.ts";

export const SQLITE_STORAGE_VERSION = 1;
export const SQLITE_SESSION_EXTENSION = ".sqlite";

const DEFAULT_WRITER_LEASE_MS = 30_000;
const FIRST_AVAILABLE_COMMIT_SEQ = 3;

export type SqliteSessionCreateOptions = SessionCreateOptions;

export interface SqliteSessionRepoOptions {
	directory: string;
	databaseFactory: SqliteDatabaseFactory;
	now?: () => number;
}

function sessionPath(directory: string, id: string): string {
	return join(directory, `${id}${SQLITE_SESSION_EXTENSION}`);
}

function sessionIdFromPath(path: string): string {
	const name = basename(path);
	return name.endsWith(SQLITE_SESSION_EXTENSION) ? name.slice(0, -SQLITE_SESSION_EXTENSION.length) : name;
}

async function removeSessionFiles(path: string, options: { force: boolean }): Promise<void> {
	await rm(path, { force: options.force });
	await rm(`${path}-wal`, { force: true });
	await rm(`${path}-shm`, { force: true });
}

function configureConnection(db: SqliteDatabase): void {
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}

export class SqliteSessionRepo {
	private readonly directory: string;
	private readonly databaseFactory: SqliteDatabaseFactory;
	private readonly now: () => number;
	private readonly pendingIds = new Set<string>();

	constructor(options: SqliteSessionRepoOptions) {
		this.directory = options.directory;
		this.databaseFactory = options.databaseFactory;
		this.now = options.now ?? Date.now;
	}

	async create(options: SqliteSessionCreateOptions = {}): Promise<SqliteOpenSession> {
		await mkdir(this.directory, { recursive: true });
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const path = sessionPath(this.directory, id);
		let db: SqliteDatabase | undefined;
		let reservedFile = false;
		let initialized = false;
		let session: SqliteOpenSession | undefined;
		try {
			const file = await openFile(path, "wx");
			await file.close();
			reservedFile = true;
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
			activeDb.transaction(() => {
				if (readSessionRowCount(activeDb) !== 0) throw new Error(`SQLite session already exists at ${path}`);
				insertSessionRow(activeDb, metadata, SQLITE_STORAGE_VERSION, FIRST_AVAILABLE_COMMIT_SEQ);
				insertInitialMainLaneRegisters(activeDb);
				// TODO: Keep this lease until SqliteOpenSession.close() and release only the matching fenced claim.
				const lease = claimWriterLease(activeDb, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
				releaseWriterLease(activeDb, lease.owner_id, lease.fence);
			});
			initialized = true;
			session = this.openStorageBackedSession(metadata, activeDb);
			return session;
		} catch (error) {
			if (reservedFile && !initialized) await removeSessionFiles(path, { force: true });
			throw error;
		} finally {
			if (session === undefined) {
				db?.close();
				this.pendingIds.delete(id);
			}
		}
	}

	async open(metadata: SqliteSessionMetadata): Promise<SqliteOpenSession> {
		this.reserveId(metadata.id);
		let db: SqliteDatabase | undefined;
		let session: SqliteOpenSession | undefined;
		try {
			await access(metadata.path);
			const activeDb = await this.databaseFactory.open(metadata.path);
			db = activeDb;
			configureConnection(activeDb);
			const stored = activeDb.transaction(() => {
				const id = sessionIdFromPath(metadata.path);
				const stored = metadataFromSessionRow(
					metadata.path,
					id,
					readSingleSessionRow(activeDb),
					SQLITE_STORAGE_VERSION,
				);
				if (stored.id !== metadata.id) {
					throw new Error(`SQLite session path ${metadata.path} contains ${stored.id}, not ${metadata.id}`);
				}
				// TODO: Keep this lease until SqliteOpenSession.close() and release only the matching fenced claim.
				const lease = claimWriterLease(activeDb, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
				releaseWriterLease(activeDb, lease.owner_id, lease.fence);
				return stored;
			});
			session = this.openStorageBackedSession(stored, activeDb);
			return session;
		} finally {
			if (session === undefined) {
				db?.close();
				this.pendingIds.delete(metadata.id);
			}
		}
	}

	async list(): Promise<SqliteSessionMetadata[]> {
		// TODO: Decide whether incompatible/corrupt session files should be skipped or reported instead of failing the whole list.
		await mkdir(this.directory, { recursive: true });
		const names = await readdir(this.directory);
		const sessions: SqliteSessionMetadata[] = [];
		for (const name of names) {
			if (!name.endsWith(SQLITE_SESSION_EXTENSION)) continue;
			const path = join(this.directory, name);
			const db = await this.databaseFactory.open(path);
			try {
				configureConnection(db);
				sessions.push(
					metadataFromSessionRow(path, sessionIdFromPath(path), readSingleSessionRow(db), SQLITE_STORAGE_VERSION),
				);
			} finally {
				db.close();
			}
		}
		return sessions.sort((left, right) => right.createdAt - left.createdAt);
	}

	async delete(metadata: SqliteSessionMetadata): Promise<void> {
		// TODO: Reject missing files and live external writer leases before unlinking once repo/session ownership is wired.
		if (this.pendingIds.has(metadata.id)) throw new Error(`Session is open: ${metadata.id}`);
		await rm(metadata.path, { force: true });
	}

	private openStorageBackedSession(metadata: SqliteSessionMetadata, db: SqliteDatabase): SqliteOpenSession {
		const storage = new SqliteStorage(db, { now: this.now });
		const session = new StorageBackedSession(metadata, storage);
		return new SqliteOpenSession(session, () => {
			db.close();
			this.pendingIds.delete(metadata.id);
		});
	}

	private reserveId(id: string): void {
		if (this.pendingIds.has(id)) throw new Error(`Session is already open: ${id}`);
		this.pendingIds.add(id);
	}
}

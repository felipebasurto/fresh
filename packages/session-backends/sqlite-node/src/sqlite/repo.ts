import { access, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionCreateOptions } from "@earendil-works/pi-agent-core";
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

function configureConnection(db: SqliteDatabase): void {
	db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
}

// TODO: Implement SessionRepo<SqliteSessionMetadata, SqliteSessionCreateOptions> once SqliteStorage returns real Sessions.
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

	// TODO: Return an open Session<SqliteSessionMetadata> once SqliteStorage is wired in.
	async create(options: SqliteSessionCreateOptions = {}): Promise<unknown> {
		await mkdir(this.directory, { recursive: true });
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const path = sessionPath(this.directory, id);
		let db: SqliteDatabase | undefined;
		let initialized = false;
		try {
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
				// TODO: Keep this lease until Session.close() once SqliteStorage exists.
				const lease = claimWriterLease(activeDb, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
				releaseWriterLease(activeDb, lease.owner_id, lease.fence);
			});
			initialized = true;
			return metadata;
		} catch (error) {
			if (!initialized) await rm(path, { force: true });
			throw error;
		} finally {
			db?.close();
			this.pendingIds.delete(id);
		}
	}

	// TODO: Return an open Session<SqliteSessionMetadata> once SqliteStorage is wired in.
	async open(metadata: SqliteSessionMetadata): Promise<unknown> {
		this.reserveId(metadata.id);
		let db: SqliteDatabase | undefined;
		try {
			await access(metadata.path);
			const activeDb = await this.databaseFactory.open(metadata.path);
			db = activeDb;
			configureConnection(activeDb);
			return activeDb.transaction(() => {
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
				// TODO: Keep this lease until Session.close() once SqliteStorage exists.
				const lease = claimWriterLease(activeDb, uuidv7(this.now()), this.now(), DEFAULT_WRITER_LEASE_MS);
				releaseWriterLease(activeDb, lease.owner_id, lease.fence);
				return stored;
			});
		} finally {
			db?.close();
			this.pendingIds.delete(metadata.id);
		}
	}

	async list(): Promise<SqliteSessionMetadata[]> {
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
		if (this.pendingIds.has(metadata.id)) throw new Error(`Session is open: ${metadata.id}`);
		await rm(metadata.path, { force: true });
	}

	private reserveId(id: string): void {
		if (this.pendingIds.has(id)) throw new Error(`Session is already open: ${id}`);
		this.pendingIds.add(id);
	}
}

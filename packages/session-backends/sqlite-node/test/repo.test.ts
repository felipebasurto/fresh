import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storedValues from "@earendil-works/pi-agent-core";
import * as sessionWrites from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/index.ts";
import { createNodeSqliteFactory, SqliteSessionRepo, sql } from "../src/index.ts";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function withDb<T>(path: string, run: (db: SqliteDatabase) => Promise<T> | T): Promise<T> {
	const db = await createNodeSqliteFactory().open(path);
	try {
		return await run(db);
	} finally {
		db.close();
	}
}

describe("SqliteSessionRepo", () => {
	it("creates one branchless initialized session file", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});

			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const metadata = session.metadata;
			expect(metadata).toMatchObject({
				id: "session",
				createdAt: 1_700_000_000_000,
				storageVersion: 1,
			});
			expect(metadata.path).toBe(join(directory, "session.sqlite"));

			await withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM sessions`.get<{ count: number }>(db)).toEqual({ count: 1 });
				expect(
					sql`SELECT message_count, usage_payload, next_seq FROM sessions WHERE id = ${"session"}`.get(db),
				).toEqual({
					message_count: 0,
					usage_payload: JSON.stringify({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					}),
					next_seq: 1,
				});
				expect(
					sql`SELECT namespace, key, seq, value FROM scalar_values WHERE session_id = ${"session"} ORDER BY seq`.all(
						db,
					),
				).toEqual([]);
				expect(sql`SELECT COUNT(*) AS count FROM list_values WHERE session_id = ${"session"}`.get(db)).toEqual({
					count: 0,
				});
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("exposes explicit branch scans through the open-session facade", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							sessionWrites.insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			expect(await session.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT)).toMatchObject([
				{ id: "root" },
				{ id: "child" },
			]);
			await session.close(BACKGROUND_CONTEXT);
			await expect(session.scanBranch({ start: "child" }, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		});
	});

	it("commits an explicit mutation through the open-session facade", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
			const result = await mutation.commit(
				[storedValues.setValue(storedValues.sessionName, "explicit")],
				BACKGROUND_CONTEXT,
			);

			expect(result.seqs).toHaveLength(1);
			expect(await mutation.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "explicit",
			});
			await mutation.end(BACKGROUND_CONTEXT);
			expect(await session.getName(BACKGROUND_CONTEXT)).toBe("explicit");
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("rejects duplicate create without deleting the existing database", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;

			await expect(repo.create({ id: "session" }, BACKGROUND_CONTEXT)).rejects.toThrow();
			await withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM sessions`.get<{ count: number }>(db)).toEqual({ count: 1 });
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("lists sessions without changing the writer lease", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;
			let leaseBeforeList: unknown[] = [];
			await withDb(metadata.path, (db) => {
				leaseBeforeList = sql`SELECT owner_id, fence FROM writer_lease WHERE session_id = ${"session"}`.all(db);
			});

			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).resolves.toMatchObject([
				{ id: "session", path: metadata.path },
			]);
			await withDb(metadata.path, (db) => {
				expect(sql`SELECT owner_id, fence FROM writer_lease WHERE session_id = ${"session"}`.all(db)).toEqual(
					leaseBeforeList,
				);
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("skips corrupt and incompatible files during list discovery", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			await writeFile(join(directory, "corrupt.sqlite"), "not a sqlite database");
			await withDb(session.metadata.path, (db) => {
				sql`UPDATE sessions SET storage_version = ${999} WHERE id = ${"session"}`.run(db);
			});

			expect(await repo.list(undefined, BACKGROUND_CONTEXT)).toEqual([]);
		});
	});

	it("does not remove a pre-existing non-database file when create fails", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const path = join(directory, "session.sqlite");
			await writeFile(path, "not a sqlite database");

			await expect(repo.create({ id: "session" }, BACKGROUND_CONTEXT)).rejects.toThrow();
			await expect(access(path)).resolves.toBeUndefined();
		});
	});

	it("rejects delete for missing files and live external writer leases", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;
			await session.close(BACKGROUND_CONTEXT);

			await withDb(metadata.path, (db) => {
				sql`INSERT INTO writer_lease (session_id, owner_id, fence, expires_at_ms) VALUES (${"session"}, ${"external"}, ${1}, ${1_000})`.run(
					db,
				);
			});
			await expect(repo.delete(metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already claimed");
			await withDb(metadata.path, (db) => {
				sql`DELETE FROM writer_lease WHERE session_id = ${"session"}`.run(db);
			});

			await expect(
				repo.delete({ ...metadata, path: join(directory, "missing.sqlite") }, BACKGROUND_CONTEXT),
			).rejects.toThrow();
			await repo.delete(metadata, BACKGROUND_CONTEXT);
			await expect(access(metadata.path)).rejects.toThrow();
		});
	});

	it("closes open sessions through repo close and rejects later operations", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);

			await repo.close(BACKGROUND_CONTEXT);

			await expect(session.getStats(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).rejects.toThrow("SqliteSessionRepo is closed");
			await expect(repo.create({ id: "other" }, BACKGROUND_CONTEXT)).rejects.toThrow("SqliteSessionRepo is closed");
			await expect(repo.close(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		});
	});

	it("opens a session through the version gate and rejects a live external writer lease", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const created = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = created;
			await created.close(BACKGROUND_CONTEXT);

			const opened = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect(opened.metadata).toMatchObject({ id: "session", path: metadata.path });
			await opened.close(BACKGROUND_CONTEXT);

			await withDb(metadata.path, (db) => {
				sql`INSERT INTO writer_lease (session_id, owner_id, fence, expires_at_ms) VALUES (${"session"}, ${"external"}, ${1}, ${1_000})`.run(
					db,
				);
			});
			await expect(repo.open(metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already claimed");
		});
	});

	it("isolates sessions stored in one shared SQLite container", async () => {
		await withTempDir(async (directory) => {
			const databasePath = join(directory, "sessions.sqlite");
			const repo = new SqliteSessionRepo({
				directory,
				databasePath,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const left = await repo.create({ id: "left" }, BACKGROUND_CONTEXT);
			const right = await repo.create({ id: "right" }, BACKGROUND_CONTEXT);

			expect(left.metadata.path).toBe(databasePath);
			expect(right.metadata.path).toBe(databasePath);
			await left.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "left-root", parentId: null, type: "custom", customType: "left" }),
							storedValues.setValue(storedValues.sessionName, "left-name"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			await right.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({
								id: "right-root",
								parentId: null,
								type: "custom",
								customType: "right",
							}),
							storedValues.setValue(storedValues.sessionName, "right-name"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			expect((await repo.list(undefined, BACKGROUND_CONTEXT)).map((metadata) => metadata.id).sort()).toEqual([
				"left",
				"right",
			]);
			expect(await left.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "left-name",
			});
			expect(await right.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "right-name",
			});
			expect((await left.getEntries(["left-root", "right-root"], BACKGROUND_CONTEXT)).has("right-root")).toBe(false);
			expect((await right.getEntries(["left-root", "right-root"], BACKGROUND_CONTEXT)).has("left-root")).toBe(false);

			await Promise.all([left.close(BACKGROUND_CONTEXT), right.close(BACKGROUND_CONTEXT)]);
		});
	});

	it("does not copy usage ledger rows when forking", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							sessionWrites.insertEntry({
								id: "child",
								parentId: "root",
								type: "message",
								message: { role: "user", content: "child", timestamp: 1 },
							}),
							storedValues.setValue(storedValues.branchTip("main"), "child"),
							sessionWrites.insertUsage({
								id: "usage",
								adjustment: false,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			await source.close(BACKGROUND_CONTEXT);
			const fork = await repo.fork(source.metadata, { id: "fork", entryId: "child" }, BACKGROUND_CONTEXT);

			await withDb(fork.metadata.path, (db) => {
				expect(
					sql`SELECT COUNT(*) AS count FROM usage_ledger WHERE session_id = ${"fork"}`.get<{ count: number }>(db),
				).toEqual({ count: 0 });
			});
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		});
	});
});

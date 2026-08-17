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
	it("creates one initialized session file with main lane values", async () => {
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
				expect(sql`SELECT COUNT(*) AS count FROM session`.get<{ count: number }>(db)).toEqual({ count: 1 });
				expect(sql`SELECT message_count, usage_payload, next_seq FROM session`.get(db)).toEqual({
					message_count: 0,
					usage_payload: JSON.stringify({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					}),
					next_seq: 3,
				});
				expect(sql`SELECT namespace, key, seq, value FROM scalar_values ORDER BY seq`.all(db)).toEqual([
					{
						namespace: storedValues.laneLeaf("main").namespace,
						key: "main",
						seq: 1,
						value: "null",
					},
					{
						namespace: storedValues.laneState("main").namespace,
						key: "main",
						seq: 2,
						value: JSON.stringify({ currentOperationId: null, pendingNextRun: [] }),
					},
				]);
				expect(sql`SELECT COUNT(*) AS count FROM list_values`.get(db)).toEqual({ count: 0 });
			});
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
				expect(sql`SELECT COUNT(*) AS count FROM session`.get<{ count: number }>(db)).toEqual({ count: 1 });
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
				leaseBeforeList = sql`SELECT owner_id, fence FROM writer_lease`.all(db);
			});

			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).resolves.toMatchObject([
				{ id: "session", path: metadata.path },
			]);
			await withDb(metadata.path, (db) => {
				expect(sql`SELECT owner_id, fence FROM writer_lease`.all(db)).toEqual(leaseBeforeList);
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
				sql`UPDATE session SET storage_version = ${999}`.run(db);
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
				sql`INSERT INTO writer_lease (owner_id, fence, expires_at_ms) VALUES (${"external"}, ${1}, ${1_000})`.run(
					db,
				);
			});
			await expect(repo.delete(metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already claimed");
			await withDb(metadata.path, (db) => {
				sql`DELETE FROM writer_lease`.run(db);
			});

			await expect(
				repo.delete({ ...metadata, path: join(directory, "missing.sqlite") }, BACKGROUND_CONTEXT),
			).rejects.toThrow();
			await repo.delete(metadata, BACKGROUND_CONTEXT);
			await expect(access(metadata.path)).rejects.toThrow();
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
				sql`INSERT INTO writer_lease (owner_id, fence, expires_at_ms) VALUES (${"external"}, ${1}, ${1_000})`.run(
					db,
				);
			});
			await expect(repo.open(metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already claimed");
		});
	});

	it("forks at a serialized boundary for an open source session", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			const applicationValue = storedValues.value<string>("test.application.value");
			const applicationList = storedValues.list<string>("test.application.list");
			const firstCommit = source.mutate(
				"main",
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							storedValues.setValue(storedValues.laneLeaf("main"), "root"),
							storedValues.setValue(applicationValue, "excluded"),
							storedValues.appendList(applicationList, "excluded"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			const forkPromise = repo.fork(source.metadata, { id: "fork" }, BACKGROUND_CONTEXT);
			const secondCommit = source.mutate(
				"main",
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
							storedValues.setValue(storedValues.laneLeaf("main"), "child"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			const [, fork] = await Promise.all([firstCommit, forkPromise]);
			await secondCommit;

			expect(await fork.getLeafId(BACKGROUND_CONTEXT)).toBe("root");
			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
				"root",
			]);
			expect(await fork.getValue(applicationValue, BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await fork.readList(applicationList, undefined, BACKGROUND_CONTEXT)).toEqual([]);
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		});
	});

	it("forks the whole open tree with every configured lane", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			const configuration = {
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off" as const,
				activeToolNames: [],
			};
			await source.mutate(
				"main",
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							sessionWrites.insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
							sessionWrites.insertEntry({
								id: "sibling",
								parentId: "root",
								type: "custom",
								customType: "sibling",
							}),
							storedValues.setValue(storedValues.laneLeaf("main"), "child"),
							storedValues.setValue(storedValues.laneLeaf("review"), "sibling"),
							storedValues.setValue(storedValues.laneConfig("review"), configuration),
							storedValues.setValue(storedValues.laneState("review"), {
								currentOperationId: null,
								pendingNextRun: [],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			const fork = await repo.fork(source.metadata, { id: "fork", scope: "tree" }, BACKGROUND_CONTEXT);

			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
				"root",
				"child",
				"sibling",
			]);
			expect(await fork.getLeafId(BACKGROUND_CONTEXT)).toBe("child");
			expect(await fork.view("review").getLeafId(BACKGROUND_CONTEXT)).toBe("sibling");
			expect((await fork.getValue(storedValues.laneState("review"), BACKGROUND_CONTEXT))?.value).toEqual({
				currentOperationId: null,
				pendingNextRun: [],
			});

			const branchFork = await repo.fork(source.metadata, { id: "branch", entryId: "root" }, BACKGROUND_CONTEXT);
			expect((await branchFork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
				"root",
			]);
			expect(await branchFork.getLeafId(BACKGROUND_CONTEXT)).toBe("root");
			await Promise.all([
				source.close(BACKGROUND_CONTEXT),
				fork.close(BACKGROUND_CONTEXT),
				branchFork.close(BACKGROUND_CONTEXT),
			]);
		});
	});

	it("forks one branch with scoped values and a zero ledger", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			const applicationValue = storedValues.value<string>("test.application.value");
			const applicationList = storedValues.list<string>("test.application.list");
			await source.mutate(
				"main",
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
							sessionWrites.insertEntry({
								id: "sibling",
								parentId: "root",
								type: "custom",
								customType: "sibling",
							}),
							storedValues.setValue(storedValues.laneLeaf("main"), "child"),
							storedValues.setValue(storedValues.sessionName, "source name"),
							storedValues.setValue(storedValues.entryLabel("root"), "root label"),
							storedValues.setValue(storedValues.entryLabel("sibling"), "sibling label"),
							storedValues.setValue(applicationValue, "excluded"),
							storedValues.appendList(applicationList, "excluded"),
							storedValues.setValue(storedValues.laneLastResult("main"), {
								operationId: "previous",
								kind: "navigation",
								leafId: "child",
								oldLeafId: "root",
								outcome: "completed",
							}),
							storedValues.setValue(storedValues.pendingEntry("pending"), {
								type: "custom",
								customType: "pending",
							}),
							storedValues.setValue(storedValues.operationToolMemo("operation", "invocation", "memo"), true),
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

			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
				"root",
				"child",
			]);
			expect(await fork.getLeafId(BACKGROUND_CONTEXT)).toBe("child");
			expect(await fork.getName(BACKGROUND_CONTEXT)).toBe("source name");
			expect(await fork.getLabel("root", BACKGROUND_CONTEXT)).toBe("root label");
			expect(await fork.getLabel("sibling", BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await fork.getValue(applicationValue, BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await fork.readList(applicationList, undefined, BACKGROUND_CONTEXT)).toEqual([]);
			expect(await fork.getValue(storedValues.laneLastResult("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await fork.getValue(storedValues.pendingEntry("pending"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(
				await fork.getValue(storedValues.operationToolMemo("operation", "invocation", "memo"), BACKGROUND_CONTEXT),
			).toBeUndefined();
			await withDb(fork.metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM usage_ledger`.get<{ count: number }>(db)).toEqual({ count: 0 });
			});
			expect(await fork.getStats(BACKGROUND_CONTEXT)).toEqual({
				messageCount: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		});
	});
});

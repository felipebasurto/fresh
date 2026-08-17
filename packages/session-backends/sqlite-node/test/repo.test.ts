import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	it("creates one initialized session file with main lane registers", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});

			const session = await repo.create({ id: "session" });
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
				expect(sql`SELECT namespace, key, seq, value FROM registers ORDER BY seq`.all(db)).toEqual([
					{ namespace: "lane.leaf", key: "main", seq: 1, value: "null" },
					{
						namespace: "lane.state",
						key: "main",
						seq: 2,
						value: JSON.stringify({ currentOperationId: null, pendingNextRun: [] }),
					},
				]);
			});
			await session.close();
		});
	});

	it("rejects duplicate create without deleting the existing database", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" });
			const { metadata } = session;

			await expect(repo.create({ id: "session" })).rejects.toThrow();
			await withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM session`.get<{ count: number }>(db)).toEqual({ count: 1 });
			});
			await session.close();
		});
	});

	it("lists sessions without changing the writer lease", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" });
			const { metadata } = session;
			let leaseBeforeList: unknown[] = [];
			await withDb(metadata.path, (db) => {
				leaseBeforeList = sql`SELECT owner_id, fence FROM writer_lease`.all(db);
			});

			await expect(repo.list()).resolves.toMatchObject([{ id: "session", path: metadata.path }]);
			await withDb(metadata.path, (db) => {
				expect(sql`SELECT owner_id, fence FROM writer_lease`.all(db)).toEqual(leaseBeforeList);
			});
			await session.close();
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

			await expect(repo.create({ id: "session" })).rejects.toThrow();
			await expect(access(path)).resolves.toBeUndefined();
		});
	});

	it("opens a session through the version gate and rejects a live external writer lease", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const created = await repo.create({ id: "session" });
			const { metadata } = created;
			await created.close();

			const opened = await repo.open(metadata);
			expect(opened.metadata).toMatchObject({ id: "session", path: metadata.path });
			await opened.close();

			await withDb(metadata.path, (db) => {
				sql`INSERT INTO writer_lease (owner_id, fence, expires_at_ms) VALUES (${"external"}, ${1}, ${1_000})`.run(
					db,
				);
			});
			await expect(repo.open(metadata)).rejects.toThrow("already claimed");
		});
	});

	it("forks one branch with scoped facts and a zero ledger", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" });
			await source.mutate("main", (mutator) =>
				mutator.commit({
					writes: [
						{ kind: "entry", entry: { id: "root", parentId: null, type: "custom", customType: "root" } },
						{
							kind: "entry",
							entry: {
								id: "child",
								parentId: "root",
								type: "message",
								message: { role: "user", content: "child", timestamp: 1 },
							},
						},
						{ kind: "entry", entry: { id: "sibling", parentId: "root", type: "custom", customType: "sibling" } },
						{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: "child" },
						{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "source name" },
						{ kind: "register", op: "set", namespace: "fact.label", key: "root", value: "root label" },
						{ kind: "register", op: "set", namespace: "fact.label", key: "sibling", value: "sibling label" },
						{
							kind: "usage",
							row: {
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
							},
						},
					],
				}),
			);

			const fork = await repo.fork(source.metadata, { id: "fork", entryId: "child" });

			expect((await fork.findEntries({ order: "asc" })).map((entry) => entry.id)).toEqual(["root", "child"]);
			expect(await fork.getLeafId()).toBe("child");
			expect(await fork.getName()).toBe("source name");
			expect(await fork.getLabel("root")).toBe("root label");
			expect(await fork.getLabel("sibling")).toBeUndefined();
			await withDb(fork.metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM usage_ledger`.get<{ count: number }>(db)).toEqual({ count: 0 });
			});
			expect(await fork.getStats()).toEqual({
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
			await Promise.all([source.close(), fork.close()]);
		});
	});
});

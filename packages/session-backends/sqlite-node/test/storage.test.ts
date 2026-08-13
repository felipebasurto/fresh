import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, type SqliteDatabase, SqliteStorage, sql } from "../src/index.ts";
import { applyInitialSchema } from "../src/sqlite/migrations.ts";

async function withStorage<T>(run: (storage: SqliteStorage, db: SqliteDatabase) => Promise<T>): Promise<T> {
	const db = await createNodeSqliteFactory().open(":memory:");
	try {
		await applyInitialSchema(db);
		const storage = new SqliteStorage(db, { now: () => 1_700_000_000_000 });
		return await run(storage, db);
	} finally {
		db.close();
	}
}

function explainQueryPlan(db: SqliteDatabase, query: string, ...params: unknown[]): string[] {
	return db
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all<{ detail: string }>(...params)
		.map((row) => row.detail);
}

function expectBranchPlan(plan: string[]): void {
	expect(plan.some((detail) => detail.includes("SEARCH b USING COVERING INDEX ix_be_seq"))).toBe(true);
	expect(plan.some((detail) => detail.includes("SEARCH e USING PRIMARY KEY"))).toBe(true);
	expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
	expect(plan.some((detail) => detail.includes("SCAN e"))).toBe(false);
}

describe("SqliteStorage", () => {
	it("gets entries by requested id order", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${"first"}, ${null}, ${1}, ${"custom"}, ${"note"}, ${10}, ${JSON.stringify({ data: { value: 1 } })}),
					(${"second"}, ${"first"}, ${2}, ${"message"}, ${null}, ${11}, ${JSON.stringify({ message: { role: "user", content: "hi", timestamp: 11 } })})`.run(
				db,
			);

			const entries = await storage.getEntries(["second", "missing", "first"]);

			expect([...entries.keys()]).toEqual(["second", "first"]);
			expect(entries.get("second")).toMatchObject({ id: "second", type: "message", parentId: "first" });
			expect(entries.get("first")).toMatchObject({ id: "first", type: "custom", customType: "note" });
		});
	});

	it("scans decoded entries with filters and sequence bounds", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${"one"}, ${null}, ${1}, ${"custom"}, ${"note"}, ${10}, ${JSON.stringify({ data: 1 })}),
					(${"two"}, ${"one"}, ${2}, ${"message"}, ${null}, ${11}, ${JSON.stringify({ message: { role: "user", content: "two", timestamp: 11 } })}),
					(${"three"}, ${"two"}, ${3}, ${"custom"}, ${"note"}, ${12}, ${JSON.stringify({ data: 3 })})`.run(db);

			expect(
				(await storage.scanEntries({ order: "desc", type: "custom", fromSeq: 2 })).map((entry) => entry.id),
			).toEqual(["three"]);
			expect(
				(await storage.scanEntries({ order: "asc", customType: "note", limit: 2 })).map((entry) => entry.id),
			).toEqual(["one", "three"]);
		});
	});

	it("scans branch entries through materialized branch segments", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${"compact"}, ${"root"}, ${2}, ${"compaction"}, ${null}, ${11}, ${JSON.stringify({ summary: "s", retainedTail: [], tokensBefore: 1, fromHook: false })}),
					(${"old"}, ${"compact"}, ${3}, ${"message"}, ${null}, ${12}, ${JSON.stringify({ message: { role: "assistant", content: "old", timestamp: 12 } })}),
					(${"custom"}, ${"old"}, ${4}, ${"custom"}, ${"note"}, ${13}, ${JSON.stringify({ data: 4 })}),
					(${"leaf"}, ${"custom"}, ${5}, ${"message"}, ${null}, ${14}, ${JSON.stringify({ message: { role: "user", content: "leaf", timestamp: 14 } })})`.run(
				db,
			);
			sql`INSERT INTO branch_meta (branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES
					(${"base"}, ${"compact"}, ${2}, ${null}, ${null}),
					(${"new"}, ${"leaf"}, ${5}, ${"base"}, ${2})`.run(db);
			sql`INSERT INTO branch_entries (branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${"base"}, ${"root"}, ${1}, ${"message"}),
					(${"base"}, ${"compact"}, ${2}, ${"compaction"}),
					(${"new"}, ${"old"}, ${3}, ${"message"}),
					(${"new"}, ${"custom"}, ${4}, ${"custom"}),
					(${"new"}, ${"leaf"}, ${5}, ${"message"})`.run(db);

			expect(
				(await storage.scanBranch({ start: "leaf", stopAtType: "compaction", limit: 2 })).map((entry) => entry.id),
			).toEqual(["leaf", "custom"]);
			expect(
				(
					await storage.scanBranch({ start: "leaf", order: "oldestFirst", type: "message", cursor: { seq: 1 } })
				).map((entry) => entry.id),
			).toEqual(["old", "leaf"]);
		});
	});

	it("resolves a branch segment that physically contains the start entry", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${"base-tip"}, ${"root"}, ${2}, ${"message"}, ${null}, ${11}, ${JSON.stringify({ message: { role: "assistant", content: "base", timestamp: 11 } })}),
					(${"new-tip"}, ${"base-tip"}, ${3}, ${"message"}, ${null}, ${12}, ${JSON.stringify({ message: { role: "user", content: "new", timestamp: 12 } })})`.run(
				db,
			);
			sql`INSERT INTO branch_meta (branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES
					(${"aaa-new"}, ${"new-tip"}, ${3}, ${"zzz-base"}, ${2}),
					(${"zzz-base"}, ${"base-tip"}, ${2}, ${null}, ${null})`.run(db);
			sql`INSERT INTO branch_entries (branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${"aaa-new"}, ${"new-tip"}, ${3}, ${"message"}),
					(${"zzz-base"}, ${"root"}, ${1}, ${"message"}),
					(${"zzz-base"}, ${"base-tip"}, ${2}, ${"message"})`.run(db);

			expect(
				(await storage.scanBranch({ start: "base-tip", order: "oldestFirst" })).map((entry) => entry.id),
			).toEqual(["root", "base-tip"]);
		});
	});

	it("applies branch stop boundaries across base segments before filtering", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${"compact"}, ${"root"}, ${2}, ${"compaction"}, ${null}, ${11}, ${JSON.stringify({ summary: "s", retainedTail: [], tokensBefore: 1, fromHook: false })}),
					(${"after"}, ${"compact"}, ${3}, ${"message"}, ${null}, ${12}, ${JSON.stringify({ message: { role: "assistant", content: "after", timestamp: 12 } })}),
					(${"leaf"}, ${"after"}, ${4}, ${"custom"}, ${"note"}, ${13}, ${JSON.stringify({ data: 4 })})`.run(db);
			sql`INSERT INTO branch_meta (branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES
					(${"base"}, ${"compact"}, ${2}, ${null}, ${null}),
					(${"new"}, ${"leaf"}, ${4}, ${"base"}, ${2})`.run(db);
			sql`INSERT INTO branch_entries (branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${"base"}, ${"root"}, ${1}, ${"message"}),
					(${"base"}, ${"compact"}, ${2}, ${"compaction"}),
					(${"new"}, ${"after"}, ${3}, ${"message"}),
					(${"new"}, ${"leaf"}, ${4}, ${"custom"})`.run(db);

			expect(
				(await storage.scanBranch({ start: "leaf", stopAtType: "compaction" })).map((entry) => entry.id),
			).toEqual(["leaf", "after", "compact"]);
			expect(
				(await storage.scanBranch({ start: "leaf", stopAtType: "compaction", type: "message" })).map(
					(entry) => entry.id,
				),
			).toEqual(["after"]);
		});
	});

	it("uses branch_entries as the outer scan for branch payload queries", async () => {
		await withStorage(async (_storage, db) => {
			const plan = explainQueryPlan(
				db,
				`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp, e.payload
				FROM branch_entries b
				CROSS JOIN entries e ON e.id = b.entry_id
				WHERE b.branch_id = ? AND b.entry_seq > ? AND b.entry_seq <= ?
				ORDER BY b.entry_seq DESC LIMIT ?`,
				"main",
				0,
				10,
				2,
			);

			expectBranchPlan(plan);
		});
	});

	it("scans branch structure without payloads", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${"custom"}, ${"root"}, ${2}, ${"custom"}, ${"note"}, ${11}, ${JSON.stringify({ data: 2 })})`.run(db);
			sql`INSERT INTO branch_meta (branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES (${"main"}, ${"custom"}, ${2}, ${null}, ${null})`.run(db);
			sql`INSERT INTO branch_entries (branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${"main"}, ${"root"}, ${1}, ${"message"}),
					(${"main"}, ${"custom"}, ${2}, ${"custom"})`.run(db);

			expect(await storage.scanBranchStructure({ start: "custom", customType: "note" })).toEqual([
				{
					id: "custom",
					parentId: "root",
					seq: 2,
					timestamp: 11,
					type: "custom",
					customType: "note",
				},
			]);
		});
	});

	it("uses branch_entries as the outer scan for branch structure queries", async () => {
		await withStorage(async (_storage, db) => {
			const plan = explainQueryPlan(
				db,
				`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp
				FROM branch_entries b
				CROSS JOIN entries e ON e.id = b.entry_id
				WHERE b.branch_id = ? AND b.entry_seq > ? AND b.entry_seq <= ?
				ORDER BY b.entry_seq ASC LIMIT ?`,
				"main",
				0,
				10,
				2,
			);

			expectBranchPlan(plan);
		});
	});

	it("scans decoded usage rows with sequence bounds", async () => {
		await withStorage(async (storage, db) => {
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			};
			sql`INSERT INTO usage_ledger (id, seq, entry_id, adjustment, usage, details)
				VALUES
					(${"u1"}, ${1}, ${"e1"}, ${0}, ${JSON.stringify(usage)}, ${null}),
					(${"u2"}, ${2}, ${null}, ${1}, ${JSON.stringify(usage)}, ${JSON.stringify({ reason: "adjust" })}),
					(${"u3"}, ${3}, ${"e3"}, ${0}, ${JSON.stringify(usage)}, ${null})`.run(db);

			expect(await storage.scanUsage({ fromSeq: 2, order: "asc", limit: 1 })).toEqual([
				{ id: "u2", seq: 2, usage, adjustment: true, details: { reason: "adjust" } },
			]);
			expect((await storage.scanUsage({ toSeq: 2, order: "desc" })).map((row) => row.id)).toEqual(["u2", "u1"]);
		});
	});

	it("gets maintained session stats", async () => {
		await withStorage(async (storage, db) => {
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			};
			sql`INSERT INTO session
				(created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
				VALUES (${1}, ${null}, ${1}, ${null}, ${2}, ${JSON.stringify(usage)}, ${3})`.run(db);

			expect(await storage.getStats()).toEqual({ messageCount: 2, usage });
		});
	});

	it("gets a decoded register by namespace and key", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO registers (namespace, key, seq, value)
				VALUES (${"fact.custom"}, ${"state"}, ${1}, ${JSON.stringify({ ready: true })})`.run(db);

			expect(await storage.getRegister("fact.custom", "state")).toEqual({
				namespace: "fact.custom",
				key: "state",
				seq: 1,
				value: { ready: true },
			});
			expect(await storage.getRegister("fact.custom", "missing")).toBeUndefined();
		});
	});

	it("lists decoded registers by namespace and key prefix", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO registers (namespace, key, seq, value)
				VALUES
					(${"fact.custom"}, ${"app:one"}, ${1}, ${JSON.stringify(1)}),
					(${"fact.custom"}, ${"app:two"}, ${2}, ${JSON.stringify(2)}),
					(${"fact.custom"}, ${"other"}, ${3}, ${JSON.stringify(3)}),
					(${"fact.name"}, ${""}, ${4}, ${JSON.stringify("name")})`.run(db);

			expect(await storage.listRegisters("fact.custom", "app:")).toEqual([
				{ namespace: "fact.custom", key: "app:one", seq: 1, value: 1 },
				{ namespace: "fact.custom", key: "app:two", seq: 2, value: 2 },
			]);
		});
	});
});

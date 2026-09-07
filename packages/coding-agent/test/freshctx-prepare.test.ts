import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	buildTextReadObservation,
	type FreshCtxReadObservation,
	sha256Hex,
} from "../src/core/freshctx/observations.ts";
import {
	classifyRevalidation,
	FreshCtxRequestPreparer,
	planTraceFields,
	revisionForText,
	splitProjectionSections,
} from "../src/core/freshctx/prepare-context.ts";
import type { FreshCtxClient } from "../src/core/freshctx/runtime.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function textObs(obsId: string, text: string): FreshCtxReadObservation {
	const buffer = Buffer.from(text, "utf-8");
	const allLines = text.split("\n");
	return buildTextReadObservation({
		obsId,
		absolutePath: `/work/${obsId}.txt`,
		cwd: "/work",
		buffer,
		allLines,
		startLine: 0,
		shownLineCount: allLines.length,
		totalFileLines: allLines.length,
		truncated: false,
		truncatedBy: null,
		userLimited: false,
		firstLineExceedsLimit: false,
		symlink: false,
	});
}

function toolPayload(entries: Array<{ id: string; content: unknown }>): Record<string, unknown> {
	return {
		model: "fixture",
		messages: [
			{
				role: "assistant",
				content: null,
				tool_calls: entries.map((entry) => ({
					id: entry.id,
					type: "function",
					function: { name: "read", arguments: "{}" },
				})),
			},
			...entries.map((entry) => ({ role: "tool", tool_call_id: entry.id, content: entry.content })),
			{ role: "user", content: "go" },
		],
	};
}

/** Scriptable fake with a mutable disk and fault flags. */
class StubServer implements FreshCtxClient {
	readonly calls: string[] = [];
	readonly requestIds: string[] = [];
	readonly disk = new Map<string, string>();
	beforeCommit: (() => void) | null = null;
	private readonly observed = new Map<string, { path: string; revision: string }>();
	private readonly refs = new Map<string, Array<{ path: string; revision: string }>>();
	private planSeq = 0;
	failNextCommits = 0;
	corruptProjection = false;
	malformedSelected = false;
	extraReplacements: Array<{ resultId: string; expectedSha256: string; marker: string }> = [];
	wrongExpectationFor: string | null = null;

	async request(op: string, fields: Record<string, unknown> = {}, _signal?: AbortSignal): Promise<unknown> {
		this.calls.push(op);
		if (op === "observe") {
			const content = Buffer.from(fields.content_utf8_base64 as string, "base64");
			const path = fields.path as string;
			this.observed.set(fields.result_id as string, {
				path,
				revision: `sha256:${sha256Hex(content)}`,
			});
			return { result_id: fields.result_id, unit_id: `unit:${path}`, marker: `[unit:${path}]`, idempotent: false };
		}
		if (op === "prepare") {
			const resultIds = fields.result_ids as string[];
			this.requestIds.push(fields.request_id as string);
			const replacements: Array<{ result_id: string; expected_sha256: string; marker: string }> = [];
			const selected: string[] = [];
			const refs: Array<{ path: string; revision: string }> = [];
			const parts: string[] = [];
			for (const resultId of resultIds) {
				const obs = this.observed.get(resultId);
				if (!obs) continue;
				const expected =
					this.wrongExpectationFor === resultId ? "sha256:00000000000000000000000000000000" : obs.revision;
				replacements.push({ result_id: resultId, expected_sha256: expected, marker: `[unit:${obs.path}]` });
				const current = this.disk.get(obs.path) ?? "";
				refs.push({ path: obs.path, revision: `sha256:${sha256Hex(Buffer.from(current, "utf-8"))}` });
				parts.push(`--- ${obs.path} ---\n${current}`);
				selected.push(`unit:${obs.path}`);
			}
			for (const extra of this.extraReplacements) {
				replacements.push({
					result_id: extra.resultId,
					expected_sha256: extra.expectedSha256,
					marker: extra.marker,
				});
			}
			const projection = parts.join("\n");
			const sent = this.corruptProjection ? `${projection}\ncorrupted` : projection;
			const planId = `plan-${++this.planSeq}`;
			this.refs.set(planId, refs);
			const files = [...new Set(refs.map((ref) => ref.path))].map((path) => ({
				path,
				bytes: Buffer.byteLength(this.disk.get(path) ?? "", "utf-8"),
			}));
			const whole_file_bytes = files.reduce((sum, file) => sum + file.bytes, 0);
			return {
				plan_id: planId,
				replacements,
				selected: this.malformedSelected ? [{ unit_id: "unit:x" }] : selected,
				omitted: [],
				projection_utf8_base64: Buffer.from(sent, "utf-8").toString("base64"),
				projection_sha256: revisionForText(projection),
				selection_granularity: "region",
				whole_file_equivalent: { files, whole_file_bytes },
			};
		}
		if (op === "commit") {
			this.beforeCommit?.();
			if (this.failNextCommits > 0) {
				this.failNextCommits -= 1;
				throw Object.assign(new Error("changed during commit"), { code: "stale_plan" });
			}
			const refs = this.refs.get(fields.plan_id as string) ?? [];
			for (const ref of refs) {
				const current = this.disk.get(ref.path) ?? "";
				if (`sha256:${sha256Hex(Buffer.from(current, "utf-8"))}` !== ref.revision) {
					throw Object.assign(new Error("changed during commit"), { code: "stale_plan" });
				}
			}
			return { applied: true };
		}
		if (op === "recover") {
			const unitId = fields.unit_id as string;
			const path = unitId.startsWith("unit:") ? unitId.slice("unit:".length) : null;
			const current = path !== null ? (this.disk.get(path) ?? null) : null;
			if (current === null) {
				throw Object.assign(new Error("unknown unit"), { code: "unknown_unit" });
			}
			if (fields.revision !== `sha256:${sha256Hex(Buffer.from(current, "utf-8"))}`) {
				throw Object.assign(new Error("unknown revision"), { code: "unknown_revision" });
			}
			return {
				unit_id: unitId,
				revision: fields.revision,
				content_utf8_base64: Buffer.from(current, "utf-8").toString("base64"),
			};
		}
		throw new Error(`unknown op ${op}`);
	}
}

describe("FreshCtxRequestPreparer", () => {
	it("replaces tracked results with markers and appends one fresh projection", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "RATE = 10\n");
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "read_1", content: "RATE = 10\n" }]);
		const before = structuredClone(original);
		const result = (await preparer.prepare(original, [textObs("read_1", "RATE = 10\n")])) as Record<string, unknown>;
		expect(server.calls).toEqual(["observe", "prepare", "commit"]);
		expect(original).toEqual(before);
		const messages = result.messages as Array<Record<string, unknown>>;
		expect(messages).toHaveLength(4);
		expect(messages[1]).toMatchObject({ role: "tool", tool_call_id: "read_1", content: "[unit:read_1.txt]" });
		expect(messages[3]).toMatchObject({ role: "user" });
		expect(String(messages[3].content)).toContain("RATE = 10");
	});

	it("serves current disk bytes when the file changed after the read", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "RATE = 10\n");
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "read_1", content: "RATE = 10\n" }]);
		server.disk.set("read_1.txt", "RATE = 20\n");
		const result = (await preparer.prepare(original, [textObs("read_1", "RATE = 10\n")])) as Record<string, unknown>;
		const messages = result.messages as Array<Record<string, unknown>>;
		expect(String(messages[3].content)).toContain("RATE = 20");
		expect(JSON.stringify(messages)).not.toContain("RATE = 10");
	});

	it("blocks tampered results (and duplicates) with zero server contact", async () => {
		const server = new StubServer();
		const preparer = new FreshCtxRequestPreparer(server);
		const tampered = toolPayload([{ id: "read_1", content: "RATE = 10\nchanged by another extension" }]);
		await expect(preparer.prepare(tampered, [textObs("read_1", "RATE = 10\n")])).rejects.toMatchObject({
			name: "FreshCtxBlockedError",
			code: "tampered-result",
		});
		expect(server.calls).toEqual([]);
		const duplicate = toolPayload([
			{ id: "read_1", content: "RATE = 10\n" },
			{ id: "read_1", content: "RATE = 10\n" },
		]);
		await expect(preparer.prepare(duplicate, [textObs("read_1", "RATE = 10\n")])).rejects.toMatchObject({
			code: "invalid-payload",
		});
		expect(server.calls).toEqual([]);
	});

	it("reconstructs truncated reads through their exact notice", async () => {
		const server = new StubServer();
		const dir = mkdtempSync(join(tmpdir(), "pi-freshctx-prepare-"));
		tempDirs.push(dir);
		const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		const text = `${lines.join("\n")}\n`;
		writeFileSync(join(dir, "ten.txt"), text);
		server.disk.set("ten.txt", text);
		// Real read tool output: proves notice derivation matches read.ts exactly.
		const definition = createReadToolDefinition(dir);
		const read = await definition.execute(
			"read_1",
			{ path: "ten.txt", offset: 1, limit: 3 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const content = read.content[0];
		if (content.type !== "text" || !read.details?.freshctxObs) throw new Error("read fixture failed");
		expect(content.text).toContain("more lines in file. Use offset=4 to continue.]");
		const original = toolPayload([{ id: "read_1", content: content.text }]);
		const result = (await preparer(server).prepare(original, [read.details.freshctxObs])) as Record<string, unknown>;
		const messages = result.messages as Array<Record<string, unknown>>;
		expect(messages[1]).toMatchObject({ content: "[unit:ten.txt]" });
	});

	it("leaves non-string and untracked results historical without server contact", async () => {
		const server = new StubServer();
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "img_1", content: [{ type: "image", data: "x", mimeType: "image/png" }] }]);
		const result = await preparer.prepare(original, []);
		expect(result).toBe(original);
		expect(server.calls).toEqual([]);
	});

	it("never applies server markers to unverified results", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "code\n");
		server.extraReplacements.push({ resultId: "bash_1", expectedSha256: revisionForText("out"), marker: "[bogus]" });
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([
			{ id: "read_1", content: "code\n" },
			{ id: "bash_1", content: "out" },
		]);
		const result = (await preparer.prepare(original, [textObs("read_1", "code\n")])) as Record<string, unknown>;
		const messages = result.messages as Array<Record<string, unknown>>;
		expect(messages[1]).toMatchObject({ content: "[unit:read_1.txt]" });
		expect(messages[2]).toMatchObject({ content: "out" });
	});

	it("blocks on expectation mismatch and corrupt projections without mutating", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "code\n");
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "read_1", content: "code\n" }]);
		const before = structuredClone(original);
		server.wrongExpectationFor = "read_1";
		await expect(preparer.prepare(original, [textObs("read_1", "code\n")])).rejects.toMatchObject({
			code: "unexpected-replacement",
		});
		expect(original).toEqual(before);
		server.wrongExpectationFor = null;
		server.corruptProjection = true;
		await expect(preparer.prepare(original, [textObs("read_1", "code\n")])).rejects.toMatchObject({
			code: "invalid-plan",
		});
		expect(original).toEqual(before);
	});

	it("retries a stale commit once with a new plan, then blocks", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "v1\n");
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "read_1", content: "v1\n" }]);
		server.failNextCommits = 1;
		const result = (await preparer.prepare(original, [textObs("read_1", "v1\n")])) as Record<string, unknown>;
		expect(server.calls).toEqual(["observe", "prepare", "commit", "prepare", "commit"]);
		expect(server.requestIds).toHaveLength(2);
		expect(server.requestIds[0]).not.toBe(server.requestIds[1]);
		expect(JSON.stringify(result)).toContain("[unit:read_1.txt]");
		expect(preparer.drainResolvedUnits()).toEqual([
			{ resultId: "read_1", unitId: "unit:read_1.txt", revision: revisionForText("v1\n"), path: "read_1.txt" },
		]);
		expect(preparer.drainResolvedUnits()).toEqual([]);
		server.failNextCommits = 2;
		await expect(preparer.prepare(original, [textObs("read_1", "v1\n")])).rejects.toMatchObject({
			code: "commit-failed",
		});
	});

	it("retries when the file changes between prepare and commit", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "v1\n");
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "read_1", content: "v1\n" }]);
		server.beforeCommit = () => {
			server.beforeCommit = null;
			server.disk.set("read_1.txt", "v2\n");
		};
		const result = (await preparer.prepare(original, [textObs("read_1", "v1\n")])) as Record<string, unknown>;
		expect(server.calls).toEqual(["observe", "prepare", "commit", "prepare", "commit"]);
		expect(JSON.stringify(result)).toContain("v2");
	});

	it("blocks exhausted budgets before any server contact", async () => {
		const server = new StubServer();
		const tiny = new FreshCtxRequestPreparer(server, { budgetBytes: 10 });
		const original = toolPayload([{ id: "read_1", content: "code\n" }]);
		await expect(tiny.prepare(original, [textObs("read_1", "code\n")])).rejects.toMatchObject({
			code: "budget-exhausted",
		});
		expect(server.calls).toEqual([]);
		const capped = new FreshCtxRequestPreparer(server, { maxRequestBytes: 10 });
		await expect(capped.prepare(original, [textObs("read_1", "code\n")])).rejects.toMatchObject({
			code: "budget-exhausted",
		});
		expect(server.calls).toEqual(["observe", "prepare"]);
	});

	it("blocks estimated token overruns before commit", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "code\n");
		const original = toolPayload([{ id: "read_1", content: "code\n" }]);
		const capped = new FreshCtxRequestPreparer(server, { maxRequestTokens: 10, reservedOutputTokens: 1024 });
		await expect(capped.prepare(original, [textObs("read_1", "code\n")])).rejects.toMatchObject({
			code: "budget-exhausted",
		});
		expect(server.calls).toEqual(["observe", "prepare"]);
		const roomy = new FreshCtxRequestPreparer(server, { maxRequestTokens: 100000, reservedOutputTokens: 1024 });
		const result = (await roomy.prepare(original, [textObs("read_1", "code\n")])) as Record<string, unknown>;
		expect(JSON.stringify(result)).toContain("[unit:read_1.txt]");
	});

	it("blocks malformed selected units without mutating", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "code\n");
		server.malformedSelected = true;
		const preparer = new FreshCtxRequestPreparer(server);
		const original = toolPayload([{ id: "read_1", content: "code\n" }]);
		const before = structuredClone(original);
		await expect(preparer.prepare(original, [textObs("read_1", "code\n")])).rejects.toMatchObject({
			code: "invalid-plan",
		});
		expect(original).toEqual(before);
	});

	function preparer(server: StubServer): FreshCtxRequestPreparer {
		return new FreshCtxRequestPreparer(server);
	}
});

describe("classifyRevalidation", () => {
	function plan(projection: string, selected = ["u_1"], resultId = "read_1") {
		return {
			planId: "plan-1",
			replacements: [{ resultId, expectedSha256: "sha256:x", marker: "[u_1]" }],
			selected,
			omitted: [],
			projection,
			selectionGranularity: "region" as const,
			unitStates: {},
			wholeFileEquivalent: null,
		};
	}

	it("is STABLE when the projection carries the observed referent", () => {
		const verdict = classifyRevalidation(plan("f.py:region:8bytes\nRATE = 10\n"), [
			{ resultId: "read_1", shownText: "RATE = 10", diskText: "RATE = 10\n" },
		]);
		expect(verdict).toEqual({ outcome: "STABLE", missingReferents: [] });
	});

	it("is WRONG when the referent survives on disk but the projection drops it", () => {
		const verdict = classifyRevalidation(plan("f.py:region:8bytes\n# prefix\n"), [
			{ resultId: "read_1", shownText: "RATE = 10", diskText: "# prefix\nRATE = 10\n" },
		]);
		expect(verdict).toEqual({ outcome: "WRONG", missingReferents: ["read_1"] });
	});

	it("passes a faithful refresh when the referent changed on disk", () => {
		const verdict = classifyRevalidation(plan("f.py:region:8bytes\nRATE = 99\n"), [
			{ resultId: "read_1", shownText: "RATE = 10", diskText: "RATE = 99\n" },
		]);
		expect(verdict.outcome).toBe("STABLE");
	});

	it("accepts real-engine envelopes that suffix the byte count with 'bytes'", () => {
		const projection = "config.py:region:26bytes\nTARGET_RATE = 12\nOTHER = 1\n";
		const sections = splitProjectionSections(projection);
		expect(sections.get("config.py")).toBe("TARGET_RATE = 12\nOTHER = 1\n");
		const verdict = classifyRevalidation(
			{
				planId: "plan-1",
				replacements: [{ resultId: "read_1", expectedSha256: "sha256:x", marker: "[u_1]" }],
				selected: ["u_1"],
				omitted: [],
				projection,
				selectionGranularity: "region" as const,
				unitStates: {},
				wholeFileEquivalent: null,
			},
			[
				{
					resultId: "read_1",
					shownText: "TARGET_RATE = 10\nOTHER = 1",
					diskText: "TARGET_RATE = 12\nOTHER = 1\n",
					projectionSection: sections.get("config.py") ?? null,
				},
			],
		);
		expect(verdict.outcome).toBe("STABLE");
	});

	it("does not treat bare count headers as envelopes (fail-closed)", () => {
		// Real freshctx rejects `path:kind:N` without the literal `bytes` suffix.
		expect(splitProjectionSections("config.py:region:26\nTARGET_RATE = 12\n").size).toBe(0);
		expect(splitProjectionSections("config.py:region:26byte\nTARGET_RATE = 12\n").size).toBe(0);
		expect(splitProjectionSections("config.py:region:26BYTES\nTARGET_RATE = 12\n").size).toBe(0);
		const verdict = classifyRevalidation(plan("config.py:region:26\nTARGET_RATE = 12\n"), [
			{
				resultId: "read_1",
				shownText: "TARGET_RATE = 10",
				diskText: "TARGET_RATE = 12\n",
			},
		]);
		// Bare header line is body text not present on disk → refresh check fails closed.
		expect(verdict.outcome).toBe("WRONG");
	});

	it("blocks an unrelated current region after the referent changed", () => {
		const disk = "# prefix\nRATE = 99\nother\n";
		const verdict = classifyRevalidation(plan("f.py:region:8bytes\n# prefix\n"), [
			{ resultId: "read_1", shownText: "RATE = 10", diskText: disk },
		]);
		expect(verdict).toEqual({ outcome: "WRONG", missingReferents: ["read_1"] });
	});

	it("blocks an unrelated refreshed region that only shares a generic return key", () => {
		const disk = "def f():\n    return 1\ndef g():\n    return 2\n";
		const verdict = classifyRevalidation(plan("f.py:region:12bytes\n    return 2\n"), [
			{ resultId: "read_1", shownText: "    return 1", diskText: disk },
		]);
		expect(verdict).toEqual({ outcome: "WRONG", missingReferents: ["read_1"] });
	});

	it("is UNCHECKED when disk text is unavailable and projection misses", () => {
		const verdict = classifyRevalidation(plan("f.py:region:5bytes\nOTHER\n"), [
			{ resultId: "read_1", shownText: "RATE = 10", diskText: null },
		]);
		expect(verdict.outcome).toBe("UNCHECKED");
	});

	it("checks refresh per file section in multi-file projections", () => {
		const projection = "a.py:region:7bytes\nNEW_A = 1\nb.py:region:7bytes\nNEW_B = 2\n";
		const sections = splitProjectionSections(projection);
		expect(sections.get("a.py")).toBe("NEW_A = 1");
		// Referent from a.py changed on disk; the b.py section must not fail it.
		const verdict = classifyRevalidation(
			{
				planId: "plan-1",
				replacements: [{ resultId: "read_a", expectedSha256: "sha256:x", marker: "[u_a]" }],
				selected: ["u_a"],
				omitted: [],
				projection,
				selectionGranularity: "region" as const,
				unitStates: {},
				wholeFileEquivalent: null,
			},
			[
				{
					resultId: "read_a",
					shownText: "OLD_A = 0",
					diskText: "NEW_A = 1\n",
					projectionSection: sections.get("a.py") ?? null,
				},
			],
		);
		expect(verdict.outcome).toBe("STABLE");
	});

	it("blocks WRONG plans before HTTP via drift-blocked", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "RATE = 10\n");
		const preparer = new FreshCtxRequestPreparer(server, {
			readDiskText: () => "# prefix\nRATE = 10\n",
		});
		// Fake projects current disk (full file) which still contains the
		// referent here; force drift by projecting stale bytes instead.
		const observing = server.request.bind(server);
		server.request = async (op: string, fields: Record<string, unknown> = {}, signal?: AbortSignal) => {
			const response = (await observing(op, fields, signal)) as Record<string, unknown>;
			if (op === "prepare") {
				const stale = "--- read_1.txt ---\n# prefix\n";
				return {
					...response,
					projection_utf8_base64: Buffer.from(stale, "utf-8").toString("base64"),
					projection_sha256: revisionForText(stale),
				};
			}
			return response;
		};
		const original = toolPayload([{ id: "read_1", content: "RATE = 10\n" }]);
		await expect(preparer.prepare(original, [textObs("read_1", "RATE = 10\n")])).rejects.toMatchObject({
			code: "drift-blocked",
		});
		expect(preparer.revalidationStats()).toMatchObject({ total: 1, driftBlocked: 1 });
		expect(preparer.lastRevalidation()?.outcome).toBe("WRONG");
		expect(preparer.lastCommittedPlan()?.planId).toMatch(/^plan-/);
		expect(preparer.lastCommittedPlan()?.selectionGranularity).toBe("region");
		expect(preparer.lastPrepareRequestIndex()).toBe(1);
		expect(preparer.lastObservedResultIds()).toContain("read_1");
		const trace = planTraceFields(preparer.lastCommittedPlan()!, {
			prepareRequestIndex: preparer.lastPrepareRequestIndex(),
			observedResultIds: preparer.lastObservedResultIds(),
			selectedFiles: preparer.lastSelectedFiles(),
		});
		expect(trace.planId).toBe(preparer.lastCommittedPlan()!.planId);
		expect(trace.prepareRequestIndex).toBe(1);
		expect(trace.regionBytes).toBeGreaterThan(0);
		expect(trace.selectionGranularity).toBe("region");
		expect(trace.wholeFileEquivalentBytes).toBeGreaterThan(0);
		expect(trace.selectedFiles.length).toBeGreaterThan(0);
	});

	it("rejects malformed whole_file_equivalent byte totals", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "RATE = 10\n");
		const observing = server.request.bind(server);
		server.request = async (op: string, fields: Record<string, unknown> = {}, signal?: AbortSignal) => {
			const response = (await observing(op, fields, signal)) as Record<string, unknown>;
			if (op === "prepare") {
				return {
					...response,
					whole_file_equivalent: {
						files: [{ path: "read_1.txt", bytes: 10 }],
						whole_file_bytes: 99,
					},
				};
			}
			return response;
		};
		const preparer = new FreshCtxRequestPreparer(server, {
			readDiskText: () => "RATE = 10\n",
		});
		await expect(
			preparer.prepare(toolPayload([{ id: "read_1", content: "RATE = 10\n" }]), [textObs("read_1", "RATE = 10\n")]),
		).rejects.toMatchObject({ code: "invalid-plan" });
	});

	it("rejects non-integer whole_file_equivalent bytes", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "RATE = 10\n");
		const observing = server.request.bind(server);
		server.request = async (op: string, fields: Record<string, unknown> = {}, signal?: AbortSignal) => {
			const response = (await observing(op, fields, signal)) as Record<string, unknown>;
			if (op === "prepare") {
				return {
					...response,
					whole_file_equivalent: {
						files: [{ path: "read_1.txt", bytes: 10.5 }],
						whole_file_bytes: 10.5,
					},
				};
			}
			return response;
		};
		const preparer = new FreshCtxRequestPreparer(server, {
			readDiskText: () => "RATE = 10\n",
		});
		await expect(
			preparer.prepare(toolPayload([{ id: "read_1", content: "RATE = 10\n" }]), [textObs("read_1", "RATE = 10\n")]),
		).rejects.toMatchObject({ code: "invalid-plan" });
	});

	it("clears prior verdict metadata at the start of prepare", async () => {
		const server = new StubServer();
		server.disk.set("read_1.txt", "RATE = 10\n");
		const preparer = new FreshCtxRequestPreparer(server, {
			readDiskText: () => "RATE = 10\n",
		});
		await preparer.prepare(toolPayload([{ id: "read_1", content: "RATE = 10\n" }]), [
			textObs("read_1", "RATE = 10\n"),
		]);
		expect(preparer.lastRevalidation()?.outcome).toBe("STABLE");
		expect(preparer.lastCommittedPlan()?.planId).toMatch(/^plan-/);
		await preparer.prepare(toolPayload([]), []);
		expect(preparer.lastRevalidation()).toBeNull();
		expect(preparer.lastCommittedPlan()).toBeNull();
	});
});

describe("planTraceFields", () => {
	it("records region and whole-file bytes at plan time with prepare index", () => {
		const projection = "f.py:region:8bytes\nRATE = 10\n";
		const trace = planTraceFields(
			{
				planId: "p_1",
				replacements: [{ resultId: "read_1", expectedSha256: "sha256:x", marker: "[u_1]" }],
				selected: ["u_1"],
				omitted: [],
				projection,
				selectionGranularity: "region",
				unitStates: { u_1: { status: "stable", previousRange: null, currentRange: null } },
				wholeFileEquivalent: { files: [{ path: "f.py", bytes: 120 }], whole_file_bytes: 120 },
			},
			{ prepareRequestIndex: 3, observedResultIds: ["read_1"], selectedFiles: ["f.py"] },
		);
		expect(trace).toMatchObject({
			prepareRequestIndex: 3,
			planId: "p_1",
			selectionGranularity: "region",
			observedResultIds: ["read_1"],
			selectedUnits: ["u_1"],
			selectedFiles: ["f.py"],
			regionBytes: Buffer.byteLength(projection, "utf-8"),
			wholeFileEquivalentBytes: 120,
			unitStates: { stable: 1 },
		});
	});
});

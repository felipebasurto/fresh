import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildTextReadObservation,
	type FreshCtxReadObservation,
	sha256Hex,
} from "../src/core/freshctx/observations.ts";
import {
	collectPersistedUnits,
	FRESHCTX_UNITS_CUSTOM_TYPE,
	type FreshCtxResolvedUnit,
	refreshSessionObservations,
	resolvedUnitsEqual,
} from "../src/core/freshctx/session-state.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function textObs(obsId: string, cwd: string, text: string): FreshCtxReadObservation {
	const buffer = Buffer.from(text, "utf-8");
	const allLines = text.split("\n");
	return buildTextReadObservation({
		obsId,
		absolutePath: join(cwd, `${obsId}.txt`),
		cwd,
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

function assistantMessage(): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("refreshSessionObservations", () => {
	it("keeps only the current branch active (abandoned reads never leak)", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-freshctx-state-"));
		tempDirs.push(tempRoot);
		const projectDir = join(tempRoot, "project");
		const manager = SessionManager.create(projectDir, join(tempRoot, "sessions"), { id: "branch-test" });
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		const forkPoint = manager.appendMessage(assistantMessage());
		manager.appendCustomEntry("freshctx_obs", textObs("obs-a", projectDir, "aaa\n"));
		manager.branch(forkPoint);
		manager.appendCustomEntry("freshctx_obs", textObs("obs-b", projectDir, "bbb\n"));
		const refresh = refreshSessionObservations(manager.getBranch(), manager.getCwd());
		expect(refresh.active.map((obs) => obs.obsId)).toEqual(["obs-b"]);
		expect(refresh.excluded).toEqual([]);
		// Abandoned entries still exist in storage; they are just not active.
		expect(manager.getEntries().filter((entry) => entry.type === "custom").length).toBe(2);
	});

	it("excludes corrupt, duplicate, and outside-workspace entries", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-freshctx-state-"));
		tempDirs.push(tempRoot);
		const projectDir = join(tempRoot, "project");
		const manager = SessionManager.create(projectDir, join(tempRoot, "sessions"), { id: "exclude-test" });
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		manager.appendMessage(assistantMessage());
		const good = textObs("obs-good", projectDir, "good\n");
		manager.appendCustomEntry("freshctx_obs", good);
		manager.appendCustomEntry("freshctx_obs", good);
		manager.appendCustomEntry("freshctx_obs", { bogus: true });
		const elsewhere = mkdtempSync(join(tmpdir(), "pi-freshctx-elsewhere-"));
		tempDirs.push(elsewhere);
		const outside: FreshCtxReadObservation = {
			...textObs("obs-out", elsewhere, "out\n"),
			absolutePath: join(elsewhere, "obs-out.txt"),
			workspaceRelativePath: "obs-out.txt",
		};
		manager.appendCustomEntry("freshctx_obs", outside);
		const refresh = refreshSessionObservations(manager.getBranch(), manager.getCwd());
		expect(refresh.active.map((obs) => obs.obsId)).toEqual(["obs-good"]);
		expect(refresh.excluded).toEqual([
			{ obsId: "obs-good", reason: "duplicate" },
			{ obsId: "unknown", reason: "corrupt" },
			{ obsId: "obs-out", reason: "outside-workspace" },
		]);
	});

	it("recomputes relative paths when the session moved workspaces", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-freshctx-state-"));
		tempDirs.push(tempRoot);
		const oldCwd = join(tempRoot, "old");
		const newCwd = join(tempRoot, "new");
		const manager = SessionManager.create(oldCwd, join(tempRoot, "sessions"), { id: "moved-test" });
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		manager.appendMessage(assistantMessage());
		const buffer = Buffer.from("moved\n", "utf-8");
		const moved: FreshCtxReadObservation = {
			version: 1,
			obsId: "obs-moved",
			toolName: "read",
			absolutePath: join(newCwd, "moved.txt"),
			workspaceRelativePath: null,
			contentSha256: sha256Hex(buffer),
			fileBytes: buffer.length,
			startByte: 0,
			endByte: buffer.length,
			shownSha256: sha256Hex(buffer),
			startLine: 1,
			endLine: 1,
			totalLines: 2,
			status: "observed",
			truncatedBy: null,
			reason: null,
			symlink: false,
			timestamp: "2026-09-06T00:00:00.000Z",
		};
		manager.appendCustomEntry("freshctx_obs", moved);
		const refresh = refreshSessionObservations(manager.getBranch(), newCwd);
		expect(refresh.active.map((obs) => obs.obsId)).toEqual(["obs-moved"]);
		expect(refresh.active[0]?.workspaceRelativePath).toBe("moved.txt");
	});

	it("collects persisted units and compares sets order-insensitively", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-freshctx-state-"));
		tempDirs.push(tempRoot);
		const projectDir = join(tempRoot, "project");
		const manager = SessionManager.create(projectDir, join(tempRoot, "sessions"), { id: "units-test" });
		expect(collectPersistedUnits(manager.getBranch())).toEqual([]);
		const units: FreshCtxResolvedUnit[] = [
			{ resultId: "a", unitId: "u_1", revision: "sha256:aa", path: "a.txt" },
			{ resultId: "b", unitId: "u_2", revision: "sha256:bb", path: "b.txt" },
		];
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		manager.appendMessage(assistantMessage());
		manager.appendCustomEntry(FRESHCTX_UNITS_CUSTOM_TYPE, { version: 1, units, timestamp: "t" });
		expect(collectPersistedUnits(manager.getBranch())).toEqual(units);
		expect(resolvedUnitsEqual(units, [...units].reverse())).toBe(true);
		expect(resolvedUnitsEqual(units, units.slice(0, 1))).toBe(false);
		expect(resolvedUnitsEqual(units, [...units, { resultId: "c", unitId: "u_3", revision: "x", path: "c" }])).toBe(
			false,
		);
	});
});

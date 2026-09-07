import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Regression for the archived t9 file-mode mismatch: the A/B runner wrote
 * file-mode settings into a per-run agent dir but exported them under
 * PI_CODING_AGENT_DIR, which Fresh ignores (APP_NAME=fresh). The preparer
 * therefore resolved region defaults. Proves the runner's exact environment
 * shape — FRESH_CODING_AGENT_DIR pointing at a dir containing settings.json
 * with selectionGranularity "file" — reaches a file-mode preparer.
 */
describe("runner agent-dir environment reaches file-mode settings", () => {
	it("agent dir resolves via FRESH_CODING_AGENT_DIR, not PI_CODING_AGENT_DIR", () => {
		expect(ENV_AGENT_DIR).toBe("FRESH_CODING_AGENT_DIR");
		const prevPi = process.env.PI_CODING_AGENT_DIR;
		const prevFresh = process.env.FRESH_CODING_AGENT_DIR;
		const decoy = tempDir("pi-freshctx-runner-decoy-");
		const real = tempDir("pi-freshctx-runner-agent-");
		try {
			process.env.PI_CODING_AGENT_DIR = decoy;
			delete process.env.FRESH_CODING_AGENT_DIR;
			expect(getAgentDir()).not.toBe(decoy);
			process.env.FRESH_CODING_AGENT_DIR = real;
			expect(getAgentDir()).toBe(real);
		} finally {
			if (prevPi === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = prevPi;
			}
			if (prevFresh === undefined) {
				delete process.env.FRESH_CODING_AGENT_DIR;
			} else {
				process.env.FRESH_CODING_AGENT_DIR = prevFresh;
			}
		}
	});

	it("file settings in the runner-shaped agent dir resolve to file granularity", () => {
		const work = tempDir("pi-freshctx-runner-work-");
		const agentDir = join(work, "agent");
		const sessionDir = join(work, "sessions");
		const prevFresh = process.env.FRESH_CODING_AGENT_DIR;
		const prevSession = process.env[ENV_SESSION_DIR];
		try {
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					freshctx: { mode: "native", selectionGranularity: "file" },
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
			);
			process.env.FRESH_CODING_AGENT_DIR = agentDir;
			process.env[ENV_SESSION_DIR] = sessionDir;
			expect(getAgentDir()).toBe(agentDir);
			const settingsManager = SettingsManager.create(work, getAgentDir());
			expect(settingsManager.getFreshCtxSelectionGranularity()).toBe("file");
			expect(settingsManager.getFreshCtxSettings(work).selectionGranularity).toBe("file");
		} finally {
			if (prevFresh === undefined) {
				delete process.env.FRESH_CODING_AGENT_DIR;
			} else {
				process.env.FRESH_CODING_AGENT_DIR = prevFresh;
			}
			if (prevSession === undefined) {
				delete process.env[ENV_SESSION_DIR];
			} else {
				process.env[ENV_SESSION_DIR] = prevSession;
			}
		}
	});
});

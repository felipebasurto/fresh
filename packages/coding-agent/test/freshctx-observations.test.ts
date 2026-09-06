import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	buildImageReadObservation,
	buildTextReadObservation,
	FRESHCTX_OBSERVATION_CUSTOM_TYPE,
	type FreshCtxReadObservation,
	isValidUtf8,
	sha256Hex,
	shownByteRange,
	toWorkspaceRelativePath,
} from "../src/core/freshctx/observations.ts";
import {
	type CustomEntry,
	loadEntriesFromFile,
	SessionManager,
	sessionEntryToContextMessages,
} from "../src/core/session-manager.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function textInput(
	overrides: Partial<Parameters<typeof buildTextReadObservation>[0]>,
): Parameters<typeof buildTextReadObservation>[0] {
	const buffer = Buffer.from("hello\nworld\n", "utf-8");
	return {
		obsId: "obs-1",
		absolutePath: "/work/notes.txt",
		cwd: "/work",
		buffer,
		allLines: ["hello", "world", ""],
		startLine: 0,
		shownLineCount: 3,
		totalFileLines: 3,
		truncated: false,
		truncatedBy: null,
		userLimited: false,
		firstLineExceedsLimit: false,
		symlink: false,
		timestamp: "2026-09-06T00:00:00.000Z",
		...overrides,
	};
}

describe("observations helpers", () => {
	it("hashes exact source bytes", () => {
		expect(sha256Hex(Buffer.from("abc", "utf-8"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("rejects invalid UTF-8", () => {
		expect(isValidUtf8(Buffer.from("caf\u00e9", "utf-8"))).toBe(true);
		expect(isValidUtf8(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
	});

	it("resolves workspace-relative paths", () => {
		expect(toWorkspaceRelativePath("/work/a/b.txt", "/work")).toBe(join("a", "b.txt"));
		expect(toWorkspaceRelativePath("/other/b.txt", "/work")).toBeNull();
		expect(toWorkspaceRelativePath("/work", "/work")).toBeNull();
	});

	it("computes CRLF/UTF-8 byte ranges that slice back to shown text", () => {
		const text = "# caf\u00e9\r\n\r\nbody\r\n";
		const buffer = Buffer.from(text, "utf-8");
		const allLines = text.split("\n");
		const { startByte, endByte } = shownByteRange(allLines, 0, allLines.length);
		expect(startByte).toBe(0);
		expect(endByte).toBe(buffer.length);
		expect(buffer.slice(startByte, endByte).toString("utf-8")).toBe(text);
		// Later-symbol read: byte offsets are not line numbers.
		const later = shownByteRange(allLines, 2, 2);
		expect(later.startByte).toBeGreaterThan(allLines.length);
		expect(buffer.slice(later.startByte, later.endByte).toString("utf-8")).toBe("body\r\n");
	});

	it("marks full reads observed with a full-file range", () => {
		const obs = buildTextReadObservation(textInput({}));
		expect(obs.status).toBe("observed");
		expect(obs.truncatedBy).toBeNull();
		expect(obs.startByte).toBe(0);
		expect(obs.endByte).toBe(obs.fileBytes);
		expect(obs.startLine).toBe(1);
	});

	it("marks truncated reads with the active limit", () => {
		const byLines = buildTextReadObservation(textInput({ truncated: true, truncatedBy: "lines" }));
		expect(byLines.status).toBe("truncated");
		expect(byLines.truncatedBy).toBe("lines");
		const byUser = buildTextReadObservation(textInput({ userLimited: true }));
		expect(byUser.status).toBe("truncated");
		expect(byUser.truncatedBy).toBe("user-limit");
	});

	it("marks first-line-exceeds-limit as unsupported with an empty range", () => {
		const obs = buildTextReadObservation(
			textInput({ shownLineCount: 0, truncated: true, truncatedBy: "bytes", firstLineExceedsLimit: true }),
		);
		expect(obs.status).toBe("unsupported");
		expect(obs.reason).toBe("first-line-exceeds-limit");
		expect(obs.startByte).toBe(obs.endByte);
	});

	it("marks oversized and non-UTF-8 files unsupported without losing the hash", () => {
		const big = buildTextReadObservation(textInput({ buffer: Buffer.alloc(600 * 1024, "a") }));
		expect(big.status).toBe("unsupported");
		expect(big.reason).toBe("file-too-large");
		expect(big.contentSha256).toHaveLength(64);
		const binary = buildTextReadObservation(textInput({ buffer: Buffer.from([0xff, 0xfe]) }));
		expect(binary.status).toBe("unsupported");
		expect(binary.reason).toBe("non-utf8");
	});

	it("marks images unsupported", () => {
		const obs = buildImageReadObservation({
			obsId: "obs-img",
			absolutePath: "/work/pic.png",
			cwd: "/work",
			buffer: Buffer.from([0x89, 0x50]),
			mimeType: "image/png",
			symlink: false,
		});
		expect(obs.status).toBe("unsupported");
		expect(obs.reason).toBe("image:image/png");
	});
});

describe("read tool observations", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = createTempDir("pi-freshctx-read-");
	});

	async function execute(path: string, offset?: number, limit?: number) {
		const definition = createReadToolDefinition(projectDir);
		return definition.execute("obs-tool-1", { path, offset, limit }, undefined, undefined, {} as ExtensionContext);
	}

	it("records an exact full-file observation without changing output text", () => {
		const text = "# caf\u00e9\r\n\r\nbody\r\n";
		writeFileSync(join(projectDir, "notes.txt"), text);
		return execute("notes.txt").then(({ content, details }) => {
			expect(content).toHaveLength(1);
			expect(content[0].type).toBe("text");
			if (content[0].type !== "text") throw new Error("unreachable");
			expect(content[0].text).toBe(text);
			expect(content[0].text).not.toContain("freshctx");
			const obs = details?.freshctxObs;
			expect(obs?.status).toBe("observed");
			expect(obs?.obsId).toBe("obs-tool-1");
			expect(obs?.workspaceRelativePath).toBe("notes.txt");
			const buffer = readFileSync(join(projectDir, "notes.txt"));
			expect(obs?.contentSha256).toBe(sha256Hex(buffer));
			expect(buffer.slice(obs?.startByte ?? 0, obs?.endByte ?? 0).toString("utf-8")).toBe(text);
		});
	});

	it("records exact ranges for offset reads", () => {
		const text = "one\ntwo\nthree\nfour\n";
		writeFileSync(join(projectDir, "lines.txt"), text);
		return execute("lines.txt", 2, 2).then(({ content, details }) => {
			const obs = details?.freshctxObs;
			// Limit-bounded reads are partial but still exact.
			expect(obs?.status).toBe("truncated");
			expect(obs?.truncatedBy).toBe("user-limit");
			expect(obs?.startLine).toBe(2);
			expect(obs?.endLine).toBe(3);
			const buffer = readFileSync(join(projectDir, "lines.txt"));
			expect(buffer.slice(obs?.startByte ?? 0, obs?.endByte ?? 0).toString("utf-8")).toBe("two\nthree");
			if (content[0].type !== "text") throw new Error("unreachable");
			expect(content[0].text).toContain("two\nthree");
		});
	});

	it("records user-limited reads as truncated with the shown range only", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
		writeFileSync(join(projectDir, "ten.txt"), `${lines.join("\n")}\n`);
		return execute("ten.txt", 1, 3).then(({ details }) => {
			const obs = details?.freshctxObs;
			expect(obs?.status).toBe("truncated");
			expect(obs?.truncatedBy).toBe("user-limit");
			const buffer = readFileSync(join(projectDir, "ten.txt"));
			expect(buffer.slice(obs?.startByte ?? 0, obs?.endByte ?? 0).toString("utf-8")).toBe("line 1\nline 2\nline 3");
		});
	});

	it("records line truncation with a verifiable prefix range", () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
		writeFileSync(join(projectDir, "big.txt"), `${lines.join("\n")}\n`);
		return execute("big.txt").then(({ details }) => {
			const obs = details?.freshctxObs;
			expect(obs?.status).toBe("truncated");
			expect(obs?.truncatedBy).toBe("lines");
			const buffer = readFileSync(join(projectDir, "big.txt"));
			expect(obs?.endByte).toBeLessThan(buffer.length);
			expect(buffer.slice(obs?.startByte ?? 0, obs?.endByte ?? 0).toString("utf-8")).toBe(
				lines.slice(0, 2000).join("\n"),
			);
		});
	});

	it("marks oversized files unsupported while keeping the full-file hash", () => {
		// Multi-line so the first line fits: exercises file-too-large, not first-line-exceeds-limit.
		writeFileSync(join(projectDir, "huge.bin.txt"), `${"a".repeat(1023)}\n`.repeat(600));
		return execute("huge.bin.txt").then(({ details }) => {
			const obs = details?.freshctxObs;
			expect(obs?.status).toBe("unsupported");
			expect(obs?.reason).toBe("file-too-large");
			const buffer = readFileSync(join(projectDir, "huge.bin.txt"));
			expect(obs?.contentSha256).toBe(sha256Hex(buffer));
		});
	});

	it("marks symlinks explicitly and outside-workspace paths relatively null", () => {
		writeFileSync(join(projectDir, "real.txt"), "real\n");
		symlinkSync(join(projectDir, "real.txt"), join(projectDir, "link.txt"));
		return execute("link.txt")
			.then(({ details }) => {
				expect(details?.freshctxObs?.symlink).toBe(true);
				const outsideDir = createTempDir("pi-freshctx-outside-");
				writeFileSync(join(outsideDir, "out.txt"), "out\n");
				return execute(join(outsideDir, "out.txt"));
			})
			.then(({ details }) => {
				expect(details?.freshctxObs?.workspaceRelativePath).toBeNull();
				expect(details?.freshctxObs?.status).toBe("observed");
			});
	});

	it("produces no observation for failed reads", () => {
		return expect(execute("missing.txt")).rejects.toThrow();
	});
});

describe("observation persistence", () => {
	it("survives session save/reload with an identical hash and stays out of LLM context", () => {
		const tempRoot = createTempDir("pi-freshctx-session-");
		const projectDir = join(tempRoot, "project");
		mkdirSync(projectDir, { recursive: true });
		const sessionDir = join(tempRoot, "sessions");
		const manager = SessionManager.create(projectDir, sessionDir, { id: "freshctx-obs-test" });
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		manager.appendMessage({
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
		});
		const buffer = Buffer.from("tracked\n", "utf-8");
		const obs: FreshCtxReadObservation = {
			version: 1,
			obsId: "obs-persist-1",
			toolName: "read",
			absolutePath: join(projectDir, "tracked.txt"),
			workspaceRelativePath: "tracked.txt",
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
		manager.appendCustomEntry(FRESHCTX_OBSERVATION_CUSTOM_TYPE, obs);
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const entries = loadEntriesFromFile(sessionFile as string);
		const found = entries.find(
			(entry): entry is CustomEntry<FreshCtxReadObservation> =>
				entry.type === "custom" && entry.customType === FRESHCTX_OBSERVATION_CUSTOM_TYPE,
		);
		expect(found?.customType).toBe(FRESHCTX_OBSERVATION_CUSTOM_TYPE);
		if (!found?.data) throw new Error("observation entry missing after reload");
		expect(found.data).toEqual(obs);
		expect(found.data.contentSha256).toBe(sha256Hex(buffer));
		expect(sessionEntryToContextMessages(found)).toEqual([]);
	});
});

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildRetainedRefsMessage,
	FRESHCTX_RETAINED_BOUND,
	referenceTokenFor,
	stripTrackedBodies,
} from "../src/core/freshctx/compaction-view.ts";
import { buildTextReadObservation, type FreshCtxReadObservation } from "../src/core/freshctx/observations.ts";
import { hasFreshCtxViewMarker, withFreshCtxViewMarker } from "../src/core/freshctx/session-state.ts";

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

function toolResult(id: string, content: unknown, obs?: FreshCtxReadObservation): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content,
		details: obs ? { freshctxObs: obs } : {},
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

describe("stripTrackedBodies", () => {
	it("replaces tracked text with an exact reproducible token", () => {
		const obs = textObs("read_1", "SECRET_CODE\n");
		const message = toolResult("read_1", [{ type: "text", text: "SECRET_CODE\n" }], obs);
		const before = structuredClone(message);
		const { messages, strippedIds } = stripTrackedBodies([message]);
		expect(strippedIds).toEqual(["read_1"]);
		expect(message).toEqual(before);
		expect(JSON.stringify(messages)).not.toContain("SECRET_CODE");
		expect(JSON.stringify(messages)).toContain(referenceTokenFor(obs));
		const token = referenceTokenFor(obs);
		expect(token).toContain("obsId=read_1");
		expect(token).toContain("path=read_1.txt");
		expect(token).not.toContain("SECRET");
	});

	it("leaves untracked, unsupported, and non-tool messages untouched", () => {
		const imageLike = toolResult("img_1", [{ type: "text", text: "note" }], {
			...textObs("img_1", "x"),
			status: "unsupported",
			reason: "image:image/png",
		});
		const plain = toolResult("plain_1", [{ type: "text", text: "plain" }]);
		const user = { role: "user", content: "hello", timestamp: Date.now() } as AgentMessage;
		const { messages, strippedIds } = stripTrackedBodies([imageLike, plain, user]);
		expect(strippedIds).toEqual([]);
		expect(messages[0]).toBe(imageLike);
		expect(messages[1]).toBe(plain);
		expect(messages[2]).toBe(user);
	});
});

describe("buildRetainedRefsMessage", () => {
	it("keeps code-free newest-bounded references for dropped entries only", () => {
		const branch = [];
		const userEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "t",
			message: { role: "user", content: "hi", timestamp: 1 },
		} as const;
		branch.push(userEntry);
		for (let index = 0; index < 12; index++) {
			const obs = textObs(`read_${index}`, `code ${index}\n`);
			branch.push({
				type: "message",
				id: `e${index}`,
				parentId: index === 0 ? "u1" : `e${index - 1}`,
				timestamp: "t",
				message: {
					role: "toolResult",
					toolCallId: `read_${index}`,
					toolName: "read",
					content: [{ type: "text", text: `code ${index}\n` }],
					details: { freshctxObs: obs },
					isError: false,
					timestamp: 1,
				},
			});
		}
		const kept = {
			type: "message",
			id: "kept",
			parentId: "e11",
			timestamp: "t",
			message: userEntry.message,
		} as const;
		branch.push(kept);
		const refs = buildRetainedRefsMessage(branch as never, "kept");
		expect(refs?.details.refs.map((ref) => ref.obsId)).toEqual(
			Array.from({ length: FRESHCTX_RETAINED_BOUND }, (_, index) => `read_${index + 12 - FRESHCTX_RETAINED_BOUND}`),
		);
		expect(refs?.content).not.toContain("code 0");
		expect(refs?.content).toContain("read_11.txt");
		expect(buildRetainedRefsMessage(branch as never, "missing")).toBeNull();
		expect(buildRetainedRefsMessage(branch.slice(0, 1) as never, "u1")).toBeNull();
	});
});

describe("compaction view markers", () => {
	it("distinguishes pre-integration summaries", () => {
		expect(hasFreshCtxViewMarker({})).toBe(false);
		expect(hasFreshCtxViewMarker({ details: undefined })).toBe(false);
		const marked = withFreshCtxViewMarker(undefined);
		expect(hasFreshCtxViewMarker({ details: marked })).toBe(true);
		const merged = withFreshCtxViewMarker({ custom: 1 });
		expect(hasFreshCtxViewMarker({ details: merged })).toBe(true);
		expect((merged as Record<string, unknown>).custom).toBe(1);
		expect(withFreshCtxViewMarker("legacy")).toBe("legacy");
	});
});

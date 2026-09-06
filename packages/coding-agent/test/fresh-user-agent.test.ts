import { describe, expect, it } from "vitest";
import { getFreshUserAgent } from "../src/utils/fresh-user-agent.ts";

describe("getFreshUserAgent", () => {
	it("formats the fresh user agent string", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getFreshUserAgent("1.2.3");

		expect(userAgent).toBe(`fresh/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^fresh\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});

import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { sha256Hex } from "../src/core/freshctx/observations.ts";
import {
	createFreshCtxInspectToolDefinition,
	createFreshCtxRecoverToolDefinition,
} from "../src/core/freshctx/recover-tool.ts";
import type { FreshCtxClient } from "../src/core/freshctx/runtime.ts";

class StubRecoverServer implements FreshCtxClient {
	readonly disk = new Map<string, string>([["price.py", "RATE = 20\n"]]);
	async request(op: string, fields: Record<string, unknown> = {}): Promise<unknown> {
		if (op !== "recover") {
			throw new Error(`unexpected op ${op}`);
		}
		const current = this.disk.get(fields.unit_id as string);
		if (current === undefined) {
			throw Object.assign(new Error("no such unit"), { code: "unknown_unit" });
		}
		if (fields.revision !== `sha256:${sha256Hex(Buffer.from(current, "utf-8"))}`) {
			throw Object.assign(new Error("no such revision"), { code: "unknown_revision" });
		}
		return {
			unit_id: fields.unit_id,
			revision: fields.revision,
			content_utf8_base64: Buffer.from(current, "utf-8").toString("base64"),
		};
	}
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	if (!first || first.type !== "text" || typeof first.text !== "string") {
		throw new Error("expected text content");
	}
	return first.text;
}

describe("freshctx_recover", () => {
	it("returns archived bytes with a historical label and no observation metadata", async () => {
		const server = new StubRecoverServer();
		const tool = createFreshCtxRecoverToolDefinition(async () => server);
		const revision = `sha256:${sha256Hex(Buffer.from("RATE = 20\n", "utf-8"))}`;
		const result = await tool.execute(
			"recover-1",
			{ unit_id: "price.py", revision },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textOf(result);
		expect(text).toContain("Historical");
		expect(text).toContain("RATE = 20");
		expect(result.details).toBeUndefined();
	});

	it("fails loudly for unknown units and revisions", async () => {
		const server = new StubRecoverServer();
		const tool = createFreshCtxRecoverToolDefinition(async () => server);
		await expect(
			tool.execute(
				"recover-2",
				{ unit_id: "missing.py", revision: "sha256:00" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/unknown_unit|recover failed/);
		await expect(
			tool.execute(
				"recover-3",
				{ unit_id: "price.py", revision: "sha256:00" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/unknown_revision|recover failed/);
	});
});

describe("freshctx_inspect", () => {
	it("lists observations, exclusions, units, and server health without inventing IDs", async () => {
		const tool = createFreshCtxInspectToolDefinition(async () => ({
			mode: "native",
			observations: [{ obsId: "read_1", path: "price.py", status: "observed", startByte: 0, endByte: 9 }],
			excluded: [{ obsId: "obs-out", reason: "outside-workspace" }],
			units: [{ resultId: "read_1", unitId: "u_3", revision: "sha256:abc", path: "price.py" }],
			server: { healthy: true, session_id: "s-1" },
		}));
		const result = await tool.execute("inspect-1", {}, undefined, undefined, {} as ExtensionContext);
		const text = textOf(result);
		expect(text).toContain("read_1 price.py [observed]");
		expect(text).toContain("obs-out excluded (outside-workspace)");
		expect(text).toContain("u_3 sha256:abc price.py");
		expect(text).toContain("healthy");
		expect(result.details).toBeUndefined();
	});

	it("reports unreachable servers explicitly", async () => {
		const tool = createFreshCtxInspectToolDefinition(async () => ({
			mode: "native",
			observations: [],
			excluded: [],
			units: [],
			server: { error: "connection refused" },
		}));
		const result = await tool.execute("inspect-2", {}, undefined, undefined, {} as ExtensionContext);
		expect(textOf(result)).toContain("unreachable: connection refused");
	});
});

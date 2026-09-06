import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { FreshCtxClient } from "./runtime.ts";
import type { FreshCtxResolvedUnit } from "./session-state.ts";

/**
 * Historical recovery + inspection tools (Phase D).
 *
 * `freshctx_recover` exposes the FreshCtx `recover` operation: archived bytes
 * for an exact unit ID + revision, labeled historical. Recovered content is
 * never a current-workspace observation (no observation metadata attached),
 * so it can never enter verified preparation as fresh source.
 *
 * `freshctx_inspect` lists tracked observations and resolved archive units so
 * the model never has to invent identifiers.
 */

const recoverSchema = Type.Object({
	unit_id: Type.String({ description: "FreshCtx unit ID (see freshctx_inspect), e.g. u_3" }),
	revision: Type.String({ description: "Unit revision (see freshctx_inspect), e.g. sha256:…" }),
});

export type FreshCtxRecoverInput = Static<typeof recoverSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function createFreshCtxRecoverToolDefinition(getClient: () => Promise<FreshCtxClient>): ToolDefinition {
	return {
		name: "freshctx_recover",
		label: "freshctx_recover",
		description:
			"Fetch archived bytes for an exact FreshCtx unit ID and revision. Historical evidence only: never current workspace source. Use read for current source.",
		promptSnippet: "Fetch archived code revisions",
		promptGuidelines: [
			"Use freshctx_inspect to discover unit IDs and revisions; never invent them.",
			"Recovered bytes are historical. Use read for current source inspection.",
		],
		parameters: recoverSchema,
		autoActivate: false,
		async execute(_toolCallId, params, signal?: AbortSignal) {
			const { unit_id, revision } = params as FreshCtxRecoverInput;
			const client = await getClient();
			let result: unknown;
			try {
				result = await client.request("recover", { unit_id, revision }, signal);
			} catch (error) {
				throw new Error(
					`FreshCtx recover failed for ${unit_id}@${revision}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!isRecord(result) || typeof result.content_utf8_base64 !== "string") {
				throw new Error(`FreshCtx recover failed for ${unit_id}@${revision}: malformed response`);
			}
			const text = Buffer.from(result.content_utf8_base64, "base64").toString("utf-8");
			const content: (TextContent | ImageContent)[] = [
				{
					type: "text",
					text: `[Historical FreshCtx revision: unit ${unit_id} revision ${revision}. Archived bytes below; not current workspace source. Use read for current source.]\n\n${text}`,
				},
			];
			return { content, details: undefined };
		},
	};
}

export interface FreshCtxInspection {
	mode: string;
	observations: Array<{
		obsId: string;
		path: string;
		status: string;
		startByte: number;
		endByte: number;
	}>;
	excluded: Array<{ obsId: string; reason: string }>;
	units: FreshCtxResolvedUnit[];
	server: { healthy: boolean; session_id?: string } | { error: string };
}

const inspectSchema = Type.Object({});

export function createFreshCtxInspectToolDefinition(getInspection: () => Promise<FreshCtxInspection>): ToolDefinition {
	return {
		name: "freshctx_inspect",
		label: "freshctx_inspect",
		description:
			"List FreshCtx tracked read observations, archived units available for freshctx_recover, and server health. Read-only.",
		promptSnippet: "Inspect tracked context observations",
		promptGuidelines: ["Use this to discover unit IDs and revisions before freshctx_recover."],
		parameters: inspectSchema,
		autoActivate: false,
		async execute() {
			const inspection = await getInspection();
			const lines = [
				`FreshCtx mode: ${inspection.mode}`,
				`Server: ${"healthy" in inspection.server ? `healthy (session ${inspection.server.session_id ?? "?"})` : `unreachable: ${inspection.server.error}`}`,
				"Tracked observations:",
			];
			for (const obs of inspection.observations) {
				lines.push(`- ${obs.obsId} ${obs.path} [${obs.status}] bytes ${obs.startByte}-${obs.endByte}`);
			}
			for (const excluded of inspection.excluded) {
				lines.push(`- ${excluded.obsId} excluded (${excluded.reason})`);
			}
			lines.push("Archived units (freshctx_recover):");
			for (const unit of inspection.units) {
				lines.push(`- ${unit.unitId} ${unit.revision} ${unit.path} (from ${unit.resultId})`);
			}
			const content: (TextContent | ImageContent)[] = [{ type: "text", text: lines.join("\n") }];
			return { content, details: undefined };
		},
	};
}

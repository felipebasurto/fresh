// Hermetic freshctx/1 fixture for pi-native tests. NOT a product implementation.
// Mimics the documented protocol surface (hello/observe/prepare/commit/status)
// backed by the real filesystem, so refresh semantics are genuinely exercised:
// projections always render CURRENT disk bytes while replacements check the
// ORIGINALLY observed revision. Anything else returns ok:false with a code.
//
// Test hooks via environment:
//   FRESHCTX_FAKE_STALE_ONCE=1  fail the next commit with stale_plan, then behave.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const root = resolve(process.env.FRESHCTX_FAKE_ROOT ?? process.cwd());
if (process.env.FRESHCTX_FAKE_PIDFILE) {
  await writeFile(process.env.FRESHCTX_FAKE_PIDFILE, String(process.pid));
}
const staleOnce = process.env.FRESHCTX_FAKE_STALE_ONCE === "1";
let delayMs = Number(process.env.FRESHCTX_FAKE_DELAY_MS ?? 0);
let staleArmed = staleOnce;

const revisionFor = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const ok = (id, result) => console.log(JSON.stringify({ protocol: "freshctx/1", id, ok: true, result }));
const fail = (id, code, message) =>
  console.log(JSON.stringify({ protocol: "freshctx/1", id, ok: false, error: { code, message } }));

let helloSession = null;
let unitSeq = 0;
let planSeq = 0;
/** resultId -> { path, revision, range, content } */
const observations = new Map();
/** unitId -> { path } (one unit per path) */
const units = new Map();
/** path -> unitId */
const unitsByPath = new Map();
/** planId -> { references: [{ path, sourceRevision }], projection, projection_sha256 } */
const pending = new Map();

function unitForPath(path) {
  let id = unitsByPath.get(path);
  if (!id) {
    id = `u_${++unitSeq}`;
    unitsByPath.set(path, id);
    units.set(id, { id, path });
  }
  return units.get(id);
}

async function currentRevision(absPath) {
  const bytes = await readFile(absPath);
  return { bytes, revision: revisionFor(bytes) };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, op, protocol } = msg;
  if (protocol !== "freshctx/1" || typeof id !== "string") return;
  // Test-only control op (never part of the product protocol).
  if (op === "__delay") {
    delayMs = Number(msg.ms ?? 0);
    return ok(id, { delayMs });
  }
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  try {
    if (op !== "hello" && helloSession === null) return fail(id, "hello_required", "hello first");
    switch (op) {
      case "hello": {
        const caps = msg.capabilities ?? {};
        for (const cap of ["request_rewrite", "stable_result_identity", "projection_insertion", "shared_workspace"]) {
          if (caps[cap] !== true) return fail(id, "host_incompatible", `missing capability ${cap}`);
        }
        if (helloSession !== null && helloSession !== msg.session_id) return fail(id, "session_active", "session active");
        const first = helloSession === null;
        helloSession = msg.session_id;
        return ok(id, first ? { session_id: helloSession } : { session_id: helloSession, idempotent: true });
      }
      case "observe": {
        const { result_id, path, content_utf8_base64, range } = msg;
        if (typeof result_id !== "string" || typeof path !== "string" || !path) {
          return fail(id, "invalid_path", "bad observe");
        }
        const content = Buffer.from(content_utf8_base64 ?? "", "base64");
        const revision = revisionFor(content);
        const prev = observations.get(result_id);
        if (prev && (prev.path !== path || prev.revision !== revision || JSON.stringify(prev.range ?? null) !== JSON.stringify(range ?? null))) {
          return fail(id, "idempotency_conflict", "observe conflict");
        }
        observations.set(result_id, { path, revision, range: range ?? null, content });
        const unit = unitForPath(path);
        return ok(id, { result_id, unit_id: unit.id, marker: `[${unit.id}]`, idempotent: false });
      }
      case "prepare": {
        const { request_id, result_ids, budget_bytes, selection_granularity } = msg;
        if (selection_granularity !== undefined && selection_granularity !== "region" && selection_granularity !== "file") {
          return fail(id, "invalid_request", "bad selection_granularity");
        }
        const granularity = selection_granularity ?? "region";
        if (typeof request_id !== "string" || !Array.isArray(result_ids) || new Set(result_ids).size !== result_ids.length) {
          return fail(id, "invalid_request", "bad prepare");
        }
        const budget = typeof budget_bytes === "number" ? budget_bytes : 131072;
        const replacements = [];
        const selected = [];
        const omitted = [];
        const unresolved = [];
        const references = [];
        for (const resultId of result_ids) {
          const obs = observations.get(resultId);
          if (!obs) {
            unresolved.push({ result_id: resultId, reason: "unknown_result" });
            continue;
          }
          const unit = unitForPath(obs.path);
          const absPath = join(root, obs.path);
          let current;
          try {
            current = await currentRevision(absPath);
          } catch {
            replacements.push({ result_id: resultId, expected_sha256: obs.revision, marker: `[${unit.id} deleted]` });
            omitted.push({ unitId: unit.id, reason: "deleted" });
            continue;
          }
          references.push({ path: obs.path, sourceRevision: current.revision });
          if (budget <= 0) {
            replacements.push({ result_id: resultId, expected_sha256: obs.revision, marker: `[${unit.id} budget]` });
            omitted.push({ unitId: unit.id, reason: "budget" });
            continue;
          }
          replacements.push({ result_id: resultId, expected_sha256: obs.revision, marker: `[${unit.id}]` });
          selected.push(unit.id);
        }
        let projection = "";
        const wholeFiles = [];
        if (budget > 0) {
          const parts = [];
          let used = 0;
          for (const unitId of selected) {
            const unit = units.get(unitId);
            const { bytes } = await currentRevision(join(root, unit.path));
            if (used + bytes.length > budget) {
              omitted.push({ unitId, reason: "budget" });
              continue;
            }
            used += bytes.length;
            wholeFiles.push({ path: unit.path, bytes: bytes.length });
            parts.push(`--- ${unit.path} ---\n${bytes.toString("utf-8")}`);
          }
          projection = parts.join("\n");
        }
        const planId = `p_${++planSeq}`;
        const projection_sha256 = revisionFor(Buffer.from(projection, "utf-8"));
        pending.set(planId, { references, projection, projection_sha256 });
        // The fake is file-grained by construction (whole current file per
        // unit). Region mode on the fake therefore reports the same bytes as
        // file mode; the granularity echo is what lets host tests assert
        // strategy identity without inferring it from payload shape.
        const whole_file_bytes = wholeFiles.reduce((sum, file) => sum + file.bytes, 0);
        return ok(id, {
          plan_id: planId,
          replacements,
          projection_utf8_base64: Buffer.from(projection, "utf-8").toString("base64"),
          projection_sha256,
          selected,
          omitted,
          unresolved,
          selection_granularity: granularity,
          whole_file_equivalent: { files: wholeFiles, whole_file_bytes },
        });
      }
      case "commit": {
        const plan = pending.get(msg.plan_id);
        if (!plan) return fail(id, "unknown_plan", "no such plan");
        if (staleArmed) {
          staleArmed = false;
          pending.delete(msg.plan_id);
          return fail(id, "stale_plan", "test-injected staleness");
        }
        for (const ref of plan.references) {
          try {
            const current = await currentRevision(join(root, ref.path));
            if (current.revision !== ref.sourceRevision) {
              pending.delete(msg.plan_id);
              return fail(id, "stale_plan", `${ref.path} changed`);
            }
          } catch {
            pending.delete(msg.plan_id);
            return fail(id, "stale_plan", `${ref.path} unreadable`);
          }
        }
        pending.delete(msg.plan_id);
        return ok(id, { applied: true });
      }
      case "status": {
        return ok(id, {
          healthy: true,
          protocol: "freshctx/1",
          version: "fake-1",
          session_id: helloSession,
          languages: [],
          counts: { observations: observations.size, units: units.size, pending_plans: pending.size, committed_plans: 0 },
        });
      }
      default:
        return fail(id, "unknown_op", `unknown op ${op}`);
    }
  } catch (error) {
    return fail(id, "internal", error instanceof Error ? error.message : String(error));
  }
});

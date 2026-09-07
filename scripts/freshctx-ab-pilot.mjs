#!/usr/bin/env node
// Minimal paired A/B runner: same task repo, same prompt, same model, both
// selection granularities. Shells out to the Fresh CLI per run (real provider),
// captures session artifacts, and emits one JSONL line per run.
// Not a dashboard. Not a benchmark platform. Pilot only.
//
// Usage:
//   DEEPSEEK_API_KEY=... node scripts/freshctx-ab-pilot.mjs --tasks tasks/ --out runs.jsonl [--task t9-frozen-region-file] [--modes region,file] [--model deepseek/deepseek-v4-flash] [--timeout-ms 600000]
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateRevalidationEntries, runSucceeded } from "./freshctx-ab-metrics.mjs";
import { evaluateTaskContract, loadTaskContract, selectTaskIds } from "./freshctx-ab-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}

const tasksDir = resolve(repoRoot, arg("tasks", ".freshctx-pilot/tasks"));
const outPath = resolve(repoRoot, arg("out", ".freshctx-pilot/runs.jsonl"));
const modes = arg("modes", "region,file").split(",").map((s) => s.trim()).filter(Boolean);
const model = arg("model", "deepseek/deepseek-v4-flash");
const timeoutMs = Number(arg("timeout-ms", "600000"));
const order = arg("order", "alternate"); // alternate | region-first
const taskFilter = arg("task", "");

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function engineIdentity() {
  const bin = execSync("command -v freshctx || echo ", { encoding: "utf8" }).trim().split("\n")[0];
  let resolved = bin, sha = null, version = null;
  try {
    const out = execSync(`node ${bin} --version 2>&1 || ${bin} --version 2>&1 || true`, { encoding: "utf8" });
    version = out.trim().split("\n")[0] || null;
  } catch { /* ignore */ }
  try { sha = sha256File(resolved); } catch { /* ignore */ }
  return { bin, resolvedPath: resolved, sha256: sha, version, protocol: "freshctx/1" };
}

/** Deterministic working-tree fingerprint via scripts/build-fingerprint.mjs. */
function treeFingerprint(root, name, paths) {
  try {
    const out = execSync(`node ${join(repoRoot, "scripts", "build-fingerprint.mjs")} --root ${root} --name ${name} --paths ${paths}`, { encoding: "utf8" });
    return JSON.parse(out);
  } catch {
    return { name, head: null, dirty: null, fingerprint: null };
  }
}

function buildIdentities() {
  return {
    fresh: treeFingerprint(repoRoot, "fresh", "packages/coding-agent/src,packages/ai/src,packages/agent/src,scripts/freshctx-ab-pilot.mjs,scripts/freshctx-ab-metrics.mjs,scripts/freshctx-ab-contract.mjs,scripts/build-fingerprint.mjs"),
    freshctx: treeFingerprint("", "freshctx", "src,bin,package.json,schema"),
  };
}

function listTasks() {
  if (!existsSync(tasksDir)) throw new Error(`tasks dir missing: ${tasksDir}`);
  return readdirSync(tasksDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

function collectSessionMetrics(sinceMs) {
  const sessionsRoot = join(process.env.HOME ?? os_homedir(), ".pi", "agent", "sessions");
  const metrics = {
    turns: null, toolCalls: null, inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null,
    cost: null, compactions: 0, requestVerdictCounts: null, unitStateCounts: null, plans: null,
    selectedFiles: null, regions: null, structural: null,
    perTurn: [], sessionFile: null,
  };
  try {
    const all = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) all.push(p);
      }
    };
    walk(sessionsRoot);
    const fresh = all.map((p) => ({ p, m: statSync(p).mtimeMs })).filter((e) => e.m >= sinceMs - 5000).sort((a, b) => b.m - a.m);
    if (fresh.length === 0) return metrics;
    const newest = fresh[0].p;
    metrics.sessionFile = newest;
    const lines = readFileSync(newest, "utf8").split("\n").filter(Boolean);
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, toolCalls = 0, turns = 0, compacted = 0, cost = 0;
    const revalidationEntries = [];
    let perTurn = [];
    let turnInput = 0, turnN = 0;
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const m = e.message;
      if (m?.role === "assistant") {
        turns++; turnN++;
        const u = m.usage ?? {};
        input += u.input ?? 0; output += u.output ?? 0; cacheRead += u.cacheRead ?? 0; cacheWrite += u.cacheWrite ?? 0;
        cost += u.cost?.total ?? 0;
        turnInput = (u.input ?? 0) + (u.cacheRead ?? 0);
        let tc = 0;
        for (const c of m.content ?? []) if (c.type === "toolCall") { toolCalls++; tc++; }
        perTurn.push({ turn: turnN, providerInputTokensAfterResponse: turnInput || null, toolCalls: tc });
      }
      if (e.type === "compaction") compacted++;
      if (e.type === "custom" && e.customType === "freshctx_revalidation") {
        revalidationEntries.push(e);
      }
    }
    const aggregated = aggregateRevalidationEntries(revalidationEntries);
    metrics.turns = turns; metrics.toolCalls = toolCalls;
    metrics.inputTokens = input; metrics.outputTokens = output;
    metrics.cacheRead = cacheRead; metrics.cacheWrite = cacheWrite;
    metrics.cost = cost; metrics.compactions = compacted;
    metrics.requestVerdictCounts = aggregated.requestVerdictCounts;
    metrics.unitStateCounts = aggregated.unitStateCounts;
    metrics.plans = aggregated.plans;
    metrics.perTurn = perTurn;
    const obsFiles = collectObservedFiles(newest);
    metrics.selectedFiles = obsFiles;
    metrics.regions = null;
    metrics.structural = {
      fromPlans: structuralFromPlans(aggregated.plans),
      observedFiles: obsFiles,
      note: "regionBytes and wholeFileEquivalentBytes are plan-time only",
    };
  } catch { /* metrics stay null */ }
  return metrics;
}

function structuralFromPlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { requests: 0, regionBytes: null, wholeFileEquivalentBytes: null };
  }
  let regionBytes = 0;
  let whole = 0;
  let wholeKnown = 0;
  for (const plan of plans) {
    if (typeof plan.regionBytes === "number") regionBytes += plan.regionBytes;
    if (typeof plan.wholeFileEquivalentBytes === "number") {
      whole += plan.wholeFileEquivalentBytes;
      wholeKnown += 1;
    }
  }
  return {
    requests: plans.length,
    regionBytes,
    wholeFileEquivalentBytes: wholeKnown === plans.length ? whole : null,
  };
}

function collectObservedFiles(sessionFile) {
  try {
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
    const files = new Set();
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "custom" && e.customType === "freshctx_obs" && e.data?.workspaceRelativePath) {
        files.add(e.data.workspaceRelativePath);
      }
    }
    return [...files].sort();
  } catch { return null; }
}

function os_homedir() {
  return process.env.HOME ?? "~";
}

function runOne(taskId, mode, seq) {
  const taskDir = join(tasksDir, taskId);
  const prompt = readFileSync(join(taskDir, "prompt.md"), "utf8");
  const verifyRel = existsSync(join(taskDir, "verify.sh")) ? "verify.sh" : null;
  const work = join(tmpdir(), `ab-${taskId}-${mode}-${Date.now()}-${seq}`);
  mkdirSync(work, { recursive: true });
  // Fresh starting state: pristine copy of task repo snapshot.
  cpSync(join(taskDir, "repo"), join(work, "repo"), { recursive: true });
  const started = Date.now();
  // Per-run agent dir: isolated auth (copied from real ~/.pi/agent auth so the
  // provider key works) + settings pinning granularity. Uses PI_CODING_AGENT_DIR.
  const agentDir = join(work, "agent");
  mkdirSync(agentDir, { recursive: true });
  const realAgentDir = join(process.env.HOME ?? "~", ".pi", "agent");
  for (const f of ["auth.json", "models-store.json"]) {
    try { cpSync(join(realAgentDir, f), join(agentDir, f)); } catch { /* ignore */ }
  }
  const settings = {
    freshctx: { mode: "native", selectionGranularity: mode },
    compaction: { enabled: false },
    retry: { enabled: false },
  };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  const cli = join(repoRoot, "fresh-test.sh");
  const args = ["-p", prompt, "--model", model];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  let stdout = "", stderr = "", exitCode = null, timedOut = false;
  try {
    const r = spawnSync("bash", [cli, ...args], { cwd: join(work, "repo"), env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    stdout = (r.stdout ?? "").slice(-8000);
    stderr = (r.stderr ?? "").slice(-8000);
    exitCode = r.status;
    timedOut = r.error?.code === "ETIMEDOUT";
  } catch (e) {
    stderr = String(e).slice(-2000);
  }
  const wallMs = Date.now() - started;
  // External success: deterministic verify.sh in the mutated repo.
  let verify = { status: "NO_VERIFY", code: null, output: "" };
  if (verifyRel) {
    try {
      const v = spawnSync("bash", [join(taskDir, "verify.sh"), join(work, "repo")], { encoding: "utf8", timeout: 120000 });
      verify = { status: v.status === 0 ? "PASS" : "FAIL", code: v.status, output: ((v.stdout ?? "") + (v.stderr ?? "")).slice(-3000) };
    } catch (e) {
      verify = { status: "ERROR", code: null, output: String(e).slice(-1000) };
    }
  }
  // Session artifacts: newest session jsonl written during this run.
  const sm = collectSessionMetrics(started);
  const driftBlocked = sm.requestVerdictCounts?.driftBlocked ?? 0;
  const contract = loadTaskContract(taskDir, readFileSync, existsSync);
  let contractResult = { ok: true, failures: [] };
  if (contract) {
    const sessionEntries = sm.sessionFile
      ? readFileSync(sm.sessionFile, "utf8").split("\n").filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean)
      : [];
    contractResult = evaluateTaskContract(contract, sessionEntries, verify.status);
  }
  const success = runSucceeded({
    verifyStatus: verify.status,
    timedOut,
    exitCode,
    driftBlocked,
    contractOk: contractResult.ok,
  });
  return {
    schema: "freshctx-ab-pilot/4",
    task: taskId,
    mode,
    model,
    success,
    verifyStatus: verify.status,
    verifyCode: verify.code,
    contract: contract
      ? { id: contract.id ?? null, ok: contractResult.ok, failures: contractResult.failures }
      : null,
    // Infrastructure/correctness gate: WRONG blocked, timeout, nonzero CLI,
    // or contract failure marks the run.
    infraError:
      !contractResult.ok
        ? "contract-failed"
        : driftBlocked > 0 || timedOut || exitCode !== 0
          ? (timedOut ? "timeout" : driftBlocked > 0 ? "drift-blocked" : "nonzero-exit")
          : null,
    turns: sm.turns,
    toolCalls: sm.toolCalls,
    inputTokens: sm.inputTokens,
    outputTokens: sm.outputTokens,
    cacheReadTokens: sm.cacheRead,
    cacheWriteTokens: sm.cacheWrite,
    cost: sm.cost,
    wallTimeMs: wallMs,
    compactions: sm.compactions,
    timeoutMs,
    exitCode,
    timedOut,
    engine: engineIdentity(),
    builds: buildIdentities(),
    freshness: {
      requestVerdictCounts: sm.requestVerdictCounts,
      unitStateCounts: sm.unitStateCounts,
      plans: sm.plans,
      selectedFiles: sm.selectedFiles,
      structural: sm.structural,
      trajectoryDiverged: null, // set by paired-run analysis, not per run
    },
    runOrder: { seq, seed },
    settings: { selectionGranularity: mode, compaction: false },
    workDir: work,
    sessionFile: sm.sessionFile,
    perTurn: sm.perTurn,
    verifyOutput: verify.output,
    cliStdoutTail: stdout,
    cliStderrTail: stderr,
  };
}

const orderSeed = Number(arg("seed", "7"));
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seed = orderSeed;

const tasks = selectTaskIds(listTasks(), taskFilter);
if (tasks.length === 0) throw new Error("no tasks found");
const reps = Number(arg("reps", "1"));
mkdirSync(dirname(outPath), { recursive: true });
const engine = engineIdentity();
const builds = buildIdentities();
console.log(`engine: ${engine.bin} sha=${(engine.sha256 ?? "?").slice(0, 12)} version=${engine.version ?? "?"}`);
console.log(`fresh: head=${builds.fresh.head} dirty=${builds.fresh.dirty} fp=${(builds.fresh.fingerprint ?? "?").slice(0, 12)}`);
console.log(`freshctx: head=${builds.freshctx.head} dirty=${builds.freshctx.dirty} fp=${(builds.freshctx.fingerprint ?? "?").slice(0, 12)}`);
console.log(`model=${model} modes=${modes.join(",")} tasks=${tasks.join(",")} seed=${seed} reps=${reps}`);
let seq = 0;
const rng = mulberry32(seed);
const orderModes = (i) => {
  if (order === "alternate" && i % 2 === 1) return [...modes].reverse();
  if (order === "random") {
    const shuffled = [...modes];
    for (let k = shuffled.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
    }
    return shuffled;
  }
  return modes;
};
for (let rep = 1; rep <= reps; rep++) {
  for (let i = 0; i < tasks.length; i++) {
    for (const mode of orderModes(i + (rep - 1) * tasks.length)) {
      seq++;
      console.log(`[${seq}] rep=${rep} task=${tasks[i]} mode=${mode}`);
      const rec = runOne(tasks[i], mode, seq);
      rec.rep = rep;
      writeFileSync(outPath, JSON.stringify(rec) + "\n", { flag: "a" });
      console.log(`    -> ${rec.verifyStatus} wall=${rec.wallTimeMs}ms`);
    }
  }
}
console.log(`wrote ${outPath}`);

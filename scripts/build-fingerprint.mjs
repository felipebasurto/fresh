#!/usr/bin/env node
// Deterministic working-tree fingerprint for experiment reproducibility.
// Covers: git HEAD, staged+unstaged diff of relevant paths, and contents of
// relevant untracked source files. Output is metadata only (hashes).
//
// Usage:
//   node scripts/build-fingerprint.mjs --root /path/to/repo [--paths "packages/coding-agent/src,scripts/..."] [--name fresh]
//   -> prints JSON {name, head, dirty, fingerprint}
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}

const root = arg("root", process.cwd());
const name = arg("name", "build");
// Comma-separated path prefixes (repo-relative) relevant to the experiment.
// Everything else (docs, editor state, session logs) is excluded so cosmetic
// changes do not invalidate fingerprints.
const paths = arg("paths", "packages/coding-agent/src,packages/ai/src,packages/agent/src,scripts/freshctx-ab-pilot.mjs")
  .split(",").map((s) => s.trim()).filter(Boolean);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000 });
  } catch (e) {
    return null;
  }
}

const head = (git(["rev-parse", "HEAD"]) ?? "").trim() || null;
const status = git(["status", "--porcelain=v1", "-uall", "--", ...paths]) ?? "";
const diffStaged = git(["diff", "--cached", "--no-color", "--", ...paths]) ?? "";
const diffUnstaged = git(["diff", "--no-color", "--", ...paths]) ?? "";

// Untracked source files under relevant paths: hash path+contents deterministically.
const untracked = [];
for (const line of status.split("\n")) {
  if (!line.startsWith("??")) continue;
  untracked.push(line.slice(3).trim());
}
untracked.sort();
const untrackedHashes = [];
for (const rel of untracked) {
  // Only source-ish files count; ignore stray logs/pyc.
  if (!/\.(mjs|cjs|js|ts|tsx|json|sh|py|md)$/.test(rel)) continue;
  try {
    const bytes = readFileSync(`${root}/${rel}`);
    untrackedHashes.push(`${rel}:${createHash("sha256").update(bytes).digest("hex")}`);
  } catch { /* unreadable: record absence */ untrackedHashes.push(`${rel}:unreadable`); }
}

const dirty = status.trim().length > 0;
const h = createHash("sha256");
h.update(`head:${head}\n`);
h.update(`paths:${paths.join(",")}\n`);
h.update(`status:\n${status}\n`);
h.update(`diff-cached:\n${diffStaged}\n`);
h.update(`diff-unstaged:\n${diffUnstaged}\n`);
h.update(`untracked:\n${untrackedHashes.join("\n")}\n`);
console.log(JSON.stringify({ name, head, dirty, fingerprint: h.digest("hex"), relevantPaths: paths }));

#!/usr/bin/env node
// rulemap's optional Stop hook. `rulemap setup --hook project|local` copies it
// into a project's .claude/rulemap/, beside a copy of the CLI, so it runs for
// anyone on the project whether or not they have the plugin.
//
// When code a page cites has changed since the page was last delivered, it
// sends the agent back once to update it; after that it lets the stop through
// and warns the user instead, so it can never loop.
//
// RULEMAP_HOOK=off (e.g. under "env" in .claude/settings.local.json) pauses it.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "rulemap.mjs");
const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { cwd: root, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function main() {
  if (process.env.RULEMAP_HOOK === "off") return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    input = {};
  }

  const list = run(["specs"]);
  if (list.status === 3) return; // not set up
  if (list.status !== 0) throw new Error((list.err || list.out).trim() || `specs exited ${list.status}`);

  const lines = [];
  for (const spec of JSON.parse(list.out).specs) {
    const r = run(["stale", spec]);
    if (r.status !== 0 && r.status !== 2) throw new Error(`${spec}: ${(r.err || r.out).trim()}`);
    const s = JSON.parse(r.out);
    if (!s.stale) continue;
    lines.push(`${spec}:`);
    if (s.html === "missing") lines.push("  - the HTML is missing or was not built by deliver");
    if (s.html === "behind-spec") lines.push("  - the JSON was edited since the last deliver");
    for (const f of s.features) lines.push(`  - ${f.id}: cited code changed (${f.paths.join(", ")})`);
    for (const u of s.uncited) lines.push(`  - ${u.path} (${u.status}): watched but cited by no feature; a new or moved rule?`);
  }
  if (!lines.length) return;

  const cli = path.relative(root, CLI).split(path.sep).join("/");
  const text = [
    "rulemap pages are behind the code. Use the rulemap skill: audit each flagged feature",
    `(node ${cli} branches <spec> --changed), update its rules and questions, then`,
    `node ${cli} deliver <spec> --stamp. If no rule changed, still deliver: that records the code as reviewed.`,
    "",
    ...lines,
  ].join("\n");

  if (input.stop_hook_active) {
    // Already sent back once this turn: never loop, tell the user instead.
    console.log(JSON.stringify({ systemMessage: text }));
  } else {
    console.log(JSON.stringify({ decision: "block", reason: text }));
  }
}

try {
  main();
} catch (e) {
  console.log(JSON.stringify({ systemMessage: `rulemap hook failed: ${e.message}` }));
}
process.exitCode = 0;

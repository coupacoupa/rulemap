#!/usr/bin/env node
// Stop hook: when code a project's decision tables cite has changed since the
// page was last delivered, send the agent back once to bring it up to date.
// After one retry it lets the stop through and warns the user instead, so it
// can never loop.
//
// Silent in any project without a spec, so installing the plugin changes
// nothing until a project opts in by creating one.
//
//   DECISION_TABLES_SPEC  spec path relative to the project root
//                         (default: docs/architecture/feature-decisions.json)
//   DECISION_TABLES_HOOK  set to "off" to disable the hook
//
// Set either in the project's .claude/settings.json under "env".

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DT = path.join(here, "..", "skills", "decision-tables", "bin", "decision-tables.mjs");
const root = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const SPEC = process.env.DECISION_TABLES_SPEC || "docs/architecture/feature-decisions.json";

function describe(s) {
  const out = [`Feature decisions (${SPEC}) are behind the code. Use the decision-tables skill.`];
  if (s.html === "missing") out.push("  - the HTML is missing or was not built by deliver");
  if (s.html === "behind-spec") out.push("  - the JSON was edited since the last deliver");
  for (const f of s.features) out.push(`  - ${f.id}: cited code changed (${f.paths.join(", ")})`);
  for (const u of s.uncited) out.push(`  - ${u.path} (${u.status}): watched but cited by no feature; a new or moved rule?`);
  out.push(`  Audit every flagged feature as the skill describes (start with: node "${DT}" branches ${SPEC} --changed),`);
  out.push(`  update rules and questions, then: node "${DT}" deliver ${SPEC} --stamp`);
  out.push("  If no rule changed, still deliver: that records the new code as reviewed.");
  return out.join("\n");
}

function main() {
  if (process.env.DECISION_TABLES_HOOK === "off") return;
  if (!existsSync(path.join(root, SPEC))) return;

  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    input = {};
  }

  const r = spawnSync(process.execPath, [DT, "stale", SPEC, "--json"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0 && r.status !== 2) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.status}`);
  const s = JSON.parse(r.stdout);
  if (!s.stale) return;

  const text = describe(s);
  if (input.stop_hook_active) {
    // Already sent back once this turn: never loop, tell the user instead.
    console.log(JSON.stringify({ systemMessage: text }));
  } else {
    console.log(JSON.stringify({ decision: "block", reason: `Bring the decision tables up to date before finishing.\n\n${text}` }));
  }
}

try {
  main();
} catch (e) {
  console.log(JSON.stringify({ systemMessage: `decision-tables hook failed: ${e.message}` }));
}
process.exitCode = 0;

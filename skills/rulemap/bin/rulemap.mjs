#!/usr/bin/env node
// Renders a rulemap spec (decision tables as JSON) into one standalone HTML page, and
// reports which features went stale when the code they cite changed.
// No dependencies: Node 18+ and git.

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";

const USAGE = `rulemap <command> <spec.json> [out.html] [options]

  validate <spec.json>              check the spec, its rules and its source citations
  deliver  <spec.json> [out.html]   validate, then write the HTML (default: meta.output beside the spec)
  stale    <spec.json> [out.html]   features whose cited code changed since the last deliver (exit 2)
  stamp    <spec.json>              pin meta.repository.revision to HEAD
  branches <spec.json> [--feature <id>]... [--changed]
                                    every decision point in the cited code or spec, to audit rule coverage
  specs                             this project's specs, from its setup (exit 3 = not set up)
  setup --dir <path> [--layout area|single] [--hook none|project|local]
                                    where pages live, and whether a Stop hook keeps them in sync

  --repo-root <dir>   repository root (default: git toplevel of the spec, else the current directory)
  --stamp             deliver: pin the revision to HEAD first
  --checklist         validate, deliver: check every feature against the project checklist, not only planned ones
  --json              machine-readable output`;

const TONES = new Set(["pos", "neg", "warn", "info", "neutral"]);
const ANY = "*";
// A value label like "ASSIGNED or EN_ROUTE" or "accepts / assigns" hides two conditions in one.
const JOINED = /\s(or)\s|\s\/\s|,\s*or\b/i;
const LOCK_ID = "rulemap-lock";
// Whose condition an input describes: the people who use the app, plus "system"
// for what no person controls (payment gateway, cron, env flags). A spec names
// its own in meta.actors; this is the fallback.
const DEFAULT_ACTORS = { user: "User", admin: "Admin", system: "System" };
const actorsOf = (spec) => (spec.meta?.actors && typeof spec.meta.actors === "object" && !Array.isArray(spec.meta.actors) ? spec.meta.actors : DEFAULT_ACTORS);
// How bad an open question is, worst first. Drives badge colour and list order.
const SEVERITY = {
  critical: { label: "Critical", rank: 0, hint: "money lost or moved wrongly, a security hole, or someone left stranded" },
  major: { label: "Major", rank: 1, hint: "wrong behaviour users will hit, with a workaround or limited reach" },
  minor: { label: "Minor", rank: 2, hint: "unclear intent, doc drift, or an unexplained number" },
};
// An uncovered combination is a real gap in the code, so it defaults to major.
const GAP_SEVERITY = "major";
// A feature is mapped from code that exists, or planned from a spec that describes code to come.
const STATUSES = new Set(["built", "planned"]);
// Directories never worth hashing when there is no git to list files.
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".turbo", "dist", "build", "coverage"]);

// ---------------------------------------------------------------- helpers

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const lines = (s) => (s ?? "").split(/\r?\n/).filter(Boolean);

function git(root, args, input) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      maxBuffer: 64 << 20,
    });
  } catch {
    return null;
  }
}

function cartesian(lists) {
  return lists.reduce((acc, list) => acc.flatMap((a) => list.map((v) => [...a, v])), [[]]);
}

function load(specPath) {
  const text = readFileSync(specPath, "utf8");
  return { text, spec: JSON.parse(text), sha: sha256(text) };
}

function outPath(specPath, spec, explicit) {
  return explicit ?? path.join(path.dirname(specPath), spec.meta?.output ?? path.basename(specPath, ".json") + ".html");
}

// Every file whose change could alter a rule: the watched prefixes plus
// everything cited, less the page's own spec and HTML (which often sit in a
// watched folder). Hashed from the working tree, so uncommitted edits count.
function watchedFiles(spec, root, own = []) {
  const skip = new Set(own.map((p) => path.relative(root, p).split(path.sep).join("/")));
  const prefixes = spec.meta?.watch ?? [];
  const tracked = listFiles(root, prefixes);
  const files = new Set(tracked.filter((p) => prefixes.some((w) => p.startsWith(w))));
  for (const f of spec.features ?? []) for (const s of f.sources ?? []) if (s.path) files.add(s.path);
  return [...files].filter((p) => !skip.has(p) && existsSync(path.join(root, p))).sort();
}

// Files git would list, or outside a repository, a walk of the watched paths.
function listFiles(root, prefixes) {
  const out = git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (out !== null) return lines(out);
  const found = [];
  const walk = (rel) => {
    let st;
    try { st = statSync(path.join(root, rel)); } catch { return; }
    if (st.isFile()) found.push(rel.split(path.sep).join("/"));
    else if (st.isDirectory()) for (const name of readdirSync(path.join(root, rel))) if (!SKIP_DIRS.has(name)) walk(path.join(rel, name));
  };
  for (const p of prefixes) walk(p);
  return found;
}

function hashFiles(root, files) {
  if (!files.length) return {};
  const out = git(root, ["hash-object", "--stdin-paths"], files.join("\n") + "\n");
  if (out === null) return Object.fromEntries(files.map((f) => [f, `sha256:${sha256(readFileSync(path.join(root, f)))}`]));
  const hashes = lines(out);
  return Object.fromEntries(files.map((f, i) => [f, hashes[i]]));
}

// ---------------------------------------------------------------- validate

// The project's checklist: conditions and existing changes every planned feature must decide or
// rule out. Optional; written by hand or drafted at setup.
function readChecklist(root) {
  const file = path.join(root, CHECKLIST);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { invalid: e.message };
  }
}

function validate(spec, root, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

  const unique = (list, where) => {
    const seen = new Set();
    for (const x of list) {
      if (!x?.id) err(where, "every entry needs an id");
      else if (seen.has(x.id)) err(where, `duplicate id "${x.id}"`);
      else seen.add(x.id);
    }
  };

  if (spec.schema_version !== 1) err("schema_version", "must be 1");
  const meta = spec.meta ?? {};
  if (!meta.title) err("meta.title", "required");
  if (meta.actors !== undefined) {
    const ok = meta.actors && typeof meta.actors === "object" && !Array.isArray(meta.actors) && Object.keys(meta.actors).length > 0;
    if (!ok) err("meta.actors", `must be an object of id -> label, e.g. { "customer": "Customer", "system": "System" }`);
    else for (const [id, label] of Object.entries(meta.actors)) if (!/^[a-z][a-z0-9-]*$/.test(id) || typeof label !== "string" || !label) err("meta.actors", `"${id}" needs a lowercase id and a label`);
  } else warn("meta.actors", `not set; using ${Object.keys(DEFAULT_ACTORS).join(", ")}. Name the people who use this app`);
  const ACTORS = actorsOf(spec);
  const rev = meta.repository?.revision;
  if (rev && !/^[0-9a-f]{40}$/.test(rev)) err("meta.repository.revision", "must be a full 40-character commit SHA");
  if (rev && git(root, ["cat-file", "-e", `${rev}^{commit}`]) === null) err("meta.repository.revision", `${rev.slice(0, 7)} is not a commit in this repository`);

  const groups = spec.groups ?? [];
  unique(groups, "groups");
  const groupIds = new Set(groups.map((g) => g.id));

  const questions = spec.questions ?? [];
  unique(questions, "questions");
  const qIds = new Set(questions.map((q) => q.id));
  for (const q of questions) {
    if (!q.text) err(`questions[${q.id}]`, "needs text");
    if (!(q.severity in SEVERITY)) err(`questions[${q.id}]`, `severity must be one of ${Object.keys(SEVERITY).join(", ")}`);
    if (q.answer !== undefined && (typeof q.answer !== "string" || !q.answer.trim())) err(`questions[${q.id}]`, "answer must be text; leave it out while the question is open");
  }

  const checklist = readChecklist(root);
  let items = [];
  if (checklist?.invalid) err(CHECKLIST, `is not valid JSON: ${checklist.invalid}`);
  else if (checklist) {
    items = Array.isArray(checklist.items) ? checklist.items : [];
    if (!Array.isArray(checklist.items)) err(CHECKLIST, `needs "items": a list of { id, label, ask? }`);
    unique(items, CHECKLIST);
    for (const it of items) if (!it.label) err(CHECKLIST, `item "${it.id}" needs a label`);
  }
  const itemById = new Map(items.map((it) => [it.id, it]));
  const checks = [];
  // Items ruled out for the whole page (an area that only exists in one region, say).
  const pageSkips = meta.skips ?? {};
  if (typeof pageSkips !== "object" || Array.isArray(pageSkips)) err("meta.skips", "must be an object of checklist id -> reason");
  else for (const [id, why] of Object.entries(pageSkips)) {
    if (id !== ANY && !itemById.has(id)) err("meta.skips", checklist ? `skips "${id}", which is not in ${CHECKLIST}` : `skips "${id}", but the project has no ${CHECKLIST}`);
    else if (typeof why !== "string" || !why.trim()) err("meta.skips", `skips "${id}" without saying why it cannot matter`);
  }

  const features = spec.features ?? [];
  if (!features.length) err("features", "at least one feature is required");
  unique(features, "features");

  const refs = new Map(); // question id -> [{anchor, label}]
  const addRef = (qid, where, anchor, label) => {
    if (!qIds.has(qid)) return err(where, `unknown question "${qid}"`);
    if (!refs.has(qid)) refs.set(qid, []);
    if (!refs.get(qid).some((r) => r.anchor === anchor)) refs.get(qid).push({ anchor, label });
  };
  const gaps = [];
  const model = [];

  for (const f of features) {
    const fw = `features[${f.id}]`;
    if (!f.name) err(fw, "needs a name");
    if (!f.summary) err(fw, "needs a one-sentence summary");
    else if (f.summary.length > 180) warn(fw, `summary is ${f.summary.length} chars; keep it to one short sentence`);
    if (groupIds.size && !groupIds.has(f.group)) err(fw, `group "${f.group}" is not in groups`);
    if (f.status !== undefined && !STATUSES.has(f.status)) err(fw, `status must be one of ${[...STATUSES].join(", ")}`);
    const fAnchor = `f-${f.id}`;
    for (const q of f.q ?? []) addRef(q, fw, fAnchor, f.name);

    const sources = [];
    for (const [i, s] of (f.sources ?? []).entries()) {
      const sw = `${fw}.sources[${i}]`;
      if (!s.path) { err(sw, "needs a path"); continue; }
      const abs = path.join(root, s.path);
      if (!existsSync(abs)) { err(sw, `${s.path} does not exist`); continue; }
      if (s.symbol && symbolLine(s.path, readFileSync(abs, "utf8"), s.symbol) === null) err(sw, `"${s.symbol}" is not in ${s.path}`);
      let line = null;
      let pinned = false;
      if (rev) {
        const atRev = git(root, ["show", `${rev}:${s.path}`]);
        if (atRev === null) {
          if (meta.repository?.url) warn(sw, `${s.path} is not in ${rev.slice(0, 7)}; it links to the local file until committed and stamped`);
        } else {
          pinned = true;
          if (s.symbol) line = symbolLine(s.path, atRev, s.symbol);
        }
      }
      sources.push({ ...s, line, pinned });
    }
    if (!sources.length && f.status !== "planned") warn(fw, "cites no source; stale cannot track it");

    const tables = f.tables ?? [];
    if (!tables.length) err(fw, "needs at least one table");
    unique(tables, `${fw}.tables`);
    const tModels = [];
    // Checklist items this feature decides: named by `covers` on an input or a value.
    const covered = new Set();
    const cover = (x, where) => {
      for (const id of [x.covers ?? []].flat()) {
        if (itemById.has(id)) covered.add(id);
        else err(where, checklist ? `covers "${id}", which is not in ${CHECKLIST}` : `covers "${id}", but the project has no ${CHECKLIST}`);
      }
    };
    for (const t of tables) {
      const tw = `${fw}.tables[${t.id}]`;
      const anchor = `${fAnchor}-${t.id}`;
      const inputs = t.inputs ?? [];
      const outputs = t.outputs ?? [];
      const rules = t.rules ?? [];
      if (!inputs.length) err(tw, "needs at least one input");
      if (!outputs.length) err(tw, "needs at least one output");
      unique(inputs, `${tw}.inputs`);
      unique(outputs, `${tw}.outputs`);
      const inVals = new Map(inputs.map((x) => [x.id, new Set((x.values ?? []).map((v) => v.id))]));
      const outVals = new Map(outputs.map((x) => [x.id, new Set((x.values ?? []).map((v) => v.id))]));
      for (const x of inputs) { unique(x.values ?? [], `${tw}.inputs[${x.id}].values`); if (!x.values?.length) err(tw, `input "${x.id}" has no values`); }
      const checkActor = (x, where, required) => {
        if (x.actor === undefined) {
          if (required) err(where, `needs an actor: one of ${Object.keys(ACTORS).join(", ")}, or a list of them`);
          if (x.as !== undefined) err(where, `"as" needs an actor`);
          return;
        }
        const list = [x.actor].flat();
        if (!list.length || list.some((a) => !(a in ACTORS))) err(where, `actor must be one of ${Object.keys(ACTORS).join(", ")}, or a list of them`);
        if (x.as !== undefined && list.length !== 1) err(where, `"as" names one person, so actor must be a single role`);
      };
      for (const x of inputs) {
        checkActor(x, `${tw}.inputs[${x.id}]`, true);
        cover(x, `${tw}.inputs[${x.id}]`);
        for (const v of x.values ?? []) {
          checkActor(v, `${tw}.inputs[${x.id}].values[${v.id}]`, false);
          cover(v, `${tw}.inputs[${x.id}].values[${v.id}]`);
        }
      }
      for (const x of [...inputs, ...outputs]) {
        for (const v of x.values ?? []) if (JOINED.test(v.label ?? "")) warn(tw, `"${v.label}" joins several conditions; give each its own value`);
      }
      for (const x of outputs) {
        unique(x.values ?? [], `${tw}.outputs[${x.id}].values`);
        for (const v of x.values ?? []) if (v.tone && !TONES.has(v.tone)) err(tw, `tone "${v.tone}" must be one of ${[...TONES].join(", ")}`);
      }

      for (const [i, r] of rules.entries()) {
        const rw = `${tw}.rules[${i}]`;
        for (const [k, cond] of Object.entries(r.when ?? {})) {
          if (!inVals.has(k)) { err(rw, `unknown input "${k}"`); continue; }
          if (cond === ANY) continue;
          if (typeof cond !== "string") { err(rw, `input "${k}" must name one value (or "*"); write one rule per value`); continue; }
          if (!inVals.get(k).has(cond)) err(rw, `input "${k}" has no value "${cond}"`);
        }
        if (r.impossible) {
          if (r.then) err(rw, "an impossible rule sets no outputs");
        } else {
          for (const o of outputs) {
            const v = r.then?.[o.id];
            if (v === undefined) err(rw, `missing output "${o.id}"`);
            else if (!outVals.get(o.id)?.has(v)) err(rw, `output "${o.id}" has no value "${v}"`);
          }
          for (const k of Object.keys(r.then ?? {})) if (!outVals.has(k)) err(rw, `unknown output "${k}"`);
        }
      }

      const combos = cartesian(inputs.map((x) => (x.values ?? []).map((v) => v.id)));
      if (combos.length > 64) warn(tw, `${combos.length} combinations; split it into smaller tables`);
      const hit = t.hit ?? "unique";
      if (!["unique", "first"].includes(hit)) err(tw, `hit must be "unique" or "first"`);
      const describe = (combo) => inputs.map((x, k) => `${x.label} = ${x.values.find((v) => v.id === combo[k])?.label}`).join(", ");
      const matches = (r, combo) => inputs.every((x, k) => {
        const c = r.when?.[x.id] ?? ANY;
        return c === ANY || c === combo[k];
      });

      const grid = inputs.length === 2 && t.view !== "rules";
      const cells = combos.map((combo, ci) => {
        const hits = rules.flatMap((r, i) => (matches(r, combo) ? [i] : []));
        if (hits.length > 1 && hit === "unique") {
          err(tw, `rules ${hits.map((x) => x + 1).join(" and ")} both match ${describe(combo)}; make them disjoint or set "hit": "first"`);
        }
        return { combo, rule: hits.length ? hits[0] : null, anchor: `${anchor}-c${ci + 1}` };
      });

      const uncovered = cells.filter((c) => c.rule === null);
      for (const [k, c] of uncovered.entries()) {
        warn(tw, `no rule for ${describe(c.combo)}`);
        if (!grid) c.anchor = `${anchor}-u${k + 1}`;
        const id = `U${gaps.length + 1}`;
        c.gap = id;
        gaps.push({ id, severity: GAP_SEVERITY, text: `No rule covers ${describe(c.combo)}.`, refs: [{ anchor: c.anchor, label: `${f.name} · ${t.title ?? t.id}` }] });
      }

      for (const [i, r] of rules.entries()) {
        const first = cells.find((c) => c.rule === i);
        if (!first) warn(`${tw}.rules[${i}]`, "never applies: shadowed by an earlier rule or matches nothing");
        const target = grid && first ? first.anchor : `${anchor}-r${i + 1}`;
        for (const q of r.q ?? []) addRef(q, `${tw}.rules[${i}]`, target, `${f.name} · ${t.title ?? t.id} · rule ${i + 1}`);
      }

      tModels.push({ t, anchor, inputs, outputs, rules, cells, grid });
    }
    // Checklist items ruled out, each with the reason it cannot change this feature's outcome.
    const skips = f.skips ?? {};
    if (typeof skips !== "object" || Array.isArray(skips)) err(fw, `skips must be an object of checklist id -> reason`);
    else for (const [id, why] of Object.entries(skips)) {
      if (id !== ANY && !itemById.has(id)) err(fw, checklist ? `skips "${id}", which is not in ${CHECKLIST}` : `skips "${id}", but the project has no ${CHECKLIST}`);
      else if (typeof why !== "string" || !why.trim()) err(fw, `skips "${id}" without saying why it cannot matter`);
      else if (covered.has(id)) warn(fw, `both covers and skips "${id}"`);
    }
    // Every item a planned feature (or, with --checklist, any feature) neither decides nor rules out.
    const fChecks = [];
    if (f.status === "planned" || opts.checklistAll) {
      const ruledOut = (list, id) => list && typeof list === "object" && (id in list || ANY in list);
      const missing = items.filter((it) => !covered.has(it.id) && !ruledOut(skips, it.id) && !ruledOut(pageSkips, it.id));
      for (const it of missing) {
        const id = `C${checks.length + 1}`;
        checks.push({ id, severity: GAP_SEVERITY, text: `${f.name} never decides ${it.label}.${it.ask ? ` ${it.ask}` : ""}`, refs: [{ anchor: fAnchor, label: f.name }] });
        fChecks.push(id);
      }
      if (missing.length) warn(fw, `never decides ${missing.length} checklist item${missing.length === 1 ? "" : "s"} (${missing.map((it) => it.id).join(", ")}): cover each with an input or value, or skip it with the reason it cannot matter`);
    }

    model.push({ f, anchor: fAnchor, sources, tables: tModels, checks: fChecks, covered, skips: typeof skips === "object" ? skips : {} });
  }

  return { errors, warnings, model, refs, gaps, checks, items: itemById };
}

// ---------------------------------------------------------------- render

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function render(spec, v, lock, root, htmlPath) {
  const meta = spec.meta;
  const ACTORS = actorsOf(spec);
  const repo = meta.repository ?? {};
  const rev = repo.revision;
  const base = repo.url?.replace(/\/$/, "");
  // On the code host at the pinned commit when it has the file; otherwise the local file, relative to the page.
  const link = (s) => (base && rev && s.pinned
    ? `${base}/blob/${rev}/${s.path}${s.line ? `#L${s.line}` : ""}`
    : encodeURI(path.relative(path.dirname(htmlPath), path.join(root, s.path)).split(path.sep).join("/")));
  const qById = new Map((spec.questions ?? []).map((q) => [q.id, q]));
  // An answered question stays on the page as the record of a decision, but is no longer open.
  const answered = (spec.questions ?? []).filter((q) => q.answer);
  const isOpen = (id) => !qById.get(id)?.answer;
  const openQuestions = (spec.questions ?? []).filter((q) => !q.answer);

  // Generated entries: uncovered combinations (U) and checklist items a feature never decides (C).
  const auto = [...v.gaps, ...v.checks];
  const sevById = new Map([...openQuestions.map((q) => [q.id, q.severity]), ...auto.map((g) => [g.id, g.severity])]);
  const worst = (ids) => ids.map((id) => sevById.get(id)).filter((s) => s in SEVERITY).sort((a, b) => SEVERITY[a].rank - SEVERITY[b].rank)[0] ?? "minor";
  const sevChip = (s) => `<span class="sev s-${esc(s)}">${esc(SEVERITY[s]?.label ?? s)}</span>`;
  const bySeverity = (a, b) => (SEVERITY[a.severity]?.rank ?? 9) - (SEVERITY[b.severity]?.rank ?? 9) || a.id.localeCompare(b.id, undefined, { numeric: true });
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });

  const qMark = (ids) => ids.map((id) => {
    const q = qById.get(id);
    if (q?.answer) return `<a class="qm ans" href="#${esc(id)}" title="${esc(`Answered: ${q.answer}`)}">${esc(id)}</a>`;
    const s = sevById.get(id);
    const text = q?.text ?? auto.find((g) => g.id === id)?.text ?? "";
    return `<a class="qm s-${esc(s)}" href="#${esc(id)}" title="${esc(`${SEVERITY[s]?.label ?? ""}: ${text}`)}">${esc(id)}</a>`;
  }).join("");
  // The outline a cell or row gets for its questions: only open ones count.
  const qClass = (ids) => {
    const open = (ids ?? []).filter(isOpen);
    return open.length ? `has-q s-${worst(open)}` : "";
  };
  const chip = (out, valId) => {
    const val = out.values.find((x) => x.id === valId);
    return `<span class="chip t-${esc(val?.tone ?? "neutral")}">${fmt(val?.label ?? valId)}</span>`;
  };
  // Actor badge for an input, or for a value that belongs to someone else.
  const who = (x) => {
    if (!x?.actor) return "";
    const list = [x.actor].flat();
    return list.map((a) => `<span class="who w-${esc(a)}">${esc(list.length === 1 && x.as ? x.as : ACTORS[a])}</span>`).join("");
  };
  const valLabel = (input, v) => `${who(v)}${fmt(v?.label ?? "")}`;
  const cond = (input, c) => {
    if (c === undefined || c === ANY) return `<span class="any">any</span>`;
    return valLabel(input, input.values.find((x) => x.id === c));
  };

  const openCount = (fm) => {
    const ids = new Set([...(fm.f.q ?? []), ...fm.checks]);
    for (const tm of fm.tables) {
      for (const r of tm.rules) for (const q of r.q ?? []) ids.add(q);
      for (const c of tm.cells) if (c.gap) ids.add(c.gap);
    }
    return [...ids].filter(isOpen);
  };

  const legend = (tm) => {
    const counts = new Map();
    let gaps = 0;
    let imp = 0;
    for (const c of tm.cells) {
      if (c.rule === null) { gaps++; continue; }
      const r = tm.rules[c.rule];
      if (r.impossible) { imp++; continue; }
      for (const o of tm.outputs) counts.set(`${o.id}\u0000${r.then[o.id]}`, (counts.get(`${o.id}\u0000${r.then[o.id]}`) ?? 0) + 1);
    }
    const blocks = tm.outputs.map((o) => `<div class="lg"><div class="lg-h">${fmt(o.label)}</div>${o.values
      .map((val) => `<div class="lg-r"><span class="sw t-${esc(val.tone ?? "neutral")}"></span>${fmt(val.label)}<span class="n">${counts.get(`${o.id}\u0000${val.id}`) ?? 0}</span></div>`)
      .join("")}</div>`);
    const extra = [];
    if (imp) extra.push(`<div class="lg-r"><span class="sw imp"></span>Can't happen<span class="n">${imp}</span></div>`);
    if (gaps) extra.push(`<div class="lg-r"><span class="sw gap"></span>No rule<span class="n">${gaps}</span></div>`);
    if (extra.length) blocks.push(`<div class="lg">${extra.join("")}</div>`);
    return `<aside class="legend">${blocks.join("")}</aside>`;
  };

  const gridView = (tm) => {
    const [rowIn, colIn] = tm.inputs;
    const byKey = new Map(tm.cells.map((c) => [c.combo.join("\u0000"), c]));
    // Pivot-table header: the column axis spans its values; the row axis heads the label column.
    const head = `<tr><th class="axis axis-r" rowspan="2" scope="col">${who(rowIn)}${fmt(rowIn.label)}</th><th class="axis axis-c" colspan="${colIn.values.length}" scope="colgroup">${who(colIn)}${fmt(colIn.label)}</th></tr><tr class="vals">${colIn.values.map((cv) => `<th scope="col">${valLabel(colIn, cv)}</th>`).join("")}</tr>`;
    const body = rowIn.values.map((rv) => `<tr><th scope="row">${valLabel(rowIn, rv)}</th>${colIn.values.map((cv) => {
      const c = byKey.get(`${rv.id}\u0000${cv.id}`);
      if (c.rule === null) return `<td id="${c.anchor}" class="cell gap"><span class="gap-l">?</span><span class="qms">${qMark([c.gap])}</span></td>`;
      const r = tm.rules[c.rule];
      const marks = r.q?.length ? `<span class="qms">${qMark(r.q)}</span>` : "";
      const title = r.note ? ` title="${esc(r.note)}"` : "";
      if (r.impossible) return `<td id="${c.anchor}" class="cell imp"${title}><span class="na">n/a</span>${marks}</td>`;
      const tone = tm.outputs.length === 1 ? ` tone t-${esc(tm.outputs[0].values.find((x) => x.id === r.then[tm.outputs[0].id])?.tone ?? "neutral")}` : " multi";
      const q = qClass(r.q);
      return `<td id="${c.anchor}" class="cell${tone}${q ? ` ${q}` : ""}"${title}>${tm.outputs.map((o) => chip(o, r.then[o.id])).join("")}${marks}</td>`;
    }).join("")}</tr>`).join("");
    return `<div class="gridbox"><div class="scroll"><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>${legend(tm)}</div>`;
  };

  const rulesView = (tm) => {
    const head = `<tr><th class="num">#</th>${tm.inputs.map((x) => `<th>${who(x)}${fmt(x.label)}</th>`).join("")}${tm.outputs.map((o, i) => `<th class="out${i === 0 ? " first" : ""}">${fmt(o.label)}</th>`).join("")}<th class="note">Note</th></tr>`;
    const rows = tm.rules.map((r, i) => `<tr id="${tm.anchor}-r${i + 1}" class="${qClass(r.q)}${r.impossible ? " imp-row" : ""}"><td class="num">${i + 1}</td>${tm.inputs.map((x) => `<td>${cond(x, r.when?.[x.id])}</td>`).join("")}${
      r.impossible
        ? `<td class="out first na" colspan="${tm.outputs.length}">can't happen</td>`
        : tm.outputs.map((o, k) => `<td class="out${k === 0 ? " first" : ""}">${chip(o, r.then[o.id])}</td>`).join("")
    }<td class="note">${fmt(r.note ?? "")}${qMark(r.q ?? [])}</td></tr>`);
    for (const c of tm.cells.filter((c) => c.rule === null && !tm.grid)) {
      rows.push(`<tr id="${c.anchor}" class="gap-row"><td class="num">?</td>${tm.inputs.map((x, k) => `<td>${valLabel(x, x.values.find((v) => v.id === c.combo[k]))}</td>`).join("")}<td class="out first na" colspan="${tm.outputs.length}">no rule</td><td class="note">${qMark([c.gap])}</td></tr>`);
    }
    return `<div class="scroll"><table class="rules"><thead>${head}</thead><tbody>${rows.join("")}</tbody></table></div>`;
  };

  const table = (tm) => {
    const title = tm.t.title ? `<h3>${fmt(tm.t.title)}</h3>` : "";
    if (!tm.grid) return `<div class="tbl" id="${tm.anchor}">${title}${rulesView(tm)}</div>`;
    return `<div class="tbl" id="${tm.anchor}" data-views><div class="tbl-h">${title}<div class="seg"><button type="button" data-show="grid" aria-pressed="true">Grid</button><button type="button" data-show="rules" aria-pressed="false">Rules</button></div></div><div data-view="grid">${gridView(tm)}</div><div data-view="rules" hidden>${rulesView(tm)}</div></div>`;
  };

  const sources = (fm) => fm.sources.map((s) => {
    const label = esc(s.label ?? (s.symbol ? `${s.path.split("/").pop()} · ${s.symbol}` : s.path));
    return `<a href="${esc(link(s))}" title="${esc(s.path)}">${label}</a>`;
  }).join("");

  const planTag = (fm) => (fm.f.status === "planned" ? `<span class="plan" title="From a spec; not built yet">planned</span>` : "");
  const planned = v.model.filter((fm) => fm.f.status === "planned").length;
  const sections = v.model.map((fm) => `<section class="feature" id="${fm.anchor}"><header><h2>${fmt(fm.f.name)}${planTag(fm)}${qMark([...(fm.f.q ?? []), ...fm.checks])}</h2><p>${fmt(fm.f.summary)}</p>${fm.sources.length ? `<details class="src-d"><summary>Sources · ${fm.sources.length}</summary><div class="src">${sources(fm)}</div></details>` : ""}</header>${fm.tables.map(table).join("")}</section>`).join("");

  // Three boxes per menu row, critical → minor; an empty box stays grey.
  const sevBoxes = (ids) => {
    const n = Object.fromEntries(Object.keys(SEVERITY).map((s) => [s, ids.filter((id) => sevById.get(id) === s).length]));
    const title = Object.keys(SEVERITY).map((s) => `${n[s]} ${SEVERITY[s].label.toLowerCase()}`).join(" · ");
    return `<span class="sevs" title="${title}">${Object.keys(SEVERITY).map((s) => `<span class="sb s-${s}${n[s] ? "" : " z"}">${n[s]}</span>`).join("")}</span>`;
  };
  const navItem = (fm) => `<a href="#${fm.anchor}">${fmt(fm.f.name)}${planTag(fm)}${sevBoxes(openCount(fm))}</a>`;
  const groups = spec.groups?.length ? spec.groups : [{ id: null, label: null }];
  const nav = groups.map((g) => {
    const items = v.model.filter((fm) => g.id === null || fm.f.group === g.id);
    if (!items.length) return "";
    return `${g.label ? `<div class="nav-g">${fmt(g.label)}</div>` : ""}${items.map(navItem).join("")}`;
  }).join("");

  const refLinks = (refs) => (refs.length ? `<div class="refs">${refs.map((r) => `<a href="#${r.anchor}">↑ ${fmt(r.label)}</a>`).join("")}</div>` : "");
  const kindTag = (q) => (q.kind ? `<span class="kind k-${esc(q.kind)}">${esc(q.kind)}</span>` : "");
  const qItems = [...openQuestions].sort(bySeverity).map((q) =>
    `<li id="${esc(q.id)}" class="s-${esc(q.severity)}"><div class="q-h"><span class="qid">${esc(q.id)}</span>${sevChip(q.severity)}${kindTag(q)}</div><p>${fmt(q.text)}</p>${refLinks(v.refs.get(q.id) ?? [])}</li>`);
  const gapItems = v.gaps.map((g) => `<li id="${g.id}" class="s-${g.severity}"><div class="q-h"><span class="qid">${g.id}</span>${sevChip(g.severity)}<span class="kind k-gap">unhandled</span></div><p>${fmt(g.text)}</p>${refLinks(g.refs)}</li>`);
  const answeredItems = [...answered].sort(byId).map((q) =>
    `<li id="${esc(q.id)}" class="ans"><div class="q-h"><span class="qid">${esc(q.id)}</span>${kindTag(q)}</div><p>${fmt(q.text)}</p><p class="answer"><span class="answer-l">Answer</span>${fmt(q.answer)}</p>${refLinks(v.refs.get(q.id) ?? [])}</li>`);
  const checkItems = v.checks.map((c) => `<li id="${c.id}" class="s-${c.severity}"><div class="q-h"><span class="qid">${c.id}</span>${sevChip(c.severity)}<span class="kind k-gap">checklist</span></div><p>${fmt(c.text)}</p>${refLinks(c.refs)}</li>`);
  const totalQ = qItems.length + gapItems.length + checkItems.length;
  const allQ = [...openQuestions, ...auto];
  const sevSplit = Object.keys(SEVERITY)
    .map((s) => [s, allQ.filter((q) => q.severity === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => `<span class="sev s-${s}">${n} ${SEVERITY[s].label.toLowerCase()}</span>`)
    .join(" ");
  const sevKey = Object.entries(SEVERITY).map(([s, x]) => `<span>${sevChip(s)} ${esc(x.hint)}</span>`).join("");

  const revLink = rev ? (base ? `<a href="${esc(`${base}/tree/${rev}`)}"><code>${rev.slice(0, 7)}</code></a>` : `<code>${rev.slice(0, 7)}</code>`) : "unpinned";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="rulemap">
<title>${esc(meta.title)}</title>
<style>${CSS}</style>
</head>
<body>
<nav>
  <div class="brand">${esc(meta.title)}</div>
  <div class="nav-list">${nav}</div>
  <a class="nav-q" href="#questions">Open questions${sevBoxes([...sevById.keys()])}</a>
</nav>
<main>
  <header class="top">
    <h1>${esc(meta.title)}</h1>
    <p class="meta">${v.model.length} features${planned ? ` (${planned} planned)` : ""} · ${totalQ} open questions ${sevSplit}${answered.length ? ` · ${answered.length} answered` : ""} · code at ${revLink}</p>
    <p class="who-key">Whose condition: ${Object.entries(ACTORS).map(([a, name]) => `<span class="who w-${a}">${name}</span>`).join("")}</p>
  </header>
  ${sections}
  <section id="questions">
    <h2>Open questions</h2>
    <p class="sev-key">${sevKey}</p>
    ${qItems.length ? `<ol class="qs">${qItems.join("")}</ol>` : `<p class="none">None.</p>`}
    ${gapItems.length ? `<h3>Unhandled combinations</h3><ol class="qs">${gapItems.join("")}</ol>` : ""}
    ${checkItems.length ? `<h3>Not yet checked</h3><ol class="qs">${checkItems.join("")}</ol>` : ""}
    ${answeredItems.length ? `<h3>Answered</h3><ol class="qs">${answeredItems.join("")}</ol>` : ""}
  </section>
</main>
<script type="application/json" id="${LOCK_ID}">${JSON.stringify(lock).replace(/</g, "\\u003c")}</script>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
/* Neutral dev-tool palette. Colour is reserved for signal: green for a yes, and red / orange / yellow for question severity. */
:root{--bg:#fafafa;--panel:#fff;--sunken:#f4f4f5;--ink:#09090b;--ink-2:#3f3f46;--mute:#71717a;--faint:#a1a1aa;--line:#e4e4e7;--line-2:#d4d4d8;
--pos:#16a34a;--ring:#09090b;
--s-critical:#dc2626;--s-critical-bg:rgba(220,38,38,.1);--s-major:#ea580c;--s-major-bg:rgba(234,88,12,.1);--s-minor:#a16207;--s-minor-bg:rgba(202,138,4,.14);
--mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--panel:#111113;--sunken:#18181b;--ink:#fafafa;--ink-2:#d4d4d8;--mute:#a1a1aa;--faint:#71717a;--line:#27272a;--line-2:#3f3f46;
--pos:#4ade80;--ring:#fafafa;
--s-critical:#f87171;--s-critical-bg:rgba(248,113,113,.14);--s-major:#fb923c;--s-major-bg:rgba(251,146,60,.14);--s-minor:#facc15;--s-minor-bg:rgba(250,204,21,.12);color-scheme:dark}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;grid-template-columns:276px minmax(0,1fr);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
code{font:12.5px var(--mono);background:var(--sunken);border:1px solid var(--line);padding:0 4px;border-radius:4px;white-space:nowrap}

nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);padding:18px 12px;font-size:13px;display:flex;flex-direction:column;gap:1px;background:var(--bg)}
.brand{font-weight:600;padding:0 8px 14px;letter-spacing:-.01em}
.nav-g{font-size:11px;font-weight:500;color:var(--faint);padding:14px 8px 4px}
nav a{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;color:var(--ink-2);text-decoration:none}
nav a:hover{background:var(--sunken);color:var(--ink)}
nav a.on{background:var(--sunken);color:var(--ink);font-weight:500;box-shadow:inset 2px 0 0 var(--ink)}
.sevs{margin-left:auto;display:flex;gap:3px;flex:none}
.sb{min-width:20px;text-align:center;font:500 10.5px/1.7 var(--mono);border-radius:4px;padding:0 3px}
.sb.s-critical{background:var(--s-critical-bg);color:var(--s-critical)}
.sb.s-major{background:var(--s-major-bg);color:var(--s-major)}
.sb.s-minor{background:var(--s-minor-bg);color:var(--s-minor)}
.sb.z{background:transparent;color:var(--line-2);box-shadow:inset 0 0 0 1px var(--line)}
.nav-q{margin-top:auto;border-top:1px solid var(--line);border-radius:0!important;padding-top:12px!important}
.badge{margin-left:auto;font:500 11px/1.6 var(--mono);min-width:20px;text-align:center;padding:0 6px;border-radius:5px;background:var(--sunken);color:var(--mute);border:1px solid var(--line)}

main{padding:32px 40px 96px;min-width:0}
.top h1{margin:0;font-size:20px;font-weight:600;letter-spacing:-.02em}
.meta{margin:6px 0 0;color:var(--mute);font-size:13px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
section.feature{padding-top:40px;margin-top:32px;border-top:1px solid var(--line)}
section.feature h2{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:6px}
section.feature header p{margin:6px 0 0;color:var(--mute);max-width:72ch}
.src{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;font:12px var(--mono)}
.src a,.src span{border:1px solid var(--line);border-radius:5px;padding:1px 7px;background:var(--panel);color:var(--ink-2);text-decoration:none}
.src a:hover{border-color:var(--line-2);color:var(--ink)}
.src span{color:var(--mute)}
.src-d{margin-top:8px}
.src-d>summary{display:inline-block;cursor:pointer;font-size:12px;color:var(--faint);list-style:none}
.src-d>summary::-webkit-details-marker{display:none}
.src-d>summary:hover{color:var(--mute)}
.src-d[open]>summary{color:var(--mute)}

.tbl{margin-top:22px}
.tbl-h{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.tbl h3{margin:0 0 10px;font-size:13px;font-weight:500;color:var(--ink-2)}
.tbl-h h3{margin:0}
.seg{margin-left:auto;display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel)}
.seg button{font:inherit;font-size:12px;border:0;background:transparent;color:var(--mute);padding:3px 10px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--sunken);color:var(--ink);font-weight:500}
.scroll{overflow-x:auto}
table{border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}
th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
tr:last-child>*{border-bottom:0}
thead th{font-size:12px;font-weight:500;color:var(--mute);background:var(--bg)}

.gridbox{display:flex;gap:16px 28px;align-items:flex-start;flex-wrap:wrap}
.gridbox>.scroll{flex:0 1 auto;min-width:0;max-width:100%}
.gridbox>.legend{flex:0 0 auto}
.grid th[scope=row]{font-weight:500;background:var(--bg);white-space:nowrap}
.grid td+td,.grid th+th,.grid th+td{border-left:1px solid var(--line)}
.grid .axis{font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);background:var(--bg)}
.grid .axis .who{text-transform:lowercase;letter-spacing:0}
.grid .axis-r{vertical-align:bottom;white-space:nowrap}
.grid .axis-c{text-align:center;border-left:1px solid var(--line)}
.grid tr.vals th{border-left:1px solid var(--line)}
/* Same padding on every cell: question tags sit in the top band, so values stay centred whether or not a cell has one. */
.grid td.cell{position:relative;min-width:84px;text-align:center;vertical-align:middle;padding:20px 10px}

/* Outcomes: neutral text with a status glyph. Filled green = yes, hollow = no, half = conditional, none = a plain value. */
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--ink)}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;flex:none}
.chip.t-pos::before{background:var(--pos)}
.chip.t-neg{color:var(--mute);font-weight:400}
.chip.t-neg::before{box-shadow:inset 0 0 0 1.5px var(--faint)}
.chip.t-warn::before{background:linear-gradient(90deg,var(--ink-2) 50%,transparent 50%);box-shadow:inset 0 0 0 1.5px var(--ink-2)}
.chip.t-info::before,.chip.t-neutral::before{display:none}
.cell.multi .chip{display:flex;justify-content:center;margin:3px auto}
.imp,.sw.imp{background:repeating-linear-gradient(135deg,var(--sunken) 0 4px,transparent 4px 8px)}
.na{color:var(--faint);font-style:italic;font-size:12px}
.gap{background:var(--panel);outline:1.5px dashed var(--s-major);outline-offset:-5px}
.gap-l{font:600 13px var(--mono);color:var(--s-major)}

/* Question tags: grey by default, tinted by severity. */
.qm{display:inline-block;font:600 10px/1 var(--mono);padding:3px 5px;margin-left:6px;border-radius:4px;text-decoration:none;vertical-align:middle;background:var(--sunken);color:var(--mute);border:1px solid var(--line)}
.qm:hover{border-color:currentColor}
.cell .qms{position:absolute;top:3px;right:4px;display:flex;gap:3px}
.cell .qm{margin:0}
.qm.s-critical,.badge.s-critical,.sev.s-critical{background:var(--s-critical-bg);color:var(--s-critical);border-color:transparent}
/* Menu counts stay grey unless the feature has a critical question. */
.qm.s-major,.sev.s-major{background:var(--s-major-bg);color:var(--s-major);border-color:transparent}
.qm.s-minor,.sev.s-minor{background:var(--s-minor-bg);color:var(--s-minor);border-color:transparent}
/* Anything carrying a question gets a border in its worst severity's colour: a grid cell, or a whole rules row. */
.has-q.s-critical{--q-c:var(--s-critical)}.has-q.s-major{--q-c:var(--s-major)}.has-q.s-minor{--q-c:var(--s-minor)}
.cell.has-q{box-shadow:inset 0 0 0 1.5px var(--q-c)}
.rules tr.has-q>td{box-shadow:inset 0 1.5px 0 var(--q-c),inset 0 -1.5px 0 var(--q-c)}
.rules tr.has-q>td:first-child{box-shadow:inset 1.5px 0 0 var(--q-c),inset 0 1.5px 0 var(--q-c),inset 0 -1.5px 0 var(--q-c)}
.rules tr.has-q>td:last-child{box-shadow:inset -1.5px 0 0 var(--q-c),inset 0 1.5px 0 var(--q-c),inset 0 -1.5px 0 var(--q-c)}
.sev{display:inline-block;font-size:11px;font-weight:600;line-height:1.6;padding:0 7px;border-radius:4px}

.legend{display:flex;flex-direction:column;gap:14px;min-width:170px;font-size:12.5px;padding-top:2px}
.lg-h{font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);margin-bottom:6px}
.lg-r{display:flex;align-items:center;gap:8px;padding:2px 0;color:var(--ink-2)}
.lg-r .n{margin-left:auto;color:var(--faint);font:12px var(--mono);padding-left:14px}
.sw{width:8px;height:8px;border-radius:50%;flex:none}
.sw.t-pos{background:var(--pos)}
.sw.t-neg{box-shadow:inset 0 0 0 1.5px var(--faint)}
.sw.t-warn{background:linear-gradient(90deg,var(--ink-2) 50%,transparent 50%);box-shadow:inset 0 0 0 1.5px var(--ink-2)}
.sw.t-info,.sw.t-neutral{height:2px;border-radius:1px;background:var(--line-2)}
.sw.imp{width:10px;height:10px;border-radius:2px;box-shadow:inset 0 0 0 1px var(--line-2)}
.sw.gap{width:10px;height:10px;border-radius:2px;outline-offset:-2px}

.rules td.num,.rules th.num{color:var(--faint);width:28px;text-align:right;font:12px var(--mono)}
.rules .out.first{border-left:1px solid var(--line-2)}
.rules .out{background:var(--bg)}
.rules td.note{color:var(--mute);font-size:12.5px;max-width:34ch}
.rules tr.gap-row>td{border-top:1px dashed var(--s-major)}
.any{color:var(--faint);font-style:italic}

/* Actor tags: words, not colours. */
.who{display:inline-block;font:500 10.5px/1.5 var(--mono);padding:0 5px;margin-right:6px;border:1px solid var(--line-2);border-radius:4px;color:var(--mute);background:var(--panel);vertical-align:1px;white-space:nowrap;text-transform:lowercase}
.who-key{margin:8px 0 0;font-size:12px;color:var(--mute);display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.who-key .who{margin:0}
/* A planned feature: described by a spec, not yet in the code. */
.plan{display:inline-block;font:500 10.5px/1.5 var(--mono);padding:0 6px;border:1px dashed var(--line-2);border-radius:4px;color:var(--mute);white-space:nowrap}

td:target,li:target{outline:2px solid var(--ring);outline-offset:-2px}
tr:target>td{box-shadow:inset 0 1px 0 var(--ring),inset 0 -1px 0 var(--ring)}

#questions{margin-top:56px;padding-top:32px;border-top:1px solid var(--line)}
#questions h2{margin:0;font-size:16px;font-weight:600;letter-spacing:-.01em}
#questions h3{font-size:13px;font-weight:500;margin:28px 0 0;color:var(--mute)}
.sev-key{margin:10px 0 0;font-size:12.5px;color:var(--mute);display:flex;flex-wrap:wrap;gap:6px 18px}
.qs{list-style:none;padding:0;margin:14px 0 0;display:flex;flex-direction:column;gap:8px}
.qs li{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;box-shadow:inset 2px 0 0 var(--line-2)}
.qs li.s-critical{box-shadow:inset 2px 0 0 var(--s-critical)}
.qs li.s-major{box-shadow:inset 2px 0 0 var(--s-major)}
.qs li.s-minor{box-shadow:inset 2px 0 0 var(--s-minor)}
.qs li p{margin:6px 0 0;max-width:80ch;color:var(--ink-2)}
.qs li.ans p:not(.answer){color:var(--mute)}
.qs li p.answer{color:var(--ink)}
.answer-l{font:500 10.5px/1.5 var(--mono);text-transform:uppercase;letter-spacing:.04em;color:var(--faint);margin-right:8px}
.q-h{display:flex;gap:8px;align-items:center}
.qid{font:600 12px var(--mono)}
.kind{font:11px/1.6 var(--mono);padding:0 6px;border-radius:4px;border:1px solid var(--line);color:var(--mute)}
.refs{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12.5px}
.refs a{color:var(--mute)}
.refs a:hover{color:var(--ink)}
.none{color:var(--mute)}

@media (max-width:1100px){body{grid-template-columns:minmax(0,1fr)}nav{min-width:0;position:sticky;height:auto;flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 16px;z-index:2}
.brand,.nav-g{display:none}.nav-list{display:flex;gap:2px}nav a{white-space:nowrap}nav a.on{box-shadow:inset 0 -2px 0 var(--ink)}.nav-q{margin:0;border:0;padding-top:5px!important}main{padding:24px 16px 64px}}
`;

const JS = `
const show=(box,v)=>{box.querySelectorAll(':scope>[data-view]').forEach(p=>p.hidden=p.dataset.view!==v);box.querySelectorAll('button[data-show]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.show===v)))};
document.querySelectorAll('[data-views]').forEach(box=>box.querySelectorAll('button[data-show]').forEach(b=>b.addEventListener('click',()=>show(box,b.dataset.show))));
const reveal=()=>{const el=document.getElementById(decodeURIComponent(location.hash.slice(1)));const view=el&&el.closest('[data-view]');if(view&&view.hidden){show(view.parentElement,view.dataset.view);el.scrollIntoView({block:'center'})}};
addEventListener('hashchange',reveal);reveal();
const links=new Map([...document.querySelectorAll('nav a[href^="#f-"]')].map(a=>[a.getAttribute('href').slice(1),a]));
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){links.forEach(a=>a.classList.remove('on'));const a=links.get(e.target.id);if(a){a.classList.add('on');a.scrollIntoView({block:'nearest'})}}}),{rootMargin:'0px 0px -75% 0px'});
document.querySelectorAll('section.feature').forEach(s=>io.observe(s));
`;

// ---------------------------------------------------------------- stale

function readLock(htmlPath) {
  if (!existsSync(htmlPath)) return null;
  const m = readFileSync(htmlPath, "utf8").match(new RegExp(`<script type="application/json" id="${LOCK_ID}">([\\s\\S]*?)</script>`));
  return m ? JSON.parse(m[1]) : null;
}

function stale(spec, specSha, root, htmlPath, specPath) {
  const lock = readLock(htmlPath);
  const files = watchedFiles(spec, root, [specPath, htmlPath]);
  const now = hashFiles(root, files);
  const before = lock?.files ?? {};
  const changed = new Set([
    ...files.filter((p) => before[p] !== now[p]),
    ...Object.keys(before).filter((p) => !(p in now)),
  ]);
  const cited = new Set();
  const features = [];
  for (const f of spec.features ?? []) {
    const paths = (f.sources ?? []).map((s) => s.path).filter(Boolean);
    paths.forEach((p) => cited.add(p));
    const hit = paths.filter((p) => changed.has(p) || !existsSync(path.join(root, p)));
    if (hit.length) features.push({ id: f.id, name: f.name, paths: [...new Set(hit)] });
  }
  const uncited = [...changed].filter((p) => !cited.has(p)).map((p) => ({ path: p, status: !(p in now) ? "deleted" : p in before ? "modified" : "added" }));
  const html = !lock ? "missing" : lock.spec !== specSha ? "behind-spec" : "current";
  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  const rev = spec.meta?.repository?.revision;
  return { html, features, uncited, revision: rev ?? null, head: head ?? null, revisionIsHead: !!rev && rev === head, stale: html !== "current" || features.length > 0 || uncited.length > 0 };
}

// ---------------------------------------------------------------- branches

// A line where the code decides something: the checklist an audit must account for.
const DECISION = /\bif\s*\(|\belse\b|\bswitch\s*\(|\bcase\b|\bcatch\b|\bthrow\b|\s\?\s[^:]+\s:\s|\?\?|\bstatus:\s*\d{3}|\bMath\.(min|max)\(|[<>]=?\s*[A-Z][A-Z0-9_]{2,}\b|[!=]==?\s*["'][A-Z][A-Z_]+["']/;
// Where the next top-level declaration starts, ending the cited function.
const TOP_LEVEL = /^(export\s+)?(async\s+)?function\b|^export\s+(default\s+)?(const|let|class|async|function)\b|^(const|let|class)\s/;
// A spec or other prose document, audited sentence by sentence rather than by syntax.
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const HEADING = /^(#{1,6})\s/;
// A line of a spec that decides something: a condition, a limit, a number, or a row of a table.
const DECISION_PROSE = /\b(if|unless|when|whenever|only|except|otherwise|else|must|cannot|can't|never|always|before|after|until|within|at (least|most)|more than|less than|fewer than|up to|over|under|above|below|exceeds?|expires?|allowed|refused?|rejected?|requires?|eligible|either|neither|depends)\b|\d+\s*(%|mins?|minutes?|hours?|days?|weeks?|months?|years?)\b|[<>≤≥]=?\s*\d|[$€£¥]\s?\d|^\s*\|(?!\s*:?-{3})/i;

// An HTML document (an exported spec, a wiki page) is prose too, read as its visible text.
const HTML_DOC = /\.(html?|xhtml)$/i;
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "li", "ul", "ol", "dl", "dt", "dd", "tr", "table", "thead", "tbody", "tfoot", "caption", "blockquote", "pre", "figure", "figcaption", "details", "summary", "br", "hr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×", le: "≤", ge: "≥" };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});

// The visible text of an HTML page, one entry per block with the line it starts
// on. Headings read as "## Heading" and table rows as "| a | b |", so a section
// and its decision lines are found the same way as in markdown.
function htmlBlocks(raw) {
  const blank = (m) => m.replace(/[^\n]/g, " "); // keeps line numbers
  const src = raw.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, blank);
  const blocks = [];
  let text = "";
  let start = 1;
  let line = 1;
  let heading = 0;
  let row = false;
  const newlines = (s) => s.match(/\n/g)?.length ?? 0;
  const flush = () => {
    const t = decodeEntities(text).replace(/\s+/g, " ").trim();
    if (t) blocks.push({ line: start, text: heading ? `${"#".repeat(heading)} ${t}` : row ? `| ${t} |` : t });
    text = "";
    heading = 0;
    row = false;
  };
  const addText = (chunk) => {
    if (!text.trim()) {
      const k = chunk.search(/\S/);
      if (k >= 0) start = line + newlines(chunk.slice(0, k));
    }
    text += chunk;
    line += newlines(chunk);
  };
  const TAG = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;
  let at = 0;
  for (let m; (m = TAG.exec(src)); at = TAG.lastIndex) {
    addText(src.slice(at, m.index));
    const [tag, close, name] = [m[0], m[1], m[2].toLowerCase()];
    const level = /^h([1-6])$/.exec(name)?.[1];
    if (level) { flush(); if (!close) heading = Number(level); }
    else if (name === "td" || name === "th") { if (!close) { if (row && text.trim()) text += " | "; row = true; } }
    else if (BLOCK_TAGS.has(name)) flush();
    line += newlines(tag);
  }
  addText(src.slice(at));
  flush();
  return blocks;
}

// A document's lines as the audit reads them, each with its line in the file.
const docLines = (file, content) => (HTML_DOC.test(file) ? htmlBlocks(content) : content.split(/\r?\n/).map((text, i) => ({ line: i + 1, text })));

// Where a cited symbol is: its index in the lines, preferring a heading in an HTML page.
function findSymbol(file, entries, symbol) {
  if (HTML_DOC.test(file)) {
    const bare = symbol.replace(/^#+\s*/, "");
    const h = entries.findIndex((e) => HEADING.test(e.text) && e.text.includes(bare));
    if (h >= 0) return h;
  }
  return entries.findIndex((e) => e.text.includes(symbol));
}

// The file line a symbol sits on, or null when it is not there. An HTML page is
// matched on its visible text first, then on its source.
function symbolLine(file, content, symbol) {
  const entries = docLines(file, content);
  const i = findSymbol(file, entries, symbol);
  if (i >= 0) return entries[i].line;
  if (!HTML_DOC.test(file)) return null;
  const n = content.split(/\r?\n/).findIndex((l) => l.includes(symbol));
  return n >= 0 ? n + 1 : null;
}

// Decision points in a cited source: within the cited symbol's declaration
// (or, in a document, the cited heading's section) when there is one,
// otherwise the whole file (route handlers are short).
function decisionPoints(root, s) {
  const abs = path.join(root, s.path);
  if (!existsSync(abs)) return { path: s.path, symbol: s.symbol ?? null, missing: true, points: [] };
  const content = readFileSync(abs, "utf8");
  const entries = docLines(s.path, content);
  const lastLine = content.split(/\r?\n/).length;
  const prose = PROSE.test(s.path) || HTML_DOC.test(s.path);
  let from = 0;
  let to = entries.length;
  if (s.symbol) {
    const start = findSymbol(s.path, entries, s.symbol);
    if (start >= 0) {
      from = start;
      // A section runs to the next heading at its level or above; a symbol that is not a heading, to the next heading.
      const level = entries[start].text.match(HEADING)?.[1].length ?? 7;
      const next = prose
        ? entries.findIndex((e, i) => i > start && (e.text.match(HEADING)?.[1].length ?? 99) <= level)
        : entries.findIndex((e, i) => i > start && TOP_LEVEL.test(e.text));
      to = next < 0 ? entries.length : next;
    } else if (HTML_DOC.test(s.path)) {
      // In the page's source but not its visible text: drawn by a script, or inside an attribute.
      const line = symbolLine(s.path, content, s.symbol);
      if (line !== null) return { path: s.path, symbol: s.symbol, from: line, to: line, points: [], unreadable: "not in the page's visible text (drawn by a script?); read this section yourself" };
    }
  }
  const test = prose ? DECISION_PROSE : DECISION;
  const points = [];
  for (let i = from; i < to; i++) if (test.test(entries[i].text)) points.push({ line: entries[i].line, code: entries[i].text.trim().slice(0, 160) });
  const fromLine = entries[from]?.line ?? 1;
  const toLine = to < entries.length ? Math.max(fromLine, entries[to].line - 1) : lastLine;
  return { path: s.path, symbol: s.symbol ?? null, from: fromLine, to: toLine, points };
}

// ---------------------------------------------------------------- setup

// Per-project choices, written by `setup`. The hook and its copy of this tool
// live beside them when the project opts into the hook.
const CONFIG_DIR = ".claude/rulemap";
const CONFIG = `${CONFIG_DIR}/config.json`;
const CHECKLIST = `${CONFIG_DIR}/checklist.json`;
const SPEC_NAME = "rulemap.json";
// area: one page per feature area, <dir>/<area>/rulemap.json. single: one page, <dir>/rulemap.json.
const LAYOUTS = new Set(["area", "single"]);
const HOOK_TARGETS = { none: null, project: ".claude/settings.json", local: ".claude/settings.local.json" };
const HOOK_MARK = `${CONFIG_DIR}/sync-hook.mjs`;
const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${HOOK_MARK}"`;
const here = path.dirname(fileURLToPath(import.meta.url));

function readConfig(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, CONFIG), "utf8"));
  } catch {
    return null;
  }
}

const describeLayout = (cfg) => (cfg.layout === "single" ? `one page at ${cfg.dir}/${SPEC_NAME}` : `one page per feature area at ${cfg.dir}/<area>/${SPEC_NAME}`);

function findSpecs(root, cfg) {
  const dir = path.join(root, cfg.dir);
  if (cfg.layout === "single") return existsSync(path.join(dir, SPEC_NAME)) ? [`${cfg.dir}/${SPEC_NAME}`] : [];
  let areas = [];
  try {
    areas = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return areas.filter((a) => existsSync(path.join(dir, a, SPEC_NAME))).sort().map((a) => `${cfg.dir}/${a}/${SPEC_NAME}`);
}

// Adds or removes this tool's Stop hook in one settings file, leaving every other setting alone.
function editHook(file, want) {
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      if (!want) return null;
      throw new Error(`${file} is not plain JSON; add a Stop hook running ${HOOK_COMMAND} by hand`);
    }
  } else if (!want) return null;
  const isOurs = (h) => typeof h.command === "string" && h.command.includes(HOOK_MARK);
  const stop = settings.hooks?.Stop ?? [];
  const has = stop.some((g) => (g.hooks ?? []).some(isOurs));
  if (want === has) return null;
  const next = want
    ? [...stop, { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60, statusMessage: "Checking rulemap pages are in sync with the code" }] }]
    : stop.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
  settings.hooks = { ...settings.hooks, Stop: next };
  if (!next.length) delete settings.hooks.Stop;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return want ? "added" : "removed";
}

function setup(root, opt) {
  const dir = (opt.dir ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/\/<[^>]*>$|\/\*$/, "");
  if (!dir || path.isAbsolute(dir) || /^[a-z]:/i.test(dir) || dir.split("/").includes("..")) throw new Error("--dir must be a folder inside the project, e.g. docs/features");
  const layout = opt.layout ?? "area";
  if (!LAYOUTS.has(layout)) throw new Error(`--layout must be one of ${[...LAYOUTS].join(", ")}`);
  const hook = opt.hook ?? "none";
  if (!(hook in HOOK_TARGETS)) throw new Error(`--hook must be one of ${Object.keys(HOOK_TARGETS).join(", ")}`);
  const hookSrc = path.join(here, "..", "hooks", "sync-hook.mjs");
  if (hook !== "none" && !existsSync(hookSrc)) throw new Error(`run setup from the skill's own copy of this tool; ${hookSrc} is missing`);

  const cfgDir = path.join(root, CONFIG_DIR);
  mkdirSync(cfgDir, { recursive: true });
  const cfg = { dir, layout };
  writeFileSync(path.join(root, CONFIG), JSON.stringify(cfg, null, 2) + "\n");
  const done = [`${CONFIG}: ${describeLayout(cfg)}`];

  for (const [kind, rel] of Object.entries(HOOK_TARGETS)) {
    if (!rel) continue;
    const r = editHook(path.join(root, rel), kind === hook);
    if (r) done.push(`${rel}: ${r} the Stop hook`);
  }
  // The hook must run for teammates without the plugin, so it gets its own copy of this tool.
  const copies = ["sync-hook.mjs", "rulemap.mjs"];
  if (hook === "none") {
    for (const f of [...copies, ".gitignore"]) rmSync(path.join(cfgDir, f), { force: true });
    done.push("no hook: pages update when asked");
  } else {
    copyFileSync(hookSrc, path.join(cfgDir, "sync-hook.mjs"));
    copyFileSync(fileURLToPath(import.meta.url), path.join(cfgDir, "rulemap.mjs"));
    // Just for me: keep the copies out of the repository as well.
    if (hook === "local") writeFileSync(path.join(cfgDir, ".gitignore"), copies.join("\n") + "\n");
    else rmSync(path.join(cfgDir, ".gitignore"), { force: true });
    done.push(`${CONFIG_DIR}/: copied the hook and this tool${hook === "local" ? " (gitignored)" : "; commit them with .claude/settings.json"}`);
  }
  return done;
}

// ---------------------------------------------------------------- commands

function stamp(specPath, text, root) {
  const head = git(root, ["rev-parse", "HEAD"])?.trim();
  if (!head) throw new Error("cannot read HEAD");
  const re = /("revision"\s*:\s*")[0-9a-f]*(")/;
  let next;
  if (re.test(text)) next = text.replace(re, `$1${head}$2`);
  else {
    const spec = JSON.parse(text);
    spec.meta.repository = { ...(spec.meta.repository ?? {}), revision: head };
    next = JSON.stringify(spec, null, 2) + "\n";
  }
  writeFileSync(specPath, next);
  return head;
}

function report(json, payload, human) {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else console.log(human);
}

function printDiagnostics(v) {
  const out = [];
  for (const e of v.errors) out.push(`  error    ${e}`);
  for (const w of v.warnings) out.push(`  warning  ${w}`);
  return out.join("\n");
}

function main() {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "repo-root": { type: "string" },
      stamp: { type: "boolean" },
      feature: { type: "string", multiple: true },
      changed: { type: "boolean" },
      checklist: { type: "boolean" },
      dir: { type: "string" },
      layout: { type: "string" },
      hook: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, specArg, outArg] = positionals;

  if (cmd === "setup" || cmd === "specs") {
    const root = opt["repo-root"] ? path.resolve(opt["repo-root"]) : git(process.cwd(), ["rev-parse", "--show-toplevel"])?.trim() || process.cwd();
    if (cmd === "setup") {
      const done = setup(root, opt);
      report(opt.json, { done }, done.join("\n"));
      return 0;
    }
    const cfg = readConfig(root);
    if (!cfg) {
      report(opt.json, { configured: false, specs: [] }, `not set up: ${CONFIG} is missing`);
      return 3;
    }
    const specs = findSpecs(root, cfg);
    const list = readChecklist(root);
    const checklist = list && !list.invalid && Array.isArray(list.items) ? list.items.length : null;
    report(opt.json, { configured: true, ...cfg, checklist, specs }, [describeLayout(cfg), checklist === null ? `no ${CHECKLIST}` : `${CHECKLIST}: ${checklist} items`, ...(specs.length ? specs.map((s) => `  ${s}`) : ["  (no pages yet)"])].join("\n"));
    return 0;
  }

  if (opt.help || !cmd || !specArg) { console.log(USAGE); return cmd ? 0 : 1; }

  const specPath = path.resolve(specArg);
  // Outside a repository, sources are relative to where the tool runs; links go to local files and nothing is pinned.
  const root = opt["repo-root"] ? path.resolve(opt["repo-root"]) : git(path.dirname(specPath), ["rev-parse", "--show-toplevel"])?.trim() || process.cwd();

  if (cmd === "stamp") {
    const head = stamp(specPath, readFileSync(specPath, "utf8"), root);
    report(opt.json, { revision: head }, `revision pinned to ${head.slice(0, 7)}`);
    return 0;
  }

  if (cmd === "deliver" && opt.stamp) {
    if (git(root, ["rev-parse", "HEAD"]) === null) console.error("not a git repository with commits: revision left unpinned");
    else stamp(specPath, readFileSync(specPath, "utf8"), root);
  }
  const { spec, sha } = load(specPath);
  const htmlPath = path.resolve(outPath(specPath, spec, outArg));

  if (cmd === "validate" || cmd === "deliver") {
    const v = validate(spec, root, { checklistAll: opt.checklist });
    const ok = v.errors.length === 0;
    const answered = (spec.questions ?? []).filter((q) => q.answer).length;
    const summary = { ok, errors: v.errors, warnings: v.warnings, features: v.model.length, questions: (spec.questions ?? []).length - answered, answered, unhandled: v.gaps.length, unchecked: v.checks.length };
    const counts = `${summary.features} features, ${summary.questions} open questions${answered ? ` (${answered} answered)` : ""}, ${summary.unhandled} unhandled${v.items.size ? `, ${summary.unchecked} not yet checked against ${CHECKLIST}` : ""}`;
    if (!ok || cmd === "validate") {
      report(opt.json, summary, `${ok ? "valid" : "INVALID"}: ${v.errors.length} errors, ${v.warnings.length} warnings, ${counts}\n${printDiagnostics(v)}`.trimEnd());
      return ok ? 0 : 1;
    }
    const files = watchedFiles(spec, root, [specPath, htmlPath]);
    const lock ={ spec: sha, files: hashFiles(root, files) };
    const html = render(spec, v, lock, root, htmlPath);
    const tmp = `${htmlPath}.tmp-${process.pid}`;
    writeFileSync(tmp, html);
    renameSync(tmp, htmlPath);
    report(opt.json, { ...summary, output: htmlPath, bytes: Buffer.byteLength(html), specSha256: sha, tracked: files.length },
      `delivered ${path.relative(process.cwd(), htmlPath)} (${counts}, tracking ${files.length} files)\n${printDiagnostics(v)}`.trimEnd());
    return 0;
  }

  if (cmd === "branches") {
    let feats = spec.features ?? [];
    if (opt.feature?.length) {
      const unknown = opt.feature.filter((id) => !feats.some((f) => f.id === id));
      if (unknown.length) { console.error(`unknown feature: ${unknown.join(", ")}`); return 1; }
      feats = feats.filter((f) => opt.feature.includes(f.id));
    }
    let extra = [];
    if (opt.changed) {
      const s = stale(spec, sha, root, htmlPath, specPath);
      const ids = new Set(s.features.map((f) => f.id));
      feats = feats.filter((f) => ids.has(f.id));
      extra = s.uncited.filter((u) => u.status !== "deleted").map((u) => decisionPoints(root, { path: u.path }));
    }
    const result = {
      features: feats.map((f) => ({ id: f.id, name: f.name, sources: (f.sources ?? []).map((s) => decisionPoints(root, s)) })),
      uncited: extra,
    };
    const block = (d) => [
      `${d.path}${d.symbol ? ` · ${d.symbol}` : ""}${d.missing ? "  (missing)" : d.unreadable ? `  line ${d.from}: ${d.unreadable}` : `  lines ${d.from}–${d.to}, ${d.points.length} decision points`}`,
      ...d.points.map((p) => `  ${String(p.line).padStart(5)}  ${p.code}`),
    ];
    const human = [];
    for (const f of result.features) human.push(`## ${f.id} — ${f.name}`, ...f.sources.flatMap(block), "");
    if (extra.length) human.push("## Changed watched files no feature cites", ...extra.flatMap(block), "");
    if (!human.length) human.push(opt.changed ? "nothing changed since the last deliver" : "no features selected");
    human.push("Account for every line: a rule or input value, plumbing no user can observe, or a question.");
    report(opt.json, result, human.join("\n"));
    return 0;
  }

  if (cmd === "stale") {
    const s = stale(spec, sha, root, htmlPath, specPath);
    const human = [];
    if (!s.stale) human.push("up to date");
    if (s.html === "missing") human.push("HTML: missing or has no lock; run deliver");
    if (s.html === "behind-spec") human.push("HTML: the spec changed since the last deliver; run deliver");
    if (s.features.length) human.push("Features whose cited code changed:", ...s.features.map((f) => `  ${f.id.padEnd(28)} ${f.paths.join(", ")}`));
    if (s.uncited.length) human.push("Watched files no feature cites (a new or moved rule?):", ...s.uncited.map((u) => `  ${u.status.padEnd(9)}${u.path}`));
    if (s.stale && !s.revisionIsHead && s.head) human.push(`Revision ${s.revision?.slice(0, 7) ?? "(none)"} is not HEAD ${s.head.slice(0, 7)}; deliver with --stamp.`);
    report(opt.json, s, human.join("\n"));
    return s.stale ? 2 : 0;
  }

  console.error(`unknown command "${cmd}"\n\n${USAGE}`);
  return 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e instanceof SyntaxError ? `spec is not valid JSON: ${e.message}` : e.stack ?? String(e));
  process.exitCode = 1;
}

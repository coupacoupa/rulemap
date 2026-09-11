---
name: decision-tables
description: Build and keep in sync a local HTML page that maps every distinctive feature of an app as decision tables — condition axes (e.g. customer on free / pro plan × order paid / refunded) against the resulting behaviour (allowed / refused), tagged by whose condition each input is, with gaps, bugs and unclear rules linked to a severity-rated open-questions list. Use when the user asks to map, document, audit or explain feature behaviour or business rules, asks "what happens when…" across combinations, or when code changes and the feature-decisions page must be updated.
---

# Decision tables

One page, `docs/architecture/feature-decisions.html`, generated from
`docs/architecture/feature-decisions.json` (any path works; this is the
default the Stop hook looks for). **Edit the JSON, never the HTML.** The page
is a side menu of features; each feature is a one-sentence summary, source
links, and one or more decision tables. The tables carry the meaning — no
prose beyond the summary and a few-word note per rule.

The CLI needs Node 18+ and git, and has no dependencies. Run it from the
project root:

```bash
DT="${CLAUDE_SKILL_DIR}/bin/decision-tables.mjs"
SPEC=docs/architecture/feature-decisions.json
node "$DT" validate $SPEC          # errors exit 1; warnings list unhandled combinations
node "$DT" deliver  $SPEC --stamp  # pin revision to HEAD, validate, write the HTML
node "$DT" stale    $SPEC          # exit 0 = in sync, exit 2 = something to update
node "$DT" branches $SPEC --changed    # every decision point in changed features, to audit
```

The spec format is in [references/spec.md](references/spec.md). Read it before
writing JSON.

## Creating the page

1. **Find the features with real branching.** A feature earns a table when its
   behaviour changes with its inputs: visibility rules, pricing windows, status
   transitions, eligibility, permissions. Read the rule where it lives (domain
   modules, route handlers, services, jobs) and the tests that enumerate its
   cases. Skip features with no branching (a static page, a CRUD list).
2. **Choose the axes from the code, not from intuition.** An input is a
   condition the code actually branches on; its values are the branches that
   exist, named in product language with the real threshold (`fix < 5 min`,
   `before 03:55`). **Keep conditions granular:** every value is exactly one
   state. Never merge states into one value ("ASSIGNED or EN_ROUTE", "stale or
   missing", "accepts / assigns") even when they share an outcome; list each
   separately, because splitting is how hidden differences surface (a stale
   fix and no fix behave differently). Two inputs render as a grid, which is
   the most readable form: prefer splitting a four-condition rule into two
   2-input tables over one 16-row table. Use three or more inputs only when
   they genuinely interact.
3. **Say whose condition each input is.** Name the app's users in
   `meta.actors` (e.g. customer, seller, admin), plus `system` for what no
   person controls (payment gateway, cron, env flags). Every input carries an
   `actor`; values on a mixed axis carry their own, and a second person in the
   same role gets `"as": "Other seller"`. A reader must never have to guess
   whose account, whose order or whose action a row is.
4. **Enumerate outcomes and give each a tone** — `pos` for allowed / shown,
   `neg` for refused / hidden, `warn` for degraded or conditional, `info` for
   neutral variants (two prices), `neutral` otherwise.
5. **Write one rule per value.** Each rule names a single value per input,
   or `*` only where that input genuinely does not matter. Mark combinations
   that cannot occur `"impossible": true` rather than inventing an outcome.
   Leave a combination uncovered only when the code truly does not decide it;
   the tool lists every uncovered cell as an unhandled combination.
6. **Never guess.** When the code is ambiguous, contradicts a test or doc,
   uses an unexplained magic number, or does something that looks unintended,
   record what the code does and attach a question (`"q": ["Q4"]`). Kinds:
   `gap` (not handled), `clarify` (intent unclear), `conflict` (code, tests and
   docs disagree), `bug` (looks wrong). Question text is one or two sentences
   naming the exact case. **Rate every question's severity** by its impact
   on real users, not by how sure you are: `critical` (red) when money is
   lost or moved wrongly, there is a security hole, or someone is left
   stranded or unpaid; `major` (orange) for wrong behaviour users will hit
   with a workaround or limited reach; `minor` (yellow) for unclear intent,
   doc drift or unexplained numbers. When syncing, re-rate a question if the
   code change alters its impact.
7. **Cite sources** with `path` and, where possible, `symbol` (a function or
   constant name). The symbol resolves to a line at the pinned revision and is
   checked on every validate, so a renamed function is caught. Set
   `meta.repository.url` so source links open on the code host.
8. Set `meta.watch` to the directories whose changes can alter a rule.
9. `deliver --stamp`, then open the HTML to check it reads well. Fix every
   validation error; treat every warning as a question you either answer with a
   rule or keep as a listed gap.

## Syncing after code changes

1. Run `stale`. It compares a hash of every watched and cited file against the
   hashes recorded at the last deliver, and reports:
   - **features whose cited code changed** — re-read those sources and update
     their rules, notes and questions;
   - **watched files no feature cites** — read the change; add a feature or a
     source if it introduces or moves a rule, otherwise nothing to do;
   - **HTML behind the spec** — the JSON was edited without a deliver.
2. Edit only what changed. Keep feature, table and value ids stable so links
   and question numbers do not churn; append new questions with the next free
   number, and delete questions the change answered.
3. `deliver --stamp`. Deliver records the new hashes, so `stale` is clean
   afterwards, even for uncommitted changes. Source links point at the pinned
   commit, so a file that exists only in the working tree links correctly
   once it is committed and stamped again (validate warns about it).
4. Report to the user in a line or two: which features changed behaviour and
   which questions were opened or closed.

## Auditing: every branch accounted for

Mapping what the code says is half the job; the other half is finding what it
fails to say. Every create and every sync ends with this audit, over each
feature whose code changed — the whole feature, not only the diff, because a
change in one branch can invalidate another. Do not deliver until it is done.

1. **Inventory the decisions.** `node "$DT" branches $SPEC --changed` (or
   `--feature <id>`, repeatable) lists every decision point in each cited
   function: `if`/`else`, `switch`/`case`, ternaries, `??`, `catch`, `throw`,
   HTTP statuses, `Math.min/max` clamps, and comparisons against constants and
   status strings. Changed watched files no feature cites are listed too. The
   scan is tuned for JavaScript and TypeScript; in other languages treat it as
   a starting list and read the functions yourself.
2. **Account for every line.** Each is a rule or input value in a table,
   plumbing that changes nothing a user can observe, or a question. Nothing is
   skipped for looking routine. When a cited symbol is too narrow to hold the
   whole rule, add the helper it calls as another source.
3. **Read the unwritten branch.** For each condition, what happens on the
   other side when there is no `else`? For each status, how does a record
   leave it? For each charge, assignment or credit, where is its reversal
   (refund, unassign, restore)? A missing path is a `gap`.
4. **Follow the callers.** Check every route, cron and job that reaches the
   rule: auth and role checks, state guards (active, mode, status), and
   whether another entry point skips them. A guard present in one caller and
   absent in another is a `bug` or `gap`.
5. **Probe the edges.** Thresholds (`<` vs `<=`, the exact boundary minute),
   null / undefined / NaN / empty, time zones and midnight, duplicates and
   retries, races (is the write conditional or idempotent?), money rounding.
6. **Cross-check tests and docs.** A test asserting something else, a doc or
   UI string promising what the code does not do, or a comment describing old
   behaviour is a `conflict`.
7. **Treat validator output as findings.** Every uncovered combination is a
   real gap or a rule you missed; every "never applies" rule is a table error.

Record each finding as a question with a severity, and report how many
questions were opened and closed.

## The Stop hook

When installed as a plugin, a Stop hook runs whenever an agent finishes a turn
in a project that has `docs/architecture/feature-decisions.json` (or the path
in the `DECISION_TABLES_SPEC` env var). If code the page depends on changed
since the last deliver, it blocks the stop and lists the stale features and
files. Sync, audit and deliver as above. It lets go after one retry and warns
the user instead, so it never loops — which also means a deliver is a claim
that the code was reviewed: never deliver just to quiet it. Projects without a
spec are untouched; `DECISION_TABLES_HOOK=off` disables it.

## Output

Return the HTML path, the feature / question / unhandled counts from
`deliver`, and any warnings you chose to leave as gaps. Never describe a
non-zero `deliver` as success.

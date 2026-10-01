---
name: rulemap
description: Map an app's business rules as decision tables — condition axes (e.g. order paid / shipped / refunded × age ≤ 14 / 15–30 / > 30 days) against the outcome (refund shown / needs seller / hidden) — either from the existing code (Map) or from a spec, PRD or described feature before it is built (Plan), then asks the user about every combination the source leaves open. Tags whose condition each input is and links gaps, bugs and unclear rules to severity-rated questions. Use when the user asks to map, document, audit or explain business rules or feature behaviour, asks "what happens when…" across combinations, wants to plan a new feature or review a spec for missing cases, points at a file or folder to pull rules out of, or when code changes and a rulemap page must be updated.
---

# rulemap

Business rules as decision tables: each page is a side menu of features, and
each feature is a one-sentence summary, source links, and grids of conditions
against outcomes. The tables carry the meaning — no prose beyond the summary
and a few-word note per rule. Every page is generated HTML from a JSON spec:
**edit the JSON, never the HTML.**

The CLI needs Node 18+ and has no dependencies. Run it from the project root:

```bash
DT="${CLAUDE_SKILL_DIR}/bin/rulemap.mjs"
node "$DT" specs                   # this project's layout and pages; exit 3 = not set up
node "$DT" validate <spec>         # errors exit 1; warnings list unhandled combinations
node "$DT" deliver  <spec> --stamp # pin revision to HEAD, validate, write the HTML
node "$DT" stale    <spec>         # exit 0 = in sync, exit 2 = something to update
node "$DT" branches <spec> --changed   # every decision point in changed features, to audit
```

The spec format is in [references/spec.md](references/spec.md). Read it before
writing JSON.

## First: is this project set up?

Run `node "$DT" specs`. Exit 3 means not yet: follow
[references/setup.md](references/setup.md) — it asks the user where pages go
and whether to install the sync hook — before anything else. Otherwise it
prints the layout and every existing page.

Where a spec goes:

- layout `area`: `<dir>/<area>/rulemap.json`, one page per feature area
  (`refunds`, `checkout`, a planned `gift-cards`), kebab-case in product
  language. Extend an area's page before starting another. Specs, PRDs and
  notes for the area belong in the same folder.
- layout `single`: `<dir>/rulemap.json`, one page; use `groups` for areas.

The HTML is written beside its spec as `rulemap.html`.

## Two modes

**Map — how the code behaves now.** "Map how refunds work", "what happens
when a driver goes offline mid-run", "rulemap `src/billing`". Reads code and
tests. When the user points at files or folders, that is the scope: map only
the rules that live there, and add those paths to `meta.watch`.

**Plan — how a feature should behave, before it is built.** "Plan gift cards
from this spec", a PRD or ticket file, a folder of them (read every file), or
a feature described in the conversation. With the `area` layout, pointing at
`docs/features/gift-cards/` means: read the specs in it, write
`rulemap.json` beside them.

When both apply ("rulemap billing" where billing has code and a new spec),
map the code and plan what the spec adds on top, and say which is which.

## Writing the tables (both modes)

1. **Ground every axis in a source.** An input is a condition the code
   branches on, the spec names, the project checklist lists, or an existing
   path changes (Plan step 3 says how to find those); its values are the
   states that exist, in product language with the real threshold
   (`fix < 5 min`, `before 03:55`). **Keep conditions granular:** every value
   is exactly one state. Never merge states into one value ("ASSIGNED or
   EN_ROUTE", "stale or missing", "accepts / assigns") even when they share an
   outcome; splitting is how hidden differences surface. Two inputs render as
   a grid, the most readable form: prefer two 2-input tables over one 16-row
   table, but never at the cost of an interaction — when conditions in
   different tables affect each other, they share a table.
2. **Say whose condition each input is.** Name the app's users in
   `meta.actors` (customer, seller, admin…), plus `system` for what no person
   controls (payment gateway, cron, env flags). Every input carries an
   `actor`; values on a mixed axis carry their own; a second person in the
   same role gets `"as": "Other seller"`. A reader must never have to guess
   whose account, order or action a row is.
3. **Give each outcome a tone** — `pos` allowed / shown, `neg` refused /
   hidden, `warn` degraded or conditional, `info` neutral variants (two
   prices), `neutral` otherwise.
4. **One rule per value.** Each rule names a single value per input, or `*`
   only where that input genuinely does not matter. Mark combinations that
   cannot occur `"impossible": true` rather than inventing an outcome. Leave a
   combination uncovered only when the source truly does not decide it; the
   tool lists every uncovered cell as an unhandled combination.
5. **Never guess.** When the source is ambiguous, contradicts a test or doc,
   uses an unexplained number, or does something that looks unintended, record
   what it says and attach a question (`"q": ["Q4"]`). Kinds: `gap` (not
   handled), `clarify` (intent unclear), `conflict` (sources disagree), `bug`
   (looks wrong). One or two sentences naming the exact case. **Rate severity**
   by impact on real users, not by how sure you are: `critical` when money is
   lost or moved wrongly, there is a security hole, or someone is left
   stranded or unpaid; `major` for wrong behaviour users will hit with a
   workaround or limited reach; `minor` for unclear intent, doc drift or
   unexplained numbers.
6. **Cite sources** with `path` and a `symbol`: a function or constant name
   in code, the section heading in a document. It resolves to a line and is
   checked on every validate, so a rename is caught. Set
   `meta.repository.url` so links open on the code host.
7. Set `meta.watch` to the folders whose changes can alter a rule.

## Map: from code

1. **Find the features with real branching.** A feature earns a table when
   its behaviour changes with its inputs: visibility, pricing windows, status
   transitions, eligibility, permissions. Read the rule where it lives
   (domain modules, route handlers, services, jobs) and the tests that
   enumerate its cases. Skip features with no branching (a static page, a
   CRUD list).
2. Write the tables as above.
3. Run the **code audit** below. Do not deliver until it is done.
4. `deliver --stamp`, open the HTML, check it reads well. Fix every error;
   treat every warning as a question you either answer with a rule or keep as
   a listed gap.

## Plan: from a spec

1. **Read the whole spec**, every file in the folder and the docs it links.
   Then read the existing code the feature will touch — statuses, roles,
   limits and flags it reuses — and the code that changes what it reads
   (step 3). Conditions that already exist come from the code with their real
   values, cited to it.
2. **One feature per behaviour the spec describes**, with
   `"status": "planned"`. Sources: the spec file, `symbol` set to the heading
   of the section that states the rule, plus the existing code it builds on.
   A plan that exists only in the conversation has nothing to cite: offer to
   save it as `spec.md` in the area folder so later edits are tracked.
3. **Axes: what the spec names, and what it forgets.** The silent axes are
   where plans fail, and most of them live in the app that already exists, not
   in the new feature. Work through every sweep below for every feature; a
   sweep that adds nothing is fine, a sweep skipped is not.
   - **The checklist.** Each item in the project's checklist (below) becomes an
     input or a value tagged `"covers": "<item>"`, or goes in the feature's
     `skips` with the reason it cannot change the outcome. `validate` lists
     every item a planned feature has done neither with, as `C` entries.
   - **Who else changes this.** List every table, record or state the feature
     reads. For each, search the code for every existing path that writes it:
     user actions, staff and admin tools, scheduled jobs, imports, webhooks,
     other features, deletes and restores. Search for the writes; do not rely
     on memory or the spec. Each path is an event the feature must answer.
   - **Lifecycles.** Every record the feature creates or relies on whose state
     changes (a request, an invitation, an order) gets a table of its states ×
     every event that can reach it, including the paths found above. Each
     cell is the next state, or "nothing happens".
   - **Every surface.** Each condition that hides, blocks or changes
     eligibility gets a table of its values × every screen, endpoint,
     notification, email and job where the feature appears. A condition
     honoured on one surface and forgotten on another is the commonest gap.
   - **Both sides.** When a rule involves two people (sender and receiver,
     buyer and seller), each one's state is its own input, and a change to
     either one is an event.
   - **Who can reach it.** Every role and kind of login that reaches the
     rule: secondary or delegated accounts, staff acting for a user, a user
     who belongs to two groups at once.
   - **Time and repeats.** Midnight and time zones, expiry, the boundary
     itself (`<` vs `<=`), doing it twice, two people doing it at once, doing
     it after the thing it depends on has ended.
   - **Across tables.** When two tables share an input, ask whether their
     other inputs affect each other. If they do, the combination gets its own
     table or a question.
4. **Encode only what the spec decides.** Leave every combination it does not
   decide uncovered, however obvious the answer seems: the dashed `?` cells
   are the plan's main output, the decisions still to make, and they are the
   user's to make. Don't fill them with what seems sensible, and don't settle
   them in a document of your own and then cite it; your recommendation goes
   into the question you ask.
5. **Questions:** `gap` for a whole missing axis or path, `clarify` for vague
   words (soon, recent, large, "admins"), `conflict` when the spec contradicts
   itself, the existing code or another page, `bug` for a rule that would do
   harm as written (double charge, lockout, data exposed). Severity is the
   impact if built exactly as written.
6. **Audit the spec:** `node "$DT" branches <spec> --feature <id>` lists every
   decision-bearing line in the cited sections — conditions, limits, numbers,
   table rows — in markdown, text and HTML documents. Each becomes a rule, an
   input value, or a question. When it says a section is not in a page's
   visible text (a page drawn by a script), read that section yourself.
7. `deliver` (`--stamp` inside a git repository), then **ask** — see below.
   Report what was decided and what is still open, worst first.

The spec, PRD or notes belong to the user: read them, never edit them. What is
decided while planning is kept on the page, as the next section describes.

## Asking, and keeping the answers

A plan is not done when the page is written; it is done when the user has
decided what it leaves open, or chosen to leave the rest for later.

1. **Settle what the project already decided.** Before asking, look for an
   answer the user or project has already given: another spec or doc, an
   earlier answered question on any page, behaviour the code already ships
   on purpose. Cite it as a source and write the rule. Only what nothing
   decides goes to the user; a long list of questions wears them out.
2. **Ask every remaining decision** — each `?` cell, each `C` checklist entry
   and each question — worst first, in batches with the AskUserQuestion tool (up to four per call; where
   it is unavailable, a numbered list in chat). Name the exact case, offer the
   concrete outcomes as options with your recommendation first and marked
   "(Recommended)", and let one question settle every cell it covers. Stop when
   the user says to; what is left stays open on the page.
3. **Keep each answer on the page.** Write the rule, set the question's
   `answer` to what was decided, and keep its `q` on the rules it produced.
   For a `?` cell, add a question naming the combination first, so the decision
   has a record. A checklist entry is settled by a table that `covers` it, or
   by a `skips` entry carrying the user's reason. An answered question stays, listed apart from the open ones,
   so reading the spec again later does not raise it a second time.
4. `deliver` again.

The same holds in Map mode: when the user says a questioned behaviour is
intended, answer the question rather than deleting it, so the next audit does
not report it again.

## When a planned feature ships

Map the new code against the planned tables rather than starting over: add
the code as sources, re-derive each cell from the code, keep what the code
does, and open a `conflict` question wherever it departs from the plan. Then
drop `"status": "planned"`. Keep the spec as a source while it is maintained.

## Syncing after changes

1. Run `stale` (or `specs`, then `stale` on each). It compares a hash of every
   watched and cited file — code and spec documents alike — against the
   hashes recorded at the last deliver, and reports:
   - **features whose cited files changed** — re-read those sources and update
     their rules, notes and questions;
   - **watched files no feature cites** — read the change; add a feature or a
     source if it introduces or moves a rule, otherwise nothing to do;
   - **HTML behind the spec** — the JSON was edited without a deliver.
2. Edit only what changed. Keep feature, table and value ids stable so links
   and question numbers do not churn; append new questions with the next free
   number, delete open questions the change resolved, and re-rate any whose
   impact changed. Keep answered questions: when a changed spec or code now
   contradicts an answer, open a new `conflict` question naming both rather
   than overwriting either.
3. `deliver --stamp`. It records the new hashes, so `stale` is clean
   afterwards, even for uncommitted changes. Source links fall back to the
   local file until it is committed and stamped again.
4. Report in a line or two which features changed behaviour and which
   questions were opened or closed.

## Code audit: every branch accounted for

Mapping what the code says is half the job; the other half is finding what it
fails to say. Every map and every sync ends with this, over each feature whose
code changed — the whole feature, not only the diff.

1. **Inventory the decisions.** `node "$DT" branches <spec> --changed` (or
   `--feature <id>`, repeatable) lists every decision point in each cited
   function: `if`/`else`, `switch`/`case`, ternaries, `??`, `catch`, `throw`,
   HTTP statuses, `Math.min/max` clamps, comparisons against constants and
   status strings. The scan is tuned for JavaScript and TypeScript; in other
   languages treat it as a starting list and read the functions yourself.
2. **Account for every line**: a rule or input value, plumbing that changes
   nothing a user can observe, or a question. When a cited symbol is too
   narrow to hold the whole rule, add the helper it calls as another source.
3. **Read the unwritten branch.** What happens on the other side of an `if`
   with no `else`? How does a record leave each status? Where is the reversal
   of each charge, assignment or credit? A missing path is a `gap`.
4. **Follow the callers.** Every route, cron and job that reaches the rule:
   auth and role checks, state guards, and whether another entry point skips
   them. A guard present in one caller and absent in another is a `bug` or
   `gap`.
5. **Find the other writers.** Every path that writes a field or record the
   rule reads — admin tools, jobs, imports, deletes and restores, other
   features. A writer the rule never anticipated is a `gap`. Then check the
   feature against the project checklist: `validate --checklist` lists every
   item a built feature neither covers nor skips.
6. **Probe the edges.** `<` vs `<=`, null / undefined / NaN / empty, time
   zones and midnight, duplicates and retries, races, money rounding.
7. **Cross-check tests and docs.** A test asserting something else, or a doc
   or UI string promising what the code does not do, is a `conflict`.
8. **Treat validator output as findings.** Every uncovered combination and
   every `C` checklist entry is a real gap or a missed rule; every "never
   applies" rule is a table error.

## The project checklist

Optional, and the strongest guard against late surprises. `.claude/rulemap/checklist.json`
lists what every feature in this project has to be checked against: the
conditions that always matter here (account states, roles, kinds of login,
regions, consent or privacy switches) and the existing changes that reach
into new features (an admin deleting a user, a refund issued from the support
tool, a nightly job). Each item has an `id`, a `label` and an `ask` — the
question to put to each feature. The format is in
[references/spec.md](references/spec.md).

A planned feature settles each item by covering it (an input or value with
`"covers": "<id>"`) or ruling it out (`"skips": { "<id>": "why it cannot
matter" }`). An item that cannot matter anywhere on the page is ruled out
once, in `meta.skips`. Anything left becomes a `C` entry under "Not yet
checked" on the page. `validate --checklist` applies the same check to built
features.

When a project has no checklist and the user plans or audits a feature, offer
to draft one: read the code for its roles, statuses and flags, and for every
path that writes its main tables, and propose the list for the user to edit.
When a late gap turns up that the checklist would have caught, offer to add
it, so the next feature is checked for it from the start.

## The sync hook

Optional, chosen at setup. When installed, `.claude/rulemap/sync-hook.mjs`
runs whenever an agent finishes a turn; if files a page cites changed since
its last deliver, it blocks the stop and lists what is behind. Sync, audit
and deliver as above. It lets go after one retry and warns the user instead,
so it never loops — which also means a deliver is a claim that the change was
reviewed: never deliver just to quiet it.

## Output

Return the page path, the feature / question / unhandled counts from
`deliver`, and any warnings left as gaps. For a plan, lead with what the user
decided, then what is still open, worst first. Never describe a non-zero
`deliver` as success.

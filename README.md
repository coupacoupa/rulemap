# rulemap

A Claude Code plugin that turns an app's business rules into **decision
tables** — from the code as it is, or from a spec before it's built — and
shows every combination nobody decided.

```
                      Age
                      ≤ 14 days    15–30 days       > 30 days
Order   Paid          ● Shown      ● Shown          ● Shown
        Shipped       ● Shown      ◐ Needs seller   ○ Hidden   Q1
        Refunded      ○ Hidden     ○ Hidden         ?  U1
```

One standalone HTML page per feature area: a grid per rule, every input
tagged with whose condition it is (customer, seller, admin, system…), and
an open-questions list — gaps, bugs, conflicts, vague wording — rated
critical / major / minor and linked to the cells they affect.

## Two modes

**Map — how the code behaves now.** "Map how refunds work", "rulemap
`src/billing`". Reads the code and its tests, audits every branch in it, and
records what it fails to handle as questions. Source links pin to a commit
and open at the function's line.

**Plan — how a feature should behave, before it's built.** "Plan gift cards
from `docs/features/gift-cards/spec.md`", or point it at a folder of specs,
or just describe the feature. Reads the spec and the existing code it will
touch. Every combination the spec doesn't decide stays a dashed `?` cell:
the list of decisions to make before anyone writes code. When the feature
ships, the planned tables are checked against the real code.

## Install

In Claude Code:

```
/plugin marketplace add <github-user>/rulemap
/plugin install rulemap@rulemap
```

The first time you use it in a project it asks two things, and saves the
answers in `.claude/rulemap/config.json`:

- **Where pages go** — `docs/features/<area>/` (one page per feature area,
  beside that area's specs), a single page such as `docs/rules/`, or any
  folder you name.
- **Whether to keep them in sync automatically** — no hook (default), a Stop
  hook for the whole team, or one just for you. With the hook, whenever
  Claude finishes a turn that changed code a page cites, it is sent back once
  to update that page.

Change either later with `/rulemap:setup`.

### Skill only

Copy `skills/rulemap/` into `~/.claude/skills/` or a project's
`.claude/skills/`. Setup still runs on first use; ask "set up rulemap" to
redo it.

## CLI

Node 18+, no dependencies. Git is used when present for pinned links and
change tracking; outside a repository, links point at local files.

```bash
node skills/rulemap/bin/rulemap.mjs specs                      # this project's pages
node skills/rulemap/bin/rulemap.mjs validate <spec.json>
node skills/rulemap/bin/rulemap.mjs deliver  <spec.json> --stamp
node skills/rulemap/bin/rulemap.mjs stale    <spec.json>
node skills/rulemap/bin/rulemap.mjs branches <spec.json> --changed
node skills/rulemap/bin/rulemap.mjs setup --dir docs/features --layout area --hook none
```

The spec format is in
[skills/rulemap/references/spec.md](skills/rulemap/references/spec.md).

## License

MIT

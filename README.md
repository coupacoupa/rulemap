# decision-tables

A Claude Code plugin that maps an app's business rules as **decision tables**
in one standalone HTML page, and keeps that page honest as the code changes.

- Conditions against outcomes, one grid per rule: *order status × age →
  refund button shown / needs seller / hidden*.
- Every input is tagged with whose condition it is (customer, seller, admin,
  system…).
- Gaps, bugs, conflicts and unclear intent become open questions rated
  critical / major / minor, linked to and from the cells they affect.
- Combinations no rule covers show up as dashed `?` cells automatically.
- Source links pin to a commit and resolve to the function's line.
- `stale` hashes every cited and watched file, so the page knows when the code
  behind it moved. An optional Stop hook sends Claude back to update it.

No dependencies: Node 18+ and git.

## Install

In Claude Code:

```
/plugin marketplace add <github-user>/decision-tables
/plugin install decision-tables@decision-tables
```

Then ask Claude to "map this app's business rules as decision tables", or
"what happens when … across all combinations".

### Skill only, without the plugin

Copy `skills/decision-tables/` into `~/.claude/skills/` (every project) or
`<project>/.claude/skills/` (one project). You get the skill without the Stop
hook.

## The Stop hook

The plugin registers a Stop hook. It does nothing in a project until that
project has `docs/architecture/feature-decisions.json`. Once it does, whenever
Claude finishes a turn after changing code the page cites, the hook sends it
back once to audit and redeliver the page, then lets go.

Configure per project in `.claude/settings.json`:

```json
{ "env": { "DECISION_TABLES_SPEC": "docs/rules.json", "DECISION_TABLES_HOOK": "off" } }
```

## CLI

```bash
node skills/decision-tables/bin/decision-tables.mjs validate <spec.json>
node skills/decision-tables/bin/decision-tables.mjs deliver  <spec.json> --stamp
node skills/decision-tables/bin/decision-tables.mjs stale    <spec.json>
node skills/decision-tables/bin/decision-tables.mjs branches <spec.json> --changed
```

The spec format is documented in
[skills/decision-tables/references/spec.md](skills/decision-tables/references/spec.md).

## License

MIT

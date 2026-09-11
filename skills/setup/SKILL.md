---
name: setup
description: Choose where this project's rulemap pages live and whether a Stop hook keeps them in sync with the code, or change those choices. rulemap also runs this on first use in a project.
disable-model-invocation: true
---

# Set up rulemap

```bash
DT="${CLAUDE_SKILL_DIR}/../rulemap/bin/rulemap.mjs"
node "$DT" specs    # the current choices and pages; exit 3 = not set up yet
```

Follow [the setup steps](../rulemap/references/setup.md)
(`${CLAUDE_SKILL_DIR}/../rulemap/references/setup.md`), using `$DT` above as
the CLI.

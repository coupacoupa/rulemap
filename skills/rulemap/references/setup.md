# Setting up rulemap in a project

Run once per project — when `node "$DT" specs` exits 3 — before writing any
page, and again whenever the user asks to change where pages live or to turn
the sync hook on or off.

1. **Look before asking.** Note which docs folder the project uses (`docs/`,
   `documentation/`, none yet) and whether decision-table specs already exist
   (`*rulemap.json`, `*decisions.json`, `feature-decisions.json`). When some
   do, offer their location first. On a re-run, show the current choices
   from `node "$DT" specs` and mark them as current.

2. **Ask both questions in one AskUserQuestion call**, with paths adapted to
   the project's docs folder:

   **Pages** — where should rulemap pages live?
   - `docs/features/<area>/` (Recommended) — one page per feature area
     (refunds, checkout, a planned gift-cards), beside that area's specs.
     Plan a feature by pointing at its folder.
   - `docs/rules/` — one page for the whole app, with a side menu of every
     feature.
   - `docs/architecture/` — one page, beside the architecture docs.

   A typed path ending in `/<area>` or `/*` means one page per area; any
   other path, one page.

   **Sync** — keep pages in step with the code automatically?
   - No hook — pages change only when you ask.
   - Team hook — added to `.claude/settings.json` and committed. Whenever
     Claude finishes a turn that changed code a page cites, it is sent back
     once to update that page. Everyone on the project gets it.
   - Just me — the same hook in `.claude/settings.local.json`, with its
     files gitignored.

   Don't mark a hook option as recommended; it is the user's call.

3. **Apply**, from the project root:

   ```bash
   node "$DT" setup --dir <folder> --layout <area|single> --hook <none|project|local>
   ```

   With `area`, `--dir` is the parent folder (`docs/features`). This writes
   `.claude/rulemap/config.json`. For a hook, it also copies the hook and
   the CLI into `.claude/rulemap/`, so the hook runs for teammates without
   the plugin, and adds its entry to the settings file without touching
   other settings. Re-running with a different `--hook` moves or removes it.

4. **Pages already elsewhere** (specs found in step 1, or a re-run that
   changes the folder): offer to move them. Move each JSON to its new
   `rulemap.json` path, set `meta.output` to `rulemap.html` or drop it,
   delete the old HTML, and redeliver so the page and its lock are rebuilt.

5. **Offer a checklist** when `.claude/rulemap/checklist.json` does not exist
   yet: the conditions every feature here must be checked against, and the
   existing changes (admin tools, jobs, deletes) that reach into new features.
   On a yes, draft it from the code — its roles, statuses and flags, and every
   path that writes its main tables — and let the user edit the list before
   it is used. The format is in [spec.md](spec.md).

6. **Tell the user** in two lines what was written, and that
   `/rulemap:setup` (or "set up rulemap") changes it. For the team hook, say
   to commit `.claude/rulemap/` and `.claude/settings.json`. After a plugin
   upgrade, re-running setup with the same answers refreshes the hook's copy
   of the CLI.

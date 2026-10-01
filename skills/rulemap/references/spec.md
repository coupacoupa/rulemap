# Spec format (schema_version 1)

```jsonc
{
  "schema_version": 1,
  "meta": {
    "title": "Refunds",
    "output": "rulemap.html",                      // written beside the spec
    "repository": { "url": "https://github.com/acme/shop", "revision": "<40-char sha>" },
    "watch": ["src/lib/", "src/app/api/"],
    "actors": { "customer": "Customer", "seller": "Seller", "admin": "Admin", "system": "System" }
  },
  "groups": [ { "id": "orders", "label": "Orders" } ],   // side-menu sections, in order
  "features": [
    {
      "id": "refund-eligibility",                   // stable: used in anchors
      "group": "orders",
      "name": "Refund eligibility",
      "summary": "Whether a customer can request a refund on an order.",   // one sentence
      "sources": [ { "path": "src/lib/refunds.ts", "symbol": "canRequestRefund" } ],
      "q": ["Q2"],                                  // optional: questions about the whole feature
      "tables": [
        {
          "id": "window",
          "title": "Order status × age",            // optional caption
          "inputs": [                                // 2 inputs -> grid (rows, columns); else rules
            { "id": "status", "label": "Order", "actor": "customer", "values": [
              { "id": "paid", "label": "Paid" },
              { "id": "shipped", "label": "Shipped" },
              { "id": "refunded", "label": "Refunded" } ] },
            { "id": "age", "label": "Age", "actor": "system", "values": [
              { "id": "d14", "label": "≤ 14 days" },
              { "id": "d30", "label": "15–30 days" },
              { "id": "old", "label": "> 30 days" } ] }
          ],
          "outputs": [
            { "id": "refund", "label": "Refund button", "values": [
              { "id": "yes", "label": "Shown", "tone": "pos" },
              { "id": "ask", "label": "Needs seller", "tone": "warn" },
              { "id": "no", "label": "Hidden", "tone": "neg" } ] }
          ],
          "hit": "unique",                           // or "first": earlier rules win
          "rules": [
            { "when": { "status": "paid", "age": "*" }, "then": { "refund": "yes" }, "note": "not shipped yet" },
            { "when": { "status": "shipped", "age": "d14" }, "then": { "refund": "yes" } },
            { "when": { "status": "shipped", "age": "d30" }, "then": { "refund": "ask" }, "q": ["Q1"] },
            { "when": { "status": "shipped", "age": "old" }, "then": { "refund": "no" } },
            { "when": { "status": "refunded", "age": "*" }, "then": { "refund": "no" } }
          ]
        }
      ]
    }
  ],
  "questions": [
    { "id": "Q1", "severity": "major", "kind": "clarify", "text": "Should day 15 count as inside the free window? The check uses `<` against 14 days." },
    { "id": "Q2", "severity": "minor", "kind": "conflict", "text": "The help page promises 60-day refunds; the code stops at 30." },
    { "id": "Q3", "severity": "major", "kind": "gap", "text": "Shipped and 15–30 days old: refund shown, or sent to the seller?",
      "answer": "Sent to the seller, who has 3 days to approve." }   // settled: kept as the record
  ]
}
```

## Planned features

A feature planned from a spec looks the same, with `"status": "planned"` and
the spec's section as a source:

```jsonc
{
  "id": "gift-card-refunds",
  "group": "orders",
  "name": "Gift card refunds",
  "status": "planned",                               // from a spec, not built yet
  "summary": "How a refund is split when an order was paid partly by gift card.",
  "sources": [
    { "path": "docs/features/gift-cards/spec.md", "symbol": "## Refunds" },   // the section that states the rule
    { "path": "src/lib/refunds.ts", "symbol": "canRequestRefund" }            // existing code it builds on
  ],
  "tables": [ /* as above; combinations the spec leaves open stay uncovered */ ]
}
```

## Rules of the format

- **Actors.** `meta.actors` names the people who use the app, as
  `id -> label`, plus `system` for what no person controls (the payment
  gateway, cron, env flags). Without it the tool falls back to `user`,
  `admin`, `system` and warns. Every input names whose condition it is:
  `"actor"` is one of the ids in `meta.actors`, or a list when the condition
  applies to several roles (`["seller", "admin"]` for anyone who can edit a
  listing). When one axis mixes people, set the input to the main one and give
  the other values their own `"actor"`. When two people in the same role
  matter, name the second with `"as"`:
  `{ "id": "taken", "label": "Holds the order", "actor": "seller", "as": "Other seller" }`.
  Validate fails an input with no actor. The badge renders on the axis
  header, and on each value whose actor differs.
- **Status.** `"built"` (the default) for behaviour mapped from code that
  exists; `"planned"` for behaviour described by a spec and not yet built. A
  planned feature is tagged in its heading and in the menu, and may cite no
  source when the plan exists only in conversation.
- **Granular conditions.** Every input value is one condition. Never merge
  states into one value ("ASSIGNED or EN_ROUTE", "accepts / assigns",
  "stale or missing"): give each its own value, even when they share an
  outcome, because splitting is how differences surface. Validate warns on
  value labels that join conditions with "or" or " / ".
- **`when`**: per input, exactly one value id, or `"*"` when that input truly
  does not affect the rule. An omitted input means `"*"`. Lists are an error:
  write one rule per value.
- **`then`**: every output must be set, unless `"impossible": true`.
- **Hit policy.** `unique` (default): each combination must match exactly one
  rule; overlaps are errors. `first`: the first matching rule wins, which lets
  a final catch-all `{ "when": {} }` stand in for "otherwise". Rules that never
  apply are warned about.
- **Coverage.** Every combination no rule matches becomes an unhandled
  combination: a dashed `?` cell linked to an auto-numbered `U1, U2…` entry at
  the bottom. This is the intended way to show a real gap, and in a plan, a
  decision still to make. Do not add a question that duplicates it.
- **Questions.** `q` on a rule highlights that rule's row and each of its grid
  cells with a link to the question; the question links back. `q` on a feature
  marks its heading. Ids are `Q<n>`; `kind` is `gap | clarify | conflict | bug`.
- **Answers.** A question with an `answer` is settled. It is listed under
  Answered, apart from the open questions, with the answer beneath it; its
  marks turn grey, and it no longer outlines cells or counts toward open
  questions and severity. Keep answered questions as the record of what was
  decided, with `q` still on the rules they produced; delete one only when the
  case it describes no longer exists.
- **Severity** is required on every question and colours its badges, the
  outline of the cells it marks, the feature's menu count (worst wins), and
  its place in the list (worst first):
  - `critical` (red): money is lost or moved wrongly, a security hole, or a
    customer or worker is left stranded or unpaid;
  - `major` (orange): wrong behaviour users will hit, but with a workaround,
    limited reach, or no money at stake;
  - `minor` (yellow): intent unclear, docs drifted, an unexplained number, or
    copy that misleads without consequence.
  Unhandled combinations are `major` automatically.
- **Tones:** `pos`, `neg`, `warn`, `info`, `neutral`. They render as status
  dots on neutral text, not coloured fills: `pos` a filled green dot (the one
  outcome colour), `neg` a hollow dot with muted text, `warn` a half-filled
  dot, `info` and `neutral` no dot. The page is otherwise greyscale; red,
  orange and yellow belong to question severity alone, so pick tones for
  meaning and never to decorate.
- **Text:** plain text; backticks render as `code`. Keep summaries to one
  sentence, notes to a few words, labels to a few words.
- **`"view": "rules"`** on a two-input table forces the rules layout.
- **Size.** Warns above 64 combinations; split the table instead.
- **Sources** are code or documents. `path` must exist in the working tree;
  `symbol`, if given, must appear in it — a function or constant name in
  code, the heading line of a section in a document (`"## Refunds"`). For a
  document, `branches` lists the decision-bearing lines of that section
  (conditions, limits, numbers, table rows) up to the next heading at the
  same level. Markdown, text and HTML are read as documents; in an HTML page
  the symbol is a heading's visible text (`"Refunds & returns"`, or
  `"## Refunds & returns"` for an `<h2>`), and scripts and styles are skipped. Links open on the code host at the pinned revision
  (GitHub-style `/blob/<sha>/<path>#L<n>`) when `meta.repository.url` is set
  and the file is committed there; otherwise they point at the local file,
  relative to the page. `label` overrides the link text.

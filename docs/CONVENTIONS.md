# Documentation Conventions

How we write docs in this repo. The goal is **agent-readable, human-skimmable references** — not marketing, not aspirational text, not a notebook for in-flight work.

This file is the meta-doc. If you change docs structure, naming, or voice, change it here first, then update the affected docs.

---

## Audience

Every doc in `docs/` targets **two readers, in this priority order**:

1. **Coding agents** (Claude, Codex, etc.) trying to make a correct change in this codebase.
2. **Humans** (the author and contributors) skimming for orientation or details.

Agents read top-to-bottom and rely on **concrete file paths, code shapes, and invariants**. Humans skim for structure. Both readers benefit from the same thing: short sections with clear names, real examples, and no waffle.

If a sentence does not help one of those two readers make a decision or correct a misunderstanding, **delete it**.

---

## Three doc types

Every file under `docs/` is one of these. The folder it lives in says which type it is.

### 1. Top-level (`docs/*.md`)

System-wide references read first. The cornerstone set:

- `architecture.md` — what the system is, how the layers fit
- `design.md` — the visual system (tokens, components, principles)
- `server.md` — server-side deep dive
- `editor.md` — admin + canvas editor deep dive
- `CONVENTIONS.md` — this file (docs conventions)

Top-level docs are **long-lived and authoritative**. They describe the system as it currently is. They never describe in-flight work, future plans, or alternatives that were considered. New ones are rare — propose before adding.

### 2. Features (`docs/features/*.md`)

One doc per first-class feature. "Feature" means a coherent capability with a name a user would recognize: plugin system, visual editor, publisher, media, visual components, auth, etc.

Feature docs explain **what the feature is, how it's built, where its code lives, and how to extend it**. They are not specs of what to build — they are descriptions of what exists.

### 3. Reference (`docs/reference/*.md`)

Short, focused, agent-targeted cookbook pages for primitives and patterns that get reused across features: the `NodeTree` primitive, TypeBox patterns, UI primitive usage, design tokens, database dialect rules, the architecture gate tests.

A reference doc answers one question: "How do I correctly use / implement X?"

---

## Folder layout

```
docs/
├── README.md                   Index — where to start, what to read
├── CONVENTIONS.md              This file
├── architecture.md             System overview
├── design.md                   Visual design system
├── server.md                   Server deep-dive
├── editor.md                   Admin + canvas editor deep-dive
│
├── features/                   "What X is and how it works"
│   ├── plugin-system.md
│   ├── publisher.md
│   ├── visual-components.md
│   ├── content-storage.md
│   ├── media.md
│   └── ...
│
├── reference/                  Short cookbook pages
│   ├── page-tree.md
│   ├── ui-primitives.md
│   ├── design-tokens.md
│   ├── typebox-patterns.md
│   ├── database-dialects.md
│   ├── architecture-tests.md
│   └── ...
│
├── deployment/                 Operator docs (platform targets + generic hosts)
├── e2e/                        Agent-run browser test protocols (kept as-is)
└── plans/                      In-flight design plans (transient)
```

**Plans are not docs.** They live in `plans/` because they describe work-in-progress decisions. When a plan ships, the resulting state goes into `features/` or `reference/` — the plan itself is deleted or archived. Never read `plans/` to learn how the system works.

---

## Required shape

Every doc — top-level, feature, or reference — follows this skeleton:

```md
# <Title>

<One-sentence statement of what this doc covers.>

<One paragraph: the problem it solves / the system it describes, in the form
"X is Y that does Z." No history. No "we used to ..." No marketing.>

---

## TL;DR

<Three to ten bullets or a small table. The reader gets the answer here. The
rest of the doc justifies and extends it.>

## <Body sections>

<Specific, named sections. See "Section choices" below.>

## Related

- `docs/<other>.md` — when to read instead / next
- Source-of-truth files: `path/to/file.ts`
- Gate tests: `src/__tests__/architecture/<file>.test.ts`
```

The `Related` section is mandatory. It tells the reader what to read next and where the source of truth lives.

### Section choices by doc type

**Top-level docs** typically have:
- TL;DR
- Layout / Architecture
- Layer responsibilities (table)
- Data flow (ASCII diagram)
- Invariants and gates
- Where things live (file map)
- Related

**Feature docs** typically have:
- TL;DR
- Architecture (what lives where, what depends on what)
- Data flow / lifecycle
- Adding a new X (cookbook)
- Forbidden patterns / gotchas
- Related

**Reference docs** typically have:
- TL;DR
- The shape (type signatures, file paths, the canonical example)
- How to use it (one or two cookbook examples)
- Forbidden patterns
- Related

---

## Voice and content rules

### Hard rules

1. **Anchor every claim to a real path.** Not "the editor store" — `src/admin/pages/site/store/slices/site/helpers.ts`. Not "the page tree mutations" — `src/core/page-tree/mutations.ts`. Paths give agents the next thing to read.

2. **Use the present tense and the indicative mood.** "The publisher converts the page tree to HTML." Not "The publisher should convert ..." or "The publisher will convert ...". If the behavior isn't true today, don't document it.

3. **Cite the source of truth.** Each feature has one canonical file or folder that defines its shape. State it explicitly: "The source of truth for X is `<path>`." When in doubt, that file's exported types are correct and the doc is wrong.

4. **Link gate tests.** Whenever a doc states an invariant ("page trees use `NodeTree<PageNode>`", "no Tailwind in CSS modules"), link the architecture test that enforces it: `src/__tests__/architecture/<name>.test.ts`. The test is the actual contract; the doc is human-readable shorthand.

5. **Show real code, not pseudo-code.** Examples come from the codebase, lightly trimmed. Never invent APIs that don't exist. Never show "imagine an `X.foo()` method" — agents will try to call it.

6. **Forbidden patterns are listed explicitly.** Every feature doc has a "Forbidden patterns" or "Gotchas" section that names the wrong way to do the thing, in addition to the right way. Agents that only see the happy path will reinvent the wrong pattern.

7. **No history. No "we used to ..." No comparisons to previous designs.** The repo is pre-release. There is one current design. Document that. Git remembers the rest.

8. **No aspiration. No "we plan to ..."** If it's planned but not built, it goes in `docs/plans/`, not in a feature or reference doc.

9. **One topic per doc.** A feature doc covers one feature. A reference doc answers one question. If a doc is sprawling, split it. If two docs heavily overlap, merge them.

10. **No marketing copy.** No "blazing fast", "delightful", "first-class", "powerful", "robust", "modern". Describe what the code does, not how good it is.

### Soft rules

- **Lead with TL;DR.** Even short docs. The reader should be able to leave after the TL;DR with most of the answer.
- **Tables beat prose** when comparing options, listing responsibilities, or showing mappings.
- **ASCII diagrams beat prose** for layout, data flow, and folder structure.
- **Use code blocks for paths**, type signatures, commands, and file shapes. Fenced with the appropriate language hint (`ts`, `tsx`, `css`, `sh`, `text`).
- **Prefer "do X" over "you should do X".** Direct imperative beats hedged advice.
- **Cap at ~600 lines per doc.** If you're over, the doc is doing too much. Split.

---

## Naming conventions

| Doc type     | Filename                  | Example                          |
|--------------|---------------------------|----------------------------------|
| Top-level    | `lowercase-with-dashes.md`| `architecture.md`, `design.md`   |
| Feature      | `feature-name.md`         | `features/plugin-system.md`      |
| Reference    | `topic.md`                | `reference/page-tree.md`         |
| Meta / index | `UPPERCASE.md`            | `CONVENTIONS.md`, `README.md`    |

Filenames match the dominant concept. If a doc is about the page tree, it's `page-tree.md`. Not `tree-data-structure.md`, not `node-tree-explained.md`, not `nodes.md`.

---

## When to add, update, or delete a doc

### Add a feature doc when

- A new first-class capability lands. (New folder under `src/admin/pages/`, new module pack, new system table, new lifecycle hook surface.)
- An existing feature crosses a complexity threshold where the code no longer documents itself.

Do not add a feature doc for an internal refactor, a one-off utility, or a bug fix.

### Add a reference doc when

- A primitive or pattern gets used in three or more places and agents keep using it wrong.
- A gate test enforces an invariant that needs a human-readable explanation.

### Update a doc when

- You changed code that the doc describes — update the doc in the **same change**. A PR that updates code without updating the matching doc is incomplete.
- You discovered the doc was wrong or stale.

### Delete a doc when

- The feature it described was removed.
- The doc was a plan and the plan shipped (move the lasting parts into `features/` or `reference/`, delete the rest).

Pre-release rule applies: **no deprecation notes, no "this is being replaced", no archives of old docs.** Delete is delete.

---

## Relationship to `CLAUDE.md`

`CLAUDE.md` is the **agent entry-point and rule book** at the repo root. It is short, dense, prescriptive — it tells agents what to do and what not to do.

`docs/*` are the **explanatory references** `CLAUDE.md` points to. When an agent needs to know *what something is* or *how to extend it*, the trail goes:

```
CLAUDE.md (rule)
    → docs/architecture.md (system context)
        → docs/features/<thing>.md (the feature)
            → docs/reference/<primitive>.md (the building block)
                → src/<actual code>
```

**Rule of thumb:**
- If it's a rule (must / must not), it goes in `CLAUDE.md`.
- If it's an explanation (what / why / how), it goes in `docs/`.
- `CLAUDE.md` cites `docs/` for the explanation. `docs/` does not duplicate `CLAUDE.md`'s rules — it links to them.

---

## Quick checklist before committing a doc

- [ ] Has a one-sentence statement of scope under the title.
- [ ] Has a TL;DR section.
- [ ] Has a Related section with source-of-truth paths and gate tests.
- [ ] Every claim about code anchors to a real file path.
- [ ] Every invariant links to a gate test where one exists.
- [ ] No history, no aspiration, no marketing.
- [ ] No invented APIs.
- [ ] Code examples are real and currently valid.
- [ ] Under ~600 lines.
- [ ] Filename matches the naming convention.
- [ ] Lives in the right folder for its type.

---

## Related

- `CLAUDE.md` — the agent rule book this docs tree supports
- `docs/README.md` — the docs index
- `docs/architecture.md` — start here for system orientation

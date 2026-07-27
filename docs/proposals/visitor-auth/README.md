# Visitor authentication + per-visitor data — proposal

This folder contains the design rationale for the visitor-auth + per-visitor-data
contribution (see the issue/PR for the summary). Read in this order:

| Doc | What it is |
|---|---|
| **PRD.md** | The product spec — problem statement, user stories, the full technical architecture (endpoints, schema, security, request flow). Start here. |
| **PRD-REVIEW.md** | The review cycle that shaped the architecture — findings (critical/high/medium/low) and how each was resolved. Read if you want the "why" behind design decisions. |
| **ARCHITECTURE.md** | The resolved design decisions (final, validated against the codebase) + the file map + rebase conflict surface. |
| **PER-VISITOR-DATA-SPEC.md** | The per-visitor-data framework spec (custom profile fields, the `visitor.current` / `visitor.owned-rows` loop sources, IDOR model). |

These are proposal docs, not part of the canonical Instatic docs tree — they
document the rationale for this contribution and can be removed if the proposal
is declined (or folded into the main docs if adopted).

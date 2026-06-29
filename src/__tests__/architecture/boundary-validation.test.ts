/**
 * Architecture Source-Scan — Boundary Validation
 *
 * Every untyped boundary in the codebase must be validated with TypeBox before
 * its data reaches application state. This gate locks in the four rules that
 * Phases 1–3 of the boundary-validation refactor established:
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  RULE 1  Client HTTP response cast                                       │
 * │  `res.json() as X` is banned in src/core/persistence/ and src/admin/.   │
 * │  Canonical replacement:                                                  │
 * │    • `apiRequest(path, { schema })` in src/admin/ code                  │
 * │    • `readEnvelope(res, Schema, fallback)` when holding a raw Response  │
 * │  Both live in @core/http.                                                │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │  RULE 2  JSON.parse cast at a persisted-data boundary                   │
 * │  `JSON.parse(...) as X` is banned in src/core/persistence/.             │
 * │  Canonical replacement: `safeParseJson(raw, Schema)` or                 │
 * │  `parseJsonWithFallback(raw, Schema, default)` from @core/utils.        │
 * │  Scoped to persistence/ only — NDJSON stream parsing and test           │
 * │  utilities outside that directory are a different concern.              │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │  RULE 3  Raw fetch() in admin client code                               │
 * │  Direct `fetch(` calls in src/admin/ are banned — they bypass           │
 * │  `credentials: 'include'`, standardised error handling, and the         │
 * │  TypeBox-schema option that `apiRequest` enforces.                      │
 * │  Exceptions: streaming NDJSON and fire-and-forget POSTs that            │
 * │  apiRequest cannot model (see ALLOWLIST_FETCH below, §3.x entries).    │
 * │  Note: src/core/http/ is the canonical helper and is not scanned here;  │
 * │  src/core/persistence/ uses an injectable fetchImpl (the sanctioned      │
 * │  boundary for that layer) and is similarly excluded. This rule covers   │
 * │  src/admin/ only, which is the cleanest scope.                          │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │  RULE 4  Raw req.json() in server handler code                          │
 * │  Direct `req.json(` calls in server/ are banned — all request bodies    │
 * │  must be parsed through the single shared helper `readValidatedBody`    │
 * │  in server/http.ts, which does the try/catch and TypeBox validation     │
 * │  in one place. Only server/http.ts itself is allowed to call req.json() │
 * ├──────────────────────────────────────────────────────────────────────────┤
 * │  RULE 5  Deep-cast of a validated envelope field                        │
 * │  After `const body = await readEnvelope(...)` (or parseJsonResponse),   │
 * │  casting one of its fields to a deep type — `body.x as DeepType` — is    │
 * │  banned in src/core/persistence/. The cast gives false TypeScript        │
 * │  confidence: the envelope schema only validated `x` as Type.Unknown(),  │
 * │  so server type-drift surfaces at runtime as undefined-in-UI, invisible  │
 * │  to RULE 1 (which only catches `res.json() as`). Fix by referencing the  │
 * │  field's real TypeBox schema in the envelope so the parsed value is      │
 * │  already typed (most deep types own a schema: FontEntrySchema in         │
 * │  @core/fonts; SiteDependencyLock/PublishedPageRuntimeAssets/             │
 * │  SiteRuntimeDiagnostic/RuntimePackageImportmap in @core/site-runtime;    │
 * │  PluginRecordSchema in @core/plugin-sdk). Genuinely-unavoidable cases    │
 * │  (interface-only deep types) are allowlisted with a §5.x justification.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * @see src/core/http/apiClient.ts — apiRequest, readEnvelope, responseErrorMessage
 * @see server/http.ts             — readValidatedBody (the server-side boundary helper)
 * @see src/core/utils/jsonValidate.ts — safeParseJson, parseJsonWithFallback
 * @see src/__tests__/architecture/db-postgres-isms.test.ts — mirror for DB rules
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')

// ---------------------------------------------------------------------------
// File walker — .ts and .tsx files, recursive
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (extname(entry) === '.ts' || extname(entry) === '.tsx') out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// Comment stripper — preserves line numbers so violation line numbers
// line up with the original source (same approach as db-postgres-isms.test.ts)
// ---------------------------------------------------------------------------

const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm

function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
}

// ---------------------------------------------------------------------------
// Scan roots per rule
// ---------------------------------------------------------------------------

const PERSISTENCE_ROOT = join(PROJECT_ROOT, 'src/core/persistence')
const ADMIN_ROOT = join(PROJECT_ROOT, 'src/admin')
const SERVER_ROOT = join(PROJECT_ROOT, 'server')

// ---------------------------------------------------------------------------
// Allowlists — every entry has a §-numbered justification
// ---------------------------------------------------------------------------

/**
 * Files entirely exempt from RULE 1 (`res.json() as` cast).
 * The src/core/http/ module is the canonical client helper — it is where
 * parseJsonResponse (which internally calls `res.json() as unknown`) lives,
 * so its own implementation of the boundary is expected.
 */
const ALLOWLIST_RES_JSON_AS = new Set<string>([
  // (No entries required — after Phase 1 cleanup, no res.json() as patterns
  // remain in src/core/persistence/ or src/admin/. The helpers in src/core/http/
  // and src/core/utils/jsonValidate.ts are outside the scan roots by design.)
])

/**
 * Files entirely exempt from RULE 2 (`JSON.parse(...) as` cast in persistence/).
 */
const ALLOWLIST_JSON_PARSE_AS = new Set<string>([
  // (No entries required — after Phase 1 cleanup, no JSON.parse as patterns
  // remain in src/core/persistence/.)
])

/**
 * Files entirely exempt from RULE 3 (raw `fetch(` in admin client code).
 * §3.x entries document the engineering reason each site is legitimately raw.
 */
const ALLOWLIST_FETCH = new Set<string>([
  // §3.1  agentSlice.ts — streaming NDJSON chat. apiRequest returns a parsed
  //   value, so it cannot stream an NDJSON response body; raw fetch +
  //   ReadableStream is required. Non-streaming agent requests, including
  //   tool-result POSTs, must use apiRequest.
  join(PROJECT_ROOT, 'src/admin/pages/site/agent/agentSlice.ts'),

  // §3.6  useEditorMcpBridge.ts — holds a long-lived NDJSON stream open
  //   (`/admin/api/ai/editor-bridge`) so MCP browser-tool calls can be relayed
  //   to the open editor. Same constraint as §3.1: apiRequest returns a parsed
  //   value and cannot stream a response body, so raw fetch + ReadableStream is
  //   required. The tool-result POST still goes through apiRequest (postToolResult).
  join(PROJECT_ROOT, 'src/admin/pages/site/agent/useEditorMcpBridge.ts'),

  // §3.2  SvgControl.tsx — fetches the raw bytes of a user-picked .svg asset
  //   from its public path (asset.publicPath) to inline its markup. This is a
  //   plain file-content GET, not a JSON-envelope CMS endpoint, so apiRequest
  //   (which validates a TypeBox success body) cannot model it — the response
  //   body is SVG text, sanitized via sanitizeSvg before use.
  join(PROJECT_ROOT, 'src/admin/pages/site/property-controls/SvgControl.tsx'),
])

/**
 * Files entirely exempt from RULE 4 (raw `req.json(` in server handler dirs).
 * §4.x entries document the engineering reason.
 */
const ALLOWLIST_REQ_JSON = new Set<string>([
  // §4.1  server/http.ts — readValidatedBody is the ONLY sanctioned body-parsing
  //   entry point in the server. Its internal `req.json()` call (inside a
  //   try/catch that catches malformed JSON and returns null) IS the canonical
  //   boundary. Every handler in server/ must delegate to it, never call
  //   req.json() directly.
  join(PROJECT_ROOT, 'server/http.ts'),
])

/**
 * Files exempt from RULE 5 (deep-cast of a validated envelope field). Each
 * §5.x entry documents the deep types involved and why a real schema is not
 * yet wired up. These are tracked follow-ups, NOT permanent exemptions — the
 * goal is to convert the underlying interfaces to schema-derived types so the
 * envelope can validate them directly, at which point the entry is removed.
 */
const ALLOWLIST_ENVELOPE_FIELD_CAST = new Set<string>([
  // §5.1  cmsPlugins.ts — body.plugin as InstalledPlugin (×4), body.manifest as
  //   PluginManifest, body.schema/settings as PluginSettings*. InstalledPlugin
  //   and PluginManifest are large hand-authored interfaces in @core/plugin-sdk
  //   (PluginManifest embeds entrypoints, resources, adminPages, settings,
  //   frontend, packs; InstalledPlugin embeds the full manifest plus host
  //   bookkeeping). A canonical `manifestSchema` exists in the manifest parser
  //   but is intentionally not 1:1 with the interface (it applies post-parse
  //   defaults). Converting these interfaces to schema-derived source-of-truth
  //   types is a plugin-SDK refactor out of scope for the persistence-boundary
  //   hardening pass; tracked as follow-up.
  join(PROJECT_ROOT, 'src/core/persistence/cmsPlugins.ts'),

  // §5.2  cmsMediaStorage.ts — body.election as CmsMediaElection, body.result as
  //   MediaStorageVerifyResult (plus several `(body.x ?? []) as ReadonlyArray<…>`).
  //   The media-storage summary types (CmsMediaElection, MediaStorageVerifyResult,
  //   CmsMediaAdapterSummary, CmsMediaElectedVariantDelegate, …) are interface-only
  //   in @core/plugin-sdk/types/media.ts with no TypeBox schemas. Authoring them is
  //   a separate media-storage domain pass; tracked as follow-up.
  join(PROJECT_ROOT, 'src/core/persistence/cmsMediaStorage.ts'),
])

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  /** Relative path from project root, e.g. `src/admin/ai/api.ts`. */
  file: string
  /** 1-based line number. */
  line: number
  /** Rule name (for human-readable output). */
  rule: string
  /** The matched text. */
  match: string
}

// ---------------------------------------------------------------------------
// Generic scanner — runs one regex against a set of files
// ---------------------------------------------------------------------------

function scan(
  roots: string[],
  allowlist: Set<string>,
  ruleName: string,
  regex: RegExp,
  /** Optional per-line exclusion regex — matching lines are skipped. */
  lineExclusion?: RegExp,
): Violation[] {
  const files = roots.flatMap((r) => walk(r)).filter((f) => !allowlist.has(f))
  const violations: Violation[] = []

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // Skip test files co-located inside scanned directories (e.g. spotlight/__tests__)
    if (file.includes('__tests__') || file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
      continue
    }

    const lines = stripComments(content).split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (lineExclusion?.test(line)) continue
      const m = regex.exec(line)
      if (m !== null) {
        violations.push({
          file: relative(PROJECT_ROOT, file),
          line: i + 1,
          rule: ruleName,
          match: m[0],
        })
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Envelope-field-cast scanner (RULE 5)
//
// Two-pass per file:
//   1. Collect the names of variables assigned from readEnvelope /
//      parseJsonResponse (the validated-envelope vars), e.g. `const body = …`,
//      `const payload = …`, `const body: VerifyBody = …`.
//   2. Flag any line that casts a FIELD of one of those vars to a PascalCase
//      type: `<var>.<field> as <DeepType>`.
//
// This is precise on purpose: it does NOT flag whole-object assertions
// (`body as Foo`) or internal casts on unrelated locals (`p.nodes as Record`),
// only the "validated the envelope shallowly, then lied about a field's deep
// type" pattern that RULE 1 cannot see.
// ---------------------------------------------------------------------------

const ENVELOPE_ASSIGN_RE =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*await\s+(?:readEnvelope|parseJsonResponse)\b/

/** True if `line` casts a field of one of `vars` to a PascalCase type. */
function envelopeFieldCast(line: string, vars: Set<string>): string | null {
  for (const v of vars) {
    const re = new RegExp(`\\b${v}\\.[A-Za-z0-9_]+\\s+as\\s+[A-Z][A-Za-z0-9_]+`)
    const m = re.exec(line)
    if (m !== null) return m[0]
  }
  return null
}

function scanEnvelopeFieldCasts(root: string, allowlist: Set<string>): Violation[] {
  const files = walk(root).filter((f) => !allowlist.has(f))
  const violations: Violation[] = []

  for (const file of files) {
    if (file.includes('__tests__') || file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
      continue
    }
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const lines = stripComments(content).split('\n')

    // Pass 1 — collect envelope var names.
    const vars = new Set<string>()
    for (const line of lines) {
      const m = ENVELOPE_ASSIGN_RE.exec(line)
      if (m !== null) vars.add(m[1])
    }
    if (vars.size === 0) continue

    // Pass 2 — flag field casts on those vars.
    for (let i = 0; i < lines.length; i++) {
      const match = envelopeFieldCast(lines[i], vars)
      if (match !== null) {
        violations.push({
          file: relative(PROJECT_ROOT, file),
          line: i + 1,
          rule: 'envelope field cast — validate the field via its TypeBox schema, do not cast',
          match,
        })
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Formatted error for failing tests
// ---------------------------------------------------------------------------

function formatViolations(
  violations: Violation[],
  heading: string,
  guidance: string,
  allowlistNote: string,
): Error {
  const lines = violations.map(
    (v) =>
      `  ${v.file}:${v.line} — [${v.rule}]\n` + `    matched: ${JSON.stringify(v.match)}`,
  )
  return new Error(
    `[boundary-validation] ${heading}\n` +
      `${guidance}\n\n` +
      `Violations:\n` +
      lines.join('\n') +
      (allowlistNote ? `\n\n${allowlistNote}` : ''),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Boundary validation — HTTP and JSON parse boundaries must use TypeBox', () => {
  // ── Sanity: scan roots exist and yield files ──────────────────────────────

  test('SCAN_ROOTS all resolve to directories containing .ts/.tsx files', () => {
    const allRoots = [PERSISTENCE_ROOT, ADMIN_ROOT, SERVER_ROOT]
    for (const root of allRoots) {
      const count = walk(root).length
      if (count === 0) {
        throw new Error(
          `[boundary-validation] SCAN_ROOT resolved to zero .ts/.tsx files: ${root}\n` +
            `If the directory was moved, update the path constant in this file.`,
        )
      }
      expect(count).toBeGreaterThan(0)
    }
  })

  test('RULE 1 sanity — persistence scan root contains at least one persistence file', () => {
    // Guard against a silent empty scan for the persistence-specific rules.
    const persistenceFiles = walk(PERSISTENCE_ROOT)
    expect(persistenceFiles.length).toBeGreaterThan(0)
  })

  // ── Rule 1: no `res.json() as` in persistence or admin ───────────────────

  test('RULE 1 — no res.json() as cast in src/core/persistence/ or src/admin/', () => {
    // `.json() as X` at an HTTP success-path boundary bypasses TypeBox
    // validation. Use readEnvelope(res, Schema, fallback) or apiRequest
    // with a schema option instead (both are from @core/http).
    // Note: `as unknown` inside the helpers themselves (jsonValidate.ts,
    // apiClient.ts) is safe and those files are outside the scan roots.
    const violations = scan(
      [PERSISTENCE_ROOT, ADMIN_ROOT],
      ALLOWLIST_RES_JSON_AS,
      'res.json() as cast — use readEnvelope or apiRequest with schema',
      /\.json\(\)\s*as\b/,
    )

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }
    throw formatViolations(
      violations,
      `${violations.length} res.json() as cast(s) found at HTTP boundaries.`,
      'Replace with readEnvelope(res, Schema, fallback) or apiRequest(path, { schema }) from @core/http.',
      'See src/core/http/apiClient.ts for the canonical helpers.',
    )
  })

  // ── Rule 2: no `JSON.parse(...) as` in persistence ───────────────────────

  test('RULE 2 — no JSON.parse(...) as cast in src/core/persistence/', () => {
    // `JSON.parse(raw) as Foo` at a persisted-data boundary (localStorage,
    // NDJSON export, settings files) bypasses TypeBox validation.
    // Use safeParseJson(raw, Schema) (hard) or parseJsonWithFallback
    // (soft/with default) from @core/utils/jsonValidate.ts.
    //
    // Scoped to src/core/persistence/ only. Other JSON.parse usages outside
    // this directory (e.g. SSE event parsing in pluginEventStream.ts, CLI
    // dev scripts, test helpers) are a separate concern from the persisted-
    // data boundary and are not caught by this rule.
    const violations = scan(
      [PERSISTENCE_ROOT],
      ALLOWLIST_JSON_PARSE_AS,
      'JSON.parse as cast — use safeParseJson or parseJsonWithFallback',
      /\bJSON\.parse\b.*\bas\b/,
    )

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }
    throw formatViolations(
      violations,
      `${violations.length} JSON.parse(...) as cast(s) found in src/core/persistence/.`,
      'Replace with safeParseJson(raw, Schema) or parseJsonWithFallback(raw, Schema, default) from @core/utils/jsonValidate.',
      'See src/core/utils/jsonValidate.ts for the canonical helpers.',
    )
  })

  // ── Rule 3: no raw fetch() in src/admin/ (outside allowlist) ─────────────

  test('RULE 3 — no raw fetch() in src/admin/ outside the allowlisted sites', () => {
    // Direct fetch() calls in admin client code bypass the canonical
    // apiRequest wrapper, which sets credentials:'include', enforces
    // TypeBox schema validation, and standardises ApiError propagation.
    // Exceptions (see ALLOWLIST_FETCH): streaming NDJSON and fire-and-
    // forget tool POSTs that apiRequest cannot model.
    //
    // Scoping note: this rule covers src/admin/ only.
    //   - src/core/http/ is the canonical helper — it IS the boundary,
    //     not a consumer.
    //   - src/core/persistence/ uses an injectable fetchImpl (the
    //     sanctioned boundary for that layer) and is excluded.
    //   - server/ uses Bun.serve request handling, not client fetch.
    const violations = scan(
      [ADMIN_ROOT],
      ALLOWLIST_FETCH,
      'raw fetch() — use apiRequest from @core/http instead',
      /\bfetch\(/,
    )

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }
    throw formatViolations(
      violations,
      `${violations.length} raw fetch() call(s) found in src/admin/ outside the allowlist.`,
      'Replace with apiRequest(path, { method, body, schema }) from @core/http.\n' +
        'Only the allowlisted streaming, file-content, and import-plumbing cases require raw fetch.',
      `Allowlisted files (legitimately raw):\n` +
        [...ALLOWLIST_FETCH].map((f) => `  ${relative(PROJECT_ROOT, f)}`).join('\n'),
    )
  })

  // ── Rule 4: no raw req.json() in server/ (outside readValidatedBody) ─────

  test('RULE 4 — no raw req.json() in server/ outside server/http.ts', () => {
    // Every server request body must flow through readValidatedBody(req, Schema)
    // in server/http.ts, which performs the try/catch around req.json() and
    // the TypeBox safeParseValue check in one place. Calling req.json()
    // directly in a handler re-implements this without the guaranteed
    // schema validation — the caller may forget to validate, or may use
    // as-casts instead.
    const violations = scan(
      [SERVER_ROOT],
      ALLOWLIST_REQ_JSON,
      'raw req.json() — use readValidatedBody(req, Schema) from server/http.ts',
      /\breq\.json\(/,
    )

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }
    throw formatViolations(
      violations,
      `${violations.length} raw req.json() call(s) found in server/ outside the allowlisted helper.`,
      'Replace with: const body = await readValidatedBody(req, Schema)\n' +
        'Return badRequest(...) when body is null (parse failure or schema mismatch).',
      `Allowlisted files:\n` +
        [...ALLOWLIST_REQ_JSON].map((f) => `  ${relative(PROJECT_ROOT, f)}`).join('\n'),
    )
  })

  // ── Rule 5: no `<envelopeVar>.<field> as DeepType` in persistence ────────

  test('RULE 5 — no deep-cast of a validated envelope field in src/core/persistence/', () => {
    // After readEnvelope/parseJsonResponse, a field cast (`body.x as DeepType`)
    // bypasses validation for that field — the envelope only checked it as
    // Type.Unknown(). Reference the field's real TypeBox schema in the envelope
    // instead, so the parsed value is already correctly typed.
    const violations = scanEnvelopeFieldCasts(PERSISTENCE_ROOT, ALLOWLIST_ENVELOPE_FIELD_CAST)

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }
    throw formatViolations(
      violations,
      `${violations.length} envelope-field deep-cast(s) found in src/core/persistence/.`,
      'Reference the field’s canonical TypeBox schema in the envelope (e.g. FontEntrySchema,\n' +
        'SiteDependencyLockSchema, PluginRecordSchema) so readEnvelope returns the typed value —\n' +
        'then delete the `as DeepType` cast. Allowlist interface-only deep types with a §5.x note.',
      `Allowlisted files (interface-only deep types, tracked follow-ups):\n` +
        [...ALLOWLIST_ENVELOPE_FIELD_CAST].map((f) => `  ${relative(PROJECT_ROOT, f)}`).join('\n'),
    )
  })

  // ── Rule 5 meta-test: prove the scanner actually catches the class ───────

  test('RULE 5 detector matches the `body.x as DeepType` pattern it is meant to gate', () => {
    // Guards against the gate silently rotting into a no-op (e.g. a regex typo
    // that matches nothing). We feed the detector a synthetic envelope var and
    // assert it flags the old pattern and ignores the validated-without-cast
    // and whole-object-assertion shapes.
    const vars = new Set(['body', 'payload'])

    // Positive: the exact pattern the old code used (and the gate forbids).
    expect(envelopeFieldCast('  return body.font as FontEntry', vars)).not.toBeNull()
    expect(
      envelopeFieldCast('    plugin: body.plugin as InstalledPlugin | undefined,', vars),
    ).not.toBeNull()
    expect(envelopeFieldCast('  return payload.font as FontEntry', vars)).not.toBeNull()

    // Negative: the fixed shape — a validated field returned with no cast.
    expect(envelopeFieldCast('  return payload.font', vars)).toBeNull()
    expect(envelopeFieldCast('    dependencyLock: body.dependencyLock,', vars)).toBeNull()

    // Negative: a whole-object assertion (`body as Foo`) is a different, lower
    // concern and not part of this rule.
    expect(envelopeFieldCast('  const cast = body as PluginRecordsPayload', vars)).toBeNull()

    // Negative: a cast on an unrelated local (not an envelope var).
    expect(envelopeFieldCast('  p.nodes as Record<string, BaseNode>', vars)).toBeNull()

    // The envelope-assignment detector recognises both typed and untyped forms.
    expect(ENVELOPE_ASSIGN_RE.test('  const body = await readEnvelope(res, S, msg)')).toBe(true)
    expect(ENVELOPE_ASSIGN_RE.test('  const body: VerifyBody = await readEnvelope(')).toBe(true)
    expect(ENVELOPE_ASSIGN_RE.test('  const x = await parseJsonResponse(res, S)')).toBe(true)
  })
})

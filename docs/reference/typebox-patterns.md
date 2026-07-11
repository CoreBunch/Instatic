# TypeBox Patterns

How the codebase validates every untyped boundary with [TypeBox](https://github.com/sinclairzx81/typebox) — what helper to reach for, what shape a schema takes, and how to migrate from older Zod patterns.

The principle: **validate, then trust.** Every input from outside (HTTP, `JSON.parse`, plugin manifests, persisted JSON on disk) goes through a TypeBox schema. Inside the boundary, the code treats the value as the schema says it is — no `as Foo` casts.

Schemas are the **source of truth**. Domain types come from `Static<typeof Schema>`. There is no parallel `interface Foo` next to `FooSchema`.

---

## TL;DR

- **Helpers live in `src/core/utils/typeboxHelpers.ts`** — `Type`, `Value`, `Static`, `withFallback`, `parseValue`, `safeParseValue`, `filterArray`, `formatValueErrors`.
- **Compiled validators live in `src/core/utils/typeboxCompiler.ts`** — `compiled`, `compiledCheck`, `compiledDecode`, `compiledSafeParseValue`, `compiledFormatValueErrors`. Hot repeated `Check` / `Decode` / `Errors` paths should use these or helpers that already call them.
- **JSON boundary helpers live in `src/core/utils/jsonValidate.ts`** — `safeParseJson`, `parseJsonWithFallback`, `parseJsonResponse`.
- **Canonical client HTTP layer:** `@core/http` — `apiRequest(path, { schema, … })` (the default for JSON browser→server calls), `apiBlobRequest(path, …)` for binary responses, plus `ApiError`, `isAbortError`, `readEnvelope`, `responseErrorMessage`, `ErrorEnvelopeSchema`. All defined in `src/core/http/apiClient.ts`.
- **Schemas are source of truth.** `type Foo = Static<typeof FooSchema>` — never a hand-rolled interface beside the schema.
- **Soft fallbacks** for corrupted local storage / optional config use `withFallback(schema, default)` + `parseJsonWithFallback`.
- **Hard fallbacks** for required documents throw and bubble to an error boundary.
- **`zod` is banned repo-wide.** The AI drivers hit each provider's REST API directly and pass TypeBox schemas through as JSON Schema, so nothing imports Zod anymore; the package has been removed from `package.json`. Gated by `ai-driver-isolation.test.ts`.

---

## The two boundary types

### Hard boundary — validate or fail

Use for inputs where invalid data is genuinely an error: HTTP request bodies, HTTP response envelopes the UI needs, required configuration files.

```ts
import { Type, parseValue } from '@core/utils/typeboxHelpers'

const RequestBodySchema = Type.Object({
  email:    Type.String({ format: 'email' }),
  password: Type.String({ minLength: 1 }),
})

const body = parseValue(RequestBodySchema, await req.json())
// body is now typed and validated; throws on invalid input
```

### Soft boundary — validate or fall back

Use for inputs where corruption shouldn't brick the UI: localStorage reads, optional persisted settings, tolerant array parsing where one bad entry shouldn't invalidate the rest.

```ts
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

const prefs = parseJsonWithFallback(
  localStorage.getItem('editorPrefs') ?? '',
  EditorPreferencesSchema,
  DEFAULT_PREFERENCES,
)
// prefs is always valid; corrupted storage falls back silently
```

---

## Helper reference

### `src/core/utils/typeboxHelpers.ts`

| Helper                            | Purpose                                                              |
|-----------------------------------|----------------------------------------------------------------------|
| `Type`                            | Re-export from `@sinclair/typebox` — build schemas                   |
| `Value`                           | Re-export — reserved mainly for `Value.Parse` and `Value.Create`; prefer compiled helpers for repeated `Check` / `Decode` / `Errors` |
| `Static<typeof Schema>`           | Type inference — equivalent to `z.infer<typeof S>`                   |
| `parseValue(schema, value)`       | Strict parse with TypeBox's full `Value.Parse` pipeline; use when defaults/conversion/cleaning matter |
| `safeParseValue(schema, value)`   | Discriminated union `{ ok: true, value } \| { ok: false, errors }`; uses the compiled validator cache |
| `withFallback(schema, fallback)`  | Annotate a schema with a default; consulted by `parseWithFallbackAnnotation` and similar |
| `filterArray(itemSchema, values)` | Filter an `unknown[]` keeping only items matching the schema; uses the compiled validator cache |
| `formatValueErrors(schema, value)`| Human-readable error message string for failed validation; uses the compiled validator cache |

### `src/core/utils/typeboxCompiler.ts`

| Helper                                      | Purpose                                                          |
|---------------------------------------------|------------------------------------------------------------------|
| `compiled(schema)`                          | Return the cached `TypeCheck` for a schema, compiling it once per schema object |
| `compiledCheck(schema, value)`              | Boolean validation via the cached compiled validator              |
| `compiledDecode(schema, value)`             | Decode via the cached compiled validator                          |
| `compiledSafeParseValue(schema, value)`     | Compiled equivalent of `safeParseValue`                           |
| `compiledFormatValueErrors(schema, value)`  | Compact error formatter using the compiled validator's errors     |

### `src/core/utils/jsonValidate.ts`

| Helper                                          | Purpose                                                          |
|-------------------------------------------------|------------------------------------------------------------------|
| `safeParseJson(raw, schema)`                    | Parse a string as JSON + validate; returns `{ ok, value } \| { ok, error }` |
| `parseJsonWithFallback(raw, schema, default)`   | Best-effort read; returns the default on parse / validate failure|
| `parseJsonResponse(res, schema)`                | Validate `await res.json()` against a schema using the compiled validator cache; throws on mismatch |

### `src/core/http/apiClient.ts` (canonical client HTTP layer, `@core/http`)

| Helper                                          | Purpose                                                          |
|-------------------------------------------------|------------------------------------------------------------------|
| `apiRequest(path, { method, body, schema, query, signal, … })` | **The default for browser→server calls.** Sets `credentials`, JSON-serializes `body`, validates the success body against `schema` (returns `Static<schema>`; `void` without one), and throws `ApiError` on a non-OK status. |
| `apiBlobRequest(path, { signal, … })`           | Binary-response counterpart for authenticated image/file reads. Uses the same transport and `ApiError` envelope handling, then returns a `Blob`; the caller validates the MIME type before use. |
| `readEnvelope(res, schema, fallbackMessage)`    | For code that already holds a `Response` (the persistence layer, which injects its own `fetch`): check `res.ok` (throw `ApiError` with `responseErrorMessage(res, fallback)` if not), then validate body against `schema` |
| `assertOk(res, fallbackMessage)`                | No-body counterpart to `readEnvelope`: throw `ApiError` if the `Response` is not OK, otherwise return (for void mutations / bodies parsed separately) |
| `responseErrorMessage(res, fallback)`           | Extract a useful error message from a failed `Response` (reads `{ error: string }` envelope if present, then raw text, otherwise the fallback) |
| `ApiError`                                      | The single error type thrown by `apiRequest`/`apiBlobRequest`/`readEnvelope`; carries `.status` so UI can branch (403, 404, …) |
| `isAbortError(err)`                             | True for an aborted fetch (user cancellation / superseded request) — the uniform replacement for `(err as Error).name === 'AbortError'` |

---

## Cookbook

### Define a schema + derive a type

```ts
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const FooSchema = Type.Object({
  id:        Type.String(),
  count:     Type.Number({ minimum: 0 }),
  optional:  Type.Optional(Type.String()),
  tags:      Type.Array(Type.String()),
})

export type Foo = Static<typeof FooSchema>
//   id: string
//   count: number
//   optional?: string
//   tags: string[]
```

**Never** write `interface Foo` next to `FooSchema`. The schema is the source of truth. If the type drifts from the schema, the schema wins.

### Use compiled validators for hot repeated checks

TypeBox's `Value.Check` / `Value.Decode` / `Value.Errors` interpret the schema each time. Repeated API response parsing, data-row-heavy screens, import validation, plugin protocol payloads, and other hot paths should use the compiled helpers. Compilation is cached by schema object identity, so define reusable schemas at module scope.

```ts
import { compiledCheck, compiledDecode } from '@core/utils/typeboxCompiler'

if (!compiledCheck(DataRowSchema, raw)) {
  throw new Error('Invalid data row')
}
const row = compiledDecode(DataRowSchema, raw)
```

Do **not** replace `parseValue` just because a path is repeated. `parseValue` intentionally uses TypeBox's full `Value.Parse` pipeline: clone, clean, defaults, conversion, assertion, and decode. Keep it where callers depend on defaulting/conversion/cleaning, or replace it only after adding tests that prove those semantics are no longer needed.

### Validate a request body (server handler)

```ts
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../http'

const CreatePostSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body:  Type.String(),
})

const body = await readValidatedBody(req, CreatePostSchema)
if (!body) return badRequest('Invalid request body')
// body is typed; proceed.
```

### Validate an HTTP response (client)

```ts
import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'

const PostsResponseSchema = Type.Object({
  rows: Type.Array(PostSchema),
})

// Canonical client call: sets credentials, validates the body, throws ApiError.
const data = await apiRequest('/admin/api/cms/posts', { schema: PostsResponseSchema })
// data.rows is typed

// Code that already holds a Response (e.g. the persistence layer, which injects
// its own fetch) validates with readEnvelope instead:
//   const data = await readEnvelope(res, PostsResponseSchema, 'Failed to load posts')
```

### Validate persisted JSON (localStorage / DB JSON column)

```ts
import { safeParseJson, parseJsonWithFallback } from '@core/utils/jsonValidate'

// Hard: corruption is an error
const result = safeParseJson(localStorage.getItem('mustBeValid') ?? '', Schema)
if (!result.ok) {
  console.error('[prefs] corrupted store:', result.error)
  throw result.error
}
const data = result.value

// Soft: corruption falls back to defaults
const prefs = parseJsonWithFallback(
  localStorage.getItem('editorPrefs') ?? '',
  EditorPreferencesSchema,
  DEFAULT_PREFERENCES,
)
```

### Tolerant array — drop bad entries, keep the rest

```ts
import { Type, filterArray } from '@core/utils/typeboxHelpers'

const FontEntrySchema = Type.Object({ family: Type.String(), url: Type.String() })

// Site document with 5 fonts; one entry has a missing url.
// filterArray keeps the 4 good ones rather than failing the whole document.
const fonts = filterArray(FontEntrySchema, rawSite.fonts)
```

### Default for a missing field — `withFallback`

```ts
import { Type, withFallback } from '@core/utils/typeboxHelpers'

const SiteSettingsSchema = Type.Object({
  theme:       withFallback(Type.String(), 'dark'),
  breakpoints: withFallback(Type.Array(BreakpointSchema), DEFAULT_BREAKPOINTS),
})
```

The annotation is read by parsers like `parseWithFallbackAnnotation` to fill in missing values during a tolerant parse.

### Server error envelope

Every CMS handler error returns `{ error: string }`. `apiRequest` reads it automatically (via `responseErrorMessage`) and throws an `ApiError` carrying the HTTP status — so callers branch on the error type instead of re-checking `res.ok`:

```ts
import { apiRequest, ApiError } from '@core/http'

try {
  const site = await apiRequest('/admin/api/cms/site', {
    schema: SiteEnvelopeSchema,
    fallbackMessage: 'Failed to load site',
  })
} catch (err) {
  if (err instanceof ApiError && err.status === 403) {
    // render "no access" state
  }
  throw err
}
```

`apiRequest` is the default for browser→server calls. `readEnvelope` is the equivalent for code that already holds a `Response`.

### Throwing a typed error

For UI states that need to distinguish causes (e.g. "invalid page slug" vs. "duplicate slug"), use a typed subclass with a `path` field:

```ts
export class SiteValidationError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`[persistence/validate] ${path}: ${message}`)
    this.name = 'SiteValidationError'
    this.path = path
  }
}
```

`path` is a dot-separated string identifying the field (`'site.pages[0].slug'`). The `[persistence/validate]` prefix is injected in the constructor — callers pass just the path. Already-existing typed errors in the codebase: `SiteValidationError`, `VisualComponentNameError`, `VisualComponentParamNameError`, `VisualComponentRecursionError`. Add one when the UI needs to render a specific error state.

---

## Migrating from Zod

The codebase migrated off Zod. If you encounter a remaining Zod pattern, translate it:

| Zod                                                   | TypeBox                                                            |
|-------------------------------------------------------|--------------------------------------------------------------------|
| `z.infer<typeof X>`                                   | `Static<typeof X>`                                                  |
| `X.parse(v)` (strict)                                 | `parseValue(X, v)` or `Value.Parse(X, v)`                          |
| `X.safeParse(v)`                                      | `safeParseValue(X, v)` or `compiledCheck(X, v)` for boolean-only hot paths |
| `X.catch(default)` (soft fallback)                    | `withFallback(X, default)`                                          |
| `z.array(z.unknown()).transform(filter)`              | `filterArray(itemSchema, values)`                                   |
| `.transform()` / `.preprocess()` (data migration)     | Sibling parser helper functions (e.g. `parsePageNode`, `parseSitePage`) |
| `.refine()` (cross-field invariants)                  | Named guard functions called after compiled schema validation       |

There are no Zod exemptions. Provider drivers call REST/SSE APIs directly and pass TypeBox schemas through as JSON Schema for tool inputs. Gated by an import scan.

---

## Where validators are wired in the codebase

Common boundaries already wrapped — extend the same pattern when you add a new one:

| Boundary                                   | Helper                                              | Lives in                                |
|--------------------------------------------|-----------------------------------------------------|-----------------------------------------|
| HTTP request (client, canonical JSON)      | `apiRequest(path, { schema, … })`                   | `src/core/http/apiClient.ts`            |
| HTTP request (client, binary body)         | `apiBlobRequest(path, { signal, … })`               | `src/core/http/apiClient.ts`            |
| HTTP response from a held `Response`        | `readEnvelope(res, Schema, fallback)`               | `src/core/http/apiClient.ts`            |
| HTTP body-validation primitive (no status semantics; `@core/http` internals, XHR, server-side external APIs) | `parseJsonResponse(res, Schema)` | `src/core/utils/jsonValidate.ts` |
| Request body (server handler)              | `readValidatedBody(req, Schema)` → typed value or `null` (return `badRequest` on null) | `server/http.ts` + per-handler |
| `JSON.parse` of localStorage               | `parseJsonWithFallback(raw, Schema, default)`       | `src/core/utils/jsonValidate.ts`        |
| `JSON.parse` of disk JSON                  | `safeParseJson(raw, Schema)`                        | `src/core/utils/jsonValidate.ts`        |
| Plugin manifest                            | `parsePluginManifest(raw)`                          | `src/core/plugins/manifest.ts`          |
| Site shell loaded from storage             | `validateSite(raw)`                                 | `src/core/persistence/validate.ts`      |
| Page roster on load (fault-tolerant)       | `validatePages(shell, rawPages, vcs, { tolerant: true, storedVcIds })` | `src/core/persistence/validate.ts` |
| Page roster on write (fail-closed)         | `validatePages(shell, rawPages, vcs)` (default: `tolerant: false`)     | `src/core/persistence/validate.ts` |
| VC roster loaded from storage (read path)  | `validateVisualComponents(rawVCs)`                  | `src/core/persistence/validate.ts`      |
| VC roster on write (fail-closed)           | `validateVisualComponentsForWrite(rawVCs)`          | `src/core/persistence/validate.ts`      |
| Page-tree payload from plugin RPC / disk   | `parsePageNodeTree(raw)`                            | `src/core/page-tree/operationSchema.ts` |
| DB settings JSON — partial read (handler side) | `safeParseValue(NarrowSchema, row.settings_json)` where `NarrowSchema` covers only the fields the handler needs. TypeBox objects allow extra properties by default, so unrelated settings fields (with their own required sub-schemas) don't block a valid read. Falls back to `null` on failure. | `server/handlers/cms/setup.ts` (`StoredSiteIdentitySchema`) |
| AI chat snapshot (optional HTTP body field) | `safeParseValue(SiteAgentSnapshotSchema, snapshot)` — falls back to an empty placeholder on failure; never crashes the stream | `server/ai/handlers/chat.ts` |
| AI tool handler raw output                 | `safeParseValue(AiToolOutputSchema, result)` — wraps non-envelope values as `{ ok: true, data }`; prevents duck-typed truthy-but-non-boolean `ok` fields reaching the driver | `server/ai/drivers/http/execTool.ts` |
| SSE frame — plugin lifecycle events (client) | `safeParseValue(PluginEventSchema, JSON.parse(frame.data))` — malformed frames are dropped with `console.warn`; well-formed frames are dispatched to subscribers | `src/admin/pages/plugins/utils/pluginEventStream.ts` |
| DB JSON columns (after auto-parse)         | Per-repository TypeBox schema                       | `server/repositories/*.ts`              |
| Response schemas (shared)                  | `responseSchemas.ts`                                | `src/core/persistence/responseSchemas.ts`|

---

## Forbidden patterns

| Pattern                                                       | Use instead                                                     |
|---------------------------------------------------------------|-----------------------------------------------------------------|
| `await res.json() as Foo`                                     | `apiRequest(path, { schema })` (client) or `readEnvelope(res, FooSchema, msg)` (held `Response`) — `parseJsonResponse` only for `@core/http` internals / XHR / server-side |
| `body.field as DeepType` after `readEnvelope` / `parseJsonResponse` | Reference `DeepType`'s TypeBox schema in the envelope (e.g. `{ font: FontEntrySchema }`); the parsed value is already correctly typed — no cast needed. For interface-only deep types without a schema, add a `§5.x` allowlist entry in `boundary-validation.test.ts`. |
| `JSON.parse(raw) as Foo`                                      | `safeParseJson(raw, FooSchema)` / `parseJsonWithFallback`       |
| Hand-rolled `interface Foo` next to a `FooSchema`             | `type Foo = Static<typeof FooSchema>`                            |
| Importing `zod` anywhere                                      | TypeBox everywhere — `zod` is banned repo-wide and has been removed from `package.json`. Gated by `ai-driver-isolation.test.ts`. |
| `try { JSON.parse(raw) } catch (err) { /* swallow */ }`       | `parseJsonWithFallback` for soft, `safeParseJson` for hard       |
| `if (typeof body.email !== 'string') return badRequest(...)` (ad-hoc shape check) | TypeBox schema + `parseValue`                       |
| Re-wrapping `Error` in a way that loses the original cause    | `new Error(message, { cause: err })`                             |
| Silently catching errors (`catch (err) {}`)                   | Name the binding `catch (_err)` and add a one-line comment, or handle the error |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview (TypeBox at every boundary)
- [docs/server.md](../server.md) — server validation patterns
- [docs/editor.md](../editor.md) — editor store + persistence
- Source-of-truth files:
  - `src/core/utils/typeboxHelpers.ts` — helper layer (`parseValue`, `withFallback`, `filterArray`, etc.)
  - `src/core/utils/typeboxCompiler.ts` — cached TypeCompiler layer for hot validation execution
  - `src/core/utils/jsonValidate.ts` — JSON boundary helpers
  - `src/core/http/apiClient.ts` — `apiRequest`, `apiBlobRequest`, `ApiError`, `isAbortError`, `readEnvelope`, `assertOk`, `responseErrorMessage`, `ErrorEnvelopeSchema`
  - `src/core/persistence/responseSchemas.ts` — shared CMS HTTP response schemas
  - `src/core/persistence/validate.ts` — `validateSite`, `validatePages`, `ValidatePagesOptions`, `SiteValidationError`
  - `src/core/plugins/manifest.ts` — `parsePluginManifest`
  - `server/http.ts` — `readValidatedBody`, `jsonResponse`, `badRequest`
  - `server/ai/drivers/` — direct provider HTTP drivers; tools are declared with their TypeBox `inputSchema` passed through as JSON Schema (no Zod)
- Gate tests:
  - `src/__tests__/architecture/boundary-validation.test.ts` — enforces five boundary rules: (1) no `res.json() as` in persistence or admin; (2) no `JSON.parse as` in persistence; (3) no raw `fetch(` in admin; (4) no raw `req.json(` in server handlers; (5) no `body.field as DeepType` after `readEnvelope`/`parseJsonResponse` in persistence — embed the field's TypeBox schema in the envelope instead; allowlist interface-only deep types with `§5.x`
  - `src/__tests__/architecture/ai-driver-isolation.test.ts` — enforces provider-SDK and `zod` isolation: `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@openrouter/agent`, and `zod` are banned repo-wide; `@modelcontextprotocol/sdk` is scoped to `server/ai/mcp/` only

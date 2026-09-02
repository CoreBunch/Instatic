# Directus reader

Server-side, **GET-only** reads of geography and workfields from the install's Directus instance. The content service stays the default for published workfield display; this layer covers the three things that service cannot answer: the climb above a municipality, every translation in one call, and draft pricing / demand / blog / FAQ rows.

Nothing here writes. Authoring stays in Directus.

## TL;DR

- Env: `MKP_CONTENT_SERVICE_DIRECTUS_URL` + `MKP_CONTENT_SERVICE_DIRECTUS_TOKEN` (reader token — names only, never values in this repo).
- HTTP: `GET /admin/api/cms/directus/*`, session + `directus.read`.
- MCP: seven `directus_*` tools, `mutates: false`, same capability. Default-on in the token **Read** group.
- The Directus token never reaches a browser. Callers authenticate with a session or MCP grant; Trustup WM proxies the read.
- Allow-listed collections only. Unknown collection names are rejected, not forwarded.
- Responses cached in-process for 60s. `count` uses Directus `filter_count`, never `total_count`.
- Upstream bodies are validated with TypeBox (`ItemsEnvelopeSchema` in `client.ts`). A non-JSON success body is a 502.

## Why this exists

| Need | Why the content service cannot serve it |
|---|---|
| Province / region / country **above** a municipality | `/resolve` stops at municipality / locality |
| **Every** translation of a name in one call | Reads are one-locale-at-a-time |
| **Draft** pricing / demand / blog / FAQ rows | It filters to `published` by design |

## Upstream contract

The reader token can read exactly these collections (verified live against DEV, 2026-09-02). The allow-list in [`server/directus/collections.ts`](../../server/directus/collections.ts) is this list and nothing else; a name outside it is refused before any request goes out.

| Collection | Identity | Notes |
|---|---|---|
| `countries` | `code` (`BE`, `FR`) | **No `id`, no `slug` column.** Filtering on `slug` is a Directus 403. The flattened row uses the code as both `id` and `slug`. |
| `regions` · `provinces` · `municipalities` · `localities` | uuid `id` + `slug` | `country` is the ISO code; `region` / `province` / `municipality` are parent uuids. |
| `workfield_content` | uuid `id` + `slug` | **No `status` column.** The published set is `is_deleted = false AND is_shadow = false` (468 of 473). `average_rating` is an integer ×100. Translations carry the 16 declensions and `localised_slugs`, a comma-separated history whose **last** entry is the marketplace URL segment. |
| `workfield_pricing_items` · `workfield_example_demands` · `workfield_blog_content` | uuid `id` | Flat per-locale rows keyed by `workfield_content_id` + `languages_code`, each with its own `status`. |
| `workfield_faq_content` | uuid `id` | `type` `generic` \| `location_specific`, `geography_type`, `geography_id`, `status`; translations carry `intro_text` + `qa_text`. |

`status` on the detail and FAQ routes filters **those sub-rows**, never the workfield itself. That is what "draft rows" means here.

## Routes

| Method | Path | MCP tool |
|---|---|---|
| GET | `/admin/api/cms/directus/health` | `directus_health` |
| GET | `/admin/api/cms/directus/strengths` | `directus_list_strengths` |
| GET | `/admin/api/cms/directus/geography/:level` | `directus_list_geography` |
| GET | `/admin/api/cms/directus/geography-ancestry` | `directus_get_geography_ancestry` |
| GET | `/admin/api/cms/directus/workfields` | `directus_list_workfields` |
| GET | `/admin/api/cms/directus/workfields/:slug` | `directus_get_workfield` |
| GET | `/admin/api/cms/directus/workfields/:slug/faq` | `directus_get_workfield_faq` |

`:level` ∈ `countries` · `regions` · `provinces` · `municipalities` · `localities`. Always page `municipalities` (35 311 rows on DEV).

`include=faq` on the detail route returns **generic** FAQ only; a popular trade carries one `location_specific` row per municipality (`roofer` has 128). Name a geography on the FAQ route for those. Includes are fetched concurrently and scoped to the requested locale unless `all_locales` is set.

Live parity with the content service and the Python WM report (2026-09-02, on-VPN): 468 published workfields (topic 219, service 77, product 72, category 57, trade 25, material 18); 2 countries, 16 regions, 107 provinces, 35 311 municipalities, 2 242 localities.

## Strengths ("troeven")

A **fixed, server-owned catalog** of 20 strengths from intake screen 21, in [`server/directus/strengths.ts`](../../server/directus/strengths.ts). It is static data — no Directus round-trip — so the route and the MCP tool answer even when the reader is unconfigured (200, not 503).

Intake stores **3–6 ids** on `contentFacts.strengths`. Each row carries an `id`, an `icon` name, and a `names` map covering all 8 supported locales. **Never author the words on the site** — render the locale label from this catalog so the copy stays consistent and translatable.

| Param | Meaning |
|---|---|
| `locale` | Resolve one supported locale into a flat `name` (in addition to `names`). Unknown locale → 400. |
| `ids` | Comma-separated (HTTP) / array (MCP) subset, returned in catalog order. Unknown id → 400. |

Ids: `owner-on-site` · `respect-deadlines` · `careful-work` · `free-quote` · `clean-sites` · `availability` · `ten-year-guarantee` · `vca-certified` · `ten-years-plus` · `family-business` · `custom-work` · `quality-materials` · `personal-advice` · `transparent-prices` · `fast-response` · `respect-budget` · `professional-team` · `local-sites` · `satisfaction-guaranteed` · `after-sales`.

Labels are authored in the four BE locales; the shared translation fallback expands them to all 8 (`nl-NL` → `nl-BE`, `fr-FR` → `fr-BE`, and so on).

## Locales

`?locale=` accepts exactly the 8 supported locales — `fr-BE`, `nl-BE`, `de-BE`, `en-BE`, `fr-FR`, `en-FR`, `nl-NL`, `en-NL` — and anything else is a 400. The list is `SUPPORTED_LOCALES` in `src/core/locales.ts`, the single locale catalog the reader and the MCP tool enums share; `locale-enum-usage.test.ts` gates every other locale surface against it. `?all_locales=true` returns a `names` map that always carries all 8 keys.

Fallback, in order: exact locale → same language other region (`nl-NL` → `nl-BE`) → country default (BE→`fr-BE`, FR→`fr-FR`) → any `fr-*` → first available. That is why `paris` resolves in `fr-BE` instead of a row of nulls.

Belgian rows have four real names; French rows often have one. Both expand to eight keys.

## Errors

| Situation | Status |
|---|---|
| No / bad session | 401 |
| Missing `directus.read` | 403 |
| Unknown workfield or municipality | 404 |
| Unknown geography level / bad uuid / control characters | 400 |
| Directus rejects the query (4xx other than 401/403) | 400 |
| Directus or a gateway in front of it rejects the **reader token** (401/403) | 502 |
| Directus down, 5xx, or a non-JSON success body | 502 |
| Not configured | 503 |

Uuid and control-character guards are not decoration: Directus passes query values to Postgres, which errors on a NUL byte.

### Upstream 401/403 is a 502, not a 400

An upstream 401/403 is never the caller's fault, so it must not be reported as a bad query. The client tells the two causes apart by the body:

| Upstream body | Meaning | Message prefix |
|---|---|---|
| JSON `{ errors: [{ message }] }` | Directus evaluated the token and refused | `Directus denied the reader token (…)` |
| Anything else (typically `text/plain`) | The ingress in front of Directus stopped the request; the token was never evaluated | `A gateway in front of Directus refused the request (…)` |

`GET /server/ping` is public in Directus. If **it** answers 403 without an `Authorization` header, the block is at the ingress, not in the token policy.

On the Trustup DEV/ACC environments that ingress is Azure Container Apps IP restrictions (`exposure: private` in the infra `env.yaml`, enforced since 2026-08-10). Its literal answer is `403 text/plain` `RBAC: access denied`, and it admits only the non-prod VPN egress plus the spoke's own NAT egress. So a laptop or a CI runner off the VPN gets this on every path, including Directus's public `/server/ping`, with any token or none. The remedy is to connect the `trustup-nonprd` VPN (or run on an allow-listed egress); rotating the reader token changes nothing.

### Health is honest

`directus_health` / `GET …/health` returns `reachable: true` only when Directus itself answered `/server/health`. Any denial is `reachable: false` with `status` and a `reason` string in the same terms as above. The old behavior counted a 403 as healthy, which hid a blocked gateway behind a green probe.

The flag is named `reachable`, not `ok`, on purpose. Server-executed MCP tools return a raw payload and `normaliseToolOutput` reads any `{ ok: boolean }` as the `AiToolOutput` envelope itself, so a domain payload with `ok: false` would surface to the MCP client as a bare `Tool failed.` with the `status`, `url`, and `reason` discarded.

## Read-only invariant

- [`server/directus/client.ts`](../../server/directus/client.ts) has no method parameter. It only GET.
- The CMS route table registers GET only. POST is 405.
- MCP tools do not set `mutates: true`.
- Gate: [`src/__tests__/architecture/directus-read-only.test.ts`](../../src/__tests__/architecture/directus-read-only.test.ts).

## Module layout

| Path | Role |
|---|---|
| `server/config.ts` | `readDirectusConfig()` |
| `server/directus/` | Client, locale fallback, flatteners, service |
| `server/handlers/cms/directus.ts` | HTTP routes |
| `server/ai/mcp/tools/directusTools.ts` | MCP tools |
| `src/core/persistence/cmsDirectus.ts` | Browser client for the proxy (currently: the workfield list) |

## Admin consumers

The admin reads this proxy in one place today: **media workfield tags**. `useDirectusWorkfields(locale)` loads the workfield list per locale (cached per tab) so an image can be labelled with workfield **slugs**; the localized label is resolved at display time from here. See [Media](media.md) → "Workfield tags".

`directus` is an install-wide CMS path segment, so it is exempt from the `/admin/api/cms/sites/<id>/…` site-scoped rewrite on both the client (`src/core/sites/activeSite.ts`) and the server (`server/handlers/cms/index.ts`).

## Related

- [Capabilities](../reference/capabilities.md) — `directus.read`
- [Media](media.md) — workfield tagging on media assets
- [MCP connections](mcp-connectors.md) — token picker Read group

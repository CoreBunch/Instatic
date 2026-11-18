/**
 * The manifest's `frontend` block: the tags a plugin has the host inject into
 * published pages (`assets`) and the third-party origins those pages may load
 * scripts and frames from (`origins`).
 *
 * Split out of `manifest.ts` (which owns the rest of manifest parsing): the
 * schema, its coherence rules and the origin-matching helpers are one
 * responsibility, shared by the parser, the publisher's injection pipeline and
 * the lint CLI.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { PluginManifest } from '@core/plugin-sdk'
import { SAFE_ASSET_PATH_PATTERN } from './manifestPatterns'

// A third-party origin a plugin's published-page code may load scripts or
// frames from (`frontend.origins`). Same host grammar as
// `networkAllowedHosts`, but stricter where a browser policy is at stake: the
// name must have a registrable-looking shape (at least two labels, three with
// a leading `*.`), so neither `*.com` nor a bare `localhost` can be allowed,
// and the last label must be alphabetic, which rules out IPv4 literals. There
// is no scheme, port, path or keyword to write: the host always emits
// `https://<host>`.
const FRONTEND_ORIGIN_HOST_PATTERN =
  /^(?:\*\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.))(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z]{2,}$/

// An absolute script address on a declared `frontend.origins.scripts` host.
// https only, a plain hostname (no credentials, port or IP literal), and a
// path made of URL-safe characters; a query string is allowed, a fragment is
// not.
const EXTERNAL_SCRIPT_URL_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*)?(?:\?[a-zA-Z0-9._~!$&'()*+,;=:@%/?-]*)?$/

// Names that are not one site's to give away. The grammar above cannot tell
// `*.example.com` from `*.co.uk`, and vendoring the Public Suffix List for a
// consent-screen field is out of proportion, so two cheap rules cover the
// cases that matter:
//
//   1. Private-network and unroutable top-level names are not public hosts.
//      (`.example` and `.test` stay allowed: documentation and tests use them.)
//   2. A wildcard must sit under a name one party controls. A listed
//      country-code suffix (`co.uk`, `com.au`) or a well-known shared-hosting
//      domain (`github.io`, `vercel.app`) hands `script-src` to anyone who can
//      register a subdomain there. Name the exact host instead.
//
// The list is a floor, not a guarantee: the install review still shows every
// wildcard with a warning, because that is where a person decides.
const NON_PUBLIC_TOP_LEVEL_LABELS = new Set([
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home',
  'corp', 'invalid', 'onion',
])

// Country-code public suffixes, spelled out. A heuristic ("a common label
// under any two-letter code") also catches ordinary registered names such as
// `ac.me` and `co.de`, so only suffixes known to be registries' are listed.
const COUNTRY_PUBLIC_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'com.au', 'edu.au', 'gov.au', 'net.au', 'org.au',
  'ac.nz', 'co.nz', 'govt.nz', 'net.nz', 'org.nz',
  'ac.jp', 'co.jp', 'go.jp', 'ne.jp', 'or.jp',
  'com.br', 'gov.br', 'net.br', 'org.br',
  'com.cn', 'gov.cn', 'net.cn', 'org.cn',
  'ac.in', 'co.in', 'gov.in', 'net.in', 'org.in',
  'co.za', 'gov.za', 'org.za',
  'co.kr', 'or.kr', 'co.il', 'co.id', 'co.th',
  'com.ar', 'com.hk', 'com.mx', 'com.my', 'com.ph', 'com.pl', 'com.sg',
  'com.tr', 'com.tw', 'com.ua', 'com.vn',
])

// Domains where each subdomain belongs to a different customer. A wildcard
// directly under one is refused; a wildcard under a customer's own name there
// (`*.acme.vercel.app`) is one party's and stays allowed.
const SHARED_HOSTING_SUFFIXES: readonly string[] = [
  'appspot.com', 'azureedge.net', 'azurewebsites.net',
  'blob.core.windows.net', 'cloudfront.net', 'firebaseapp.com', 'fly.dev',
  'github.io', 'githubusercontent.com', 'gitlab.io', 'glitch.me',
  'herokuapp.com', 'netlify.app', 'onrender.com', 'pages.dev', 'r2.dev',
  'surge.sh', 'vercel.app', 'web.app', 'workers.dev',
]

// AWS nests its shared endpoints (`s3.eu-west-1.amazonaws.com`), so a wildcard
// anywhere under it is refused.
const SHARED_HOSTING_TREES: readonly string[] = ['amazonaws.com']

/** Why a syntactically valid `frontend.origins` entry is refused, or `null` when it is fine. */
function frontendOriginRejection(origin: string): string | null {
  const wildcard = origin.startsWith('*.')
  const name = wildcard ? origin.slice(2) : origin
  const labels = name.split('.')
  const topLevel = labels[labels.length - 1]!
  if (NON_PUBLIC_TOP_LEVEL_LABELS.has(topLevel)) {
    return `"${origin}" is not a public host`
  }
  if (COUNTRY_PUBLIC_SUFFIXES.has(name)) {
    return `"${origin}" is a public suffix, not a host`
  }
  const coversSharedHosting =
    SHARED_HOSTING_SUFFIXES.includes(name) ||
    SHARED_HOSTING_TREES.some((tree) => name === tree || name.endsWith(`.${tree}`))
  if (wildcard && coversSharedHosting) {
    return `"${origin}" covers a shared hosting domain where anyone can register a subdomain; name the exact host`
  }
  return null
}

// Inline `<script>` / `<style>` text may hold anything but U+0000. The HTML
// parser replaces a NUL with U+FFFD, so the text a browser runs (and hashes
// for the page policy) would differ from the text declared here.
// eslint-disable-next-line no-control-regex
const INLINE_CONTENT_PATTERN = /^[^\u0000]+$/

const FrontendOriginHostsSchema = Type.Array(
  Type.String({ pattern: FRONTEND_ORIGIN_HOST_PATTERN.source, maxLength: 253 }),
  { maxItems: 20 },
)

// ---------------------------------------------------------------------------
// Frontend assets
// ---------------------------------------------------------------------------

const FrontendAssetPlacementSchema = Type.Union([
  Type.Literal('head'),
  Type.Literal('head-end'),
  Type.Literal('body-start'),
  Type.Literal('body-end'),
])

// HTML attribute name: lowercase letters / digits / dashes / colon / underscore.
// Restricts what plugins can spell so a malformed declaration can't smuggle
// in arbitrary HTML by setting an attribute named `>`. Values are
// HTML-escaped at render time.
const FRONTEND_ATTR_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_:-]*$/

const FrontendAssetAttrsSchema = Type.Record(
  Type.String({ pattern: FRONTEND_ATTR_NAME_PATTERN.source, maxLength: 64 }),
  Type.String({ maxLength: 4096 }),
)

/**
 * Declarative frontend tag list — scripts, styles, meta, link — that the host
 * injects into every published page on behalf of the plugin, plus the
 * third-party origins those pages may use. Validated structurally here; the
 * frontend injection pipeline reads it at publish time and emits the tags.
 * Requires the `frontend.assets` permission (`assertFrontendCoherent`).
 */
export const frontendSchema = Type.Object({
  assets: Type.Array(
    Type.Union([
      Type.Object({
        kind: Type.Literal('script'),
        // A package-relative path, or an absolute https address whose host
        // is declared in `frontend.origins.scripts` (checked below).
        src: Type.Union([
          Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
          Type.String({ pattern: EXTERNAL_SCRIPT_URL_PATTERN.source, maxLength: 2048 }),
        ]),
        placement: Type.Optional(FrontendAssetPlacementSchema),
        strategy: Type.Optional(Type.Union([
          Type.Literal('defer'),
          Type.Literal('async'),
          Type.Literal('module'),
          Type.Literal('sync'),
        ])),
        attrs: Type.Optional(FrontendAssetAttrsSchema),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('script-inline'),
        content: Type.String({ minLength: 1, maxLength: 64 * 1024, pattern: INLINE_CONTENT_PATTERN.source }),
        placement: Type.Optional(FrontendAssetPlacementSchema),
        attrs: Type.Optional(FrontendAssetAttrsSchema),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('style'),
        href: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
        placement: Type.Optional(FrontendAssetPlacementSchema),
        attrs: Type.Optional(FrontendAssetAttrsSchema),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('style-inline'),
        content: Type.String({ minLength: 1, maxLength: 64 * 1024, pattern: INLINE_CONTENT_PATTERN.source }),
        placement: Type.Optional(FrontendAssetPlacementSchema),
        attrs: Type.Optional(FrontendAssetAttrsSchema),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('link'),
        attrs: FrontendAssetAttrsSchema,
        placement: Type.Optional(FrontendAssetPlacementSchema),
      }, { additionalProperties: false }),
      Type.Object({
        kind: Type.Literal('meta'),
        attrs: FrontendAssetAttrsSchema,
        placement: Type.Optional(FrontendAssetPlacementSchema),
      }, { additionalProperties: false }),
    ]),
    { maxItems: 50 },
  ),
  /**
   * Third-party origins this plugin's published-page code may load scripts
   * from (`scripts` → `script-src`) or embed frames from (`frames` →
   * `frame-src`). Shown on the install / upgrade review and granted with
   * the `frontend.assets` permission.
   */
  origins: Type.Optional(Type.Object({
    scripts: Type.Optional(FrontendOriginHostsSchema),
    frames: Type.Optional(FrontendOriginHostsSchema),
  }, { additionalProperties: false })),
})

type FrontendRaw = Static<typeof frontendSchema>

/**
 * Cross-field rules the schema cannot express. Throws an
 * `Invalid plugin manifest: …` error on the first violation.
 */
export function assertFrontendCoherent(frontend: FrontendRaw, permissions: readonly string[]): void {
  const declaredScriptOrigins = frontend.origins?.scripts ?? []
  const declaredFrameOrigins = frontend.origins?.frames ?? []
  if (declaredScriptOrigins.length + declaredFrameOrigins.length > 0) {
    // Origins widen the published page's policy, so they ride the same
    // consent as the tags themselves.
    if (!permissions.includes('frontend.assets')) {
      throw new Error(
        `Invalid plugin manifest: \`frontend.origins\` is declared but the ` +
        `\`frontend.assets\` permission is not requested.`,
      )
    }
    for (const [field, hosts] of [['scripts', declaredScriptOrigins], ['frames', declaredFrameOrigins]] as const) {
      if (new Set(hosts).size !== hosts.length) {
        throw new Error(`Invalid plugin manifest: duplicate entry in \`frontend.origins.${field}\`.`)
      }
      for (const host of hosts) {
        const rejection = frontendOriginRejection(host)
        if (rejection) {
          throw new Error(`Invalid plugin manifest: \`frontend.origins.${field}\` entry ${rejection}.`)
        }
      }
    }
  }
  if (frontend.assets.length > 0) {
    if (!permissions.includes('frontend.assets')) {
      throw new Error(
        `Invalid plugin manifest: \`frontend.assets\` is non-empty but the ` +
        `\`frontend.assets\` permission is not requested.`,
      )
    }
    for (const asset of frontend.assets) {
      if (asset.kind === 'script' && isExternalFrontendScriptSrc(asset.src)) {
        const host = externalFrontendScriptHost(asset.src)
        if (!host || !frontendOriginAllowsHost(declaredScriptOrigins, host)) {
          throw new Error(
            `Invalid plugin manifest: \`frontend.assets\` script "${asset.src}" loads from a host ` +
            `that is not declared in \`frontend.origins.scripts\`.`,
          )
        }
      }
      // `attrs` is allowed to be missing (TypeBox enforces the shape we
      // accept), but `script-inline` / `style-inline` must declare *some*
      // content — schema covers that too.
      if (asset.kind === 'link' && !asset.attrs.rel && !asset.attrs.href) {
        throw new Error(
          `Invalid plugin manifest: \`frontend.assets\` <link> declaration ` +
          `must include at least \`rel\` or \`href\`.`,
        )
      }
      if (asset.kind === 'meta' && !asset.attrs.name && !asset.attrs.property
          && !asset.attrs.charset && !asset.attrs['http-equiv']) {
        throw new Error(
          `Invalid plugin manifest: \`frontend.assets\` <meta> declaration ` +
          `must include \`name\`, \`property\`, \`charset\`, or \`http-equiv\`.`,
        )
      }
    }
  }
}

/**
 * The parsed block as the manifest carries it: fresh arrays, no shared
 * references. The return type is the SDK's hand-written manifest type, and
 * there is no cast: this function compiles only while the schema's static type
 * is assignable to it, which is what keeps the two from drifting.
 */
export function frontendDeclarations(frontend: FrontendRaw): PluginManifest['frontend'] {
  const origins = frontend.origins
  return {
    assets: frontend.assets.map((asset) => ({ ...asset })),
    ...(origins
      ? {
          origins: {
            ...(origins.scripts ? { scripts: [...origins.scripts] } : {}),
            ...(origins.frames ? { frames: [...origins.frames] } : {}),
          },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// frontend.origins helpers — shared by the parser, the publisher and the lint CLI
// ---------------------------------------------------------------------------

/** Whether a `frontend.assets[]` script `src` is an absolute address rather than a package path. */
export function isExternalFrontendScriptSrc(src: string): boolean {
  return src.startsWith('https://')
}

/** The lowercase hostname of an absolute script address, or `null` when it cannot be read. */
export function externalFrontendScriptHost(src: string): string | null {
  const match = /^https:\/\/([a-z0-9.-]+)(?:[/?]|$)/.exec(src)
  return match ? match[1]! : null
}

/**
 * Whether `host` is covered by a `frontend.origins` list. An entry matches its
 * own name exactly; a leading `*.` matches any subdomain depth, as the same
 * source expression does in a browser's policy, but never the bare domain.
 */
export function frontendOriginAllowsHost(origins: readonly string[], host: string): boolean {
  return origins.some((origin) =>
    origin.startsWith('*.') ? host.endsWith(origin.slice(1)) && host.length > origin.length - 1 : origin === host,
  )
}

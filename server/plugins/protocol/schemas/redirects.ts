/**
 * TypeBox schemas for `cms.redirects.*` api-call arguments. These check the
 * shape and apply a safety ceiling on payload size only. Every redirect rule
 * — path/location syntax, reserved prefixes, header-injection characters,
 * `to` required unless 410, the 2048-character length limit, and the
 * 5000-rules-per-plugin cap — is validated by
 * `server/repositories/pluginRedirects.ts`, the single source of truth. The
 * ceilings sit well above those limits so an over-limit rule still reaches
 * the repository and the plugin gets a `fromPath:` / `toLocation:` /
 * `limit:` error instead of a generic schema error.
 */

import { Type } from '@sinclair/typebox'

const REDIRECT_STRING_CEILING = 8192
const REDIRECTS_ITEMS_CEILING = 10000

const RedirectStringSchema = Type.String({ maxLength: REDIRECT_STRING_CEILING })

const RedirectStatusSchema = Type.Union([
  Type.Literal(301),
  Type.Literal(302),
  Type.Literal(307),
  Type.Literal(308),
  Type.Literal(410),
])

const RedirectRuleInputSchema = Type.Object(
  {
    from: RedirectStringSchema,
    to: Type.Optional(Type.Union([RedirectStringSchema, Type.Null()])),
    status: RedirectStatusSchema,
  },
  { additionalProperties: false },
)

export const RedirectsListArgsSchema = Type.Tuple([])

export const RedirectsSetArgsSchema = Type.Tuple([RedirectRuleInputSchema])

export const RedirectsDeleteArgsSchema = Type.Tuple([RedirectStringSchema])

export const RedirectsReplaceAllArgsSchema = Type.Tuple([
  Type.Array(RedirectRuleInputSchema, { maxItems: REDIRECTS_ITEMS_CEILING }),
])

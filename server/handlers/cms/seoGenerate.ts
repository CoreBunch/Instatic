/**
 * AI metadata suggestions — `POST /admin/api/cms/seo/generate`.
 *
 * One driver call, three suggestions. Rides the existing `server/ai` stack:
 * the scope default ('content', falling back to 'site') picks the provider
 * credential + model; the call runs tool-less with a no-op bridge and the
 * response text is parsed as a JSON string array.
 *
 * Capabilities: `seo.manage` (it feeds the SEO editor) plus `ai.chat`
 * (it spends provider tokens). Length budgets ride the prompt so the
 * suggestions fit the editor's meters without truncation.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import { readBodyCell, readSeoCell, readTitleCell } from '@core/data/cells'
import type { DbClient } from '../../db/client'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireCapability, userHasCapability } from '../../auth/authz'
import { getDataRow } from '../../repositories/data'
import { getDraftSite } from '../../repositories/site'
import { listDefaults } from '../../ai/defaults/store'
import {
  readCredentialForUser,
  resolveCredentialForDriver,
} from '../../ai/credentials/store'
import { resolveDriver } from '../../ai/drivers'
import type { AiBrowserBridge } from '../../ai/runtime/types'

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

const GENERATABLE_FIELDS = [
  'title',
  'description',
  'ogTitle',
  'ogDescription',
  'xTitle',
  'xDescription',
] as const

const GenerateBodySchema = Type.Object({
  kind: Type.Union([Type.Literal('page'), Type.Literal('template'), Type.Literal('post')]),
  id: Type.String({ minLength: 1 }),
  field: Type.Union(GENERATABLE_FIELDS.map((field) => Type.Literal(field))),
  exclude: Type.Optional(Type.Array(Type.String())),
})

type GenerateBody = Static<typeof GenerateBodySchema>

const SuggestionsSchema = Type.Array(Type.String(), { minItems: 1 })

const SUGGESTION_COUNT = 3

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const FIELD_SPECS: Record<GenerateBody['field'], { label: string; budget: string }> = {
  title: { label: 'SEO title', budget: 'at most 60 characters (~580px in search results)' },
  description: { label: 'meta description', budget: 'at most 160 characters (~990px in search results)' },
  ogTitle: { label: 'Open Graph title', budget: 'at most 60 characters' },
  ogDescription: { label: 'Open Graph description', budget: 'at most 160 characters' },
  xTitle: { label: 'X card title', budget: 'at most 60 characters' },
  xDescription: { label: 'X card description', budget: 'at most 160 characters' },
}

const SYSTEM_PROMPT = [
  'You are an expert SEO copywriter inside a CMS.',
  `Respond with ONLY a JSON array of exactly ${SUGGESTION_COUNT} strings — no prose, no markdown fences, no keys.`,
  'Each string is one complete suggestion. Vary the angle across suggestions (benefit-led, descriptive, curiosity).',
  'Never stuff keywords; write for humans first. Match the language of the source content.',
].join(' ')

interface SuggestionContext {
  field: GenerateBody['field']
  pageTitle: string
  bodyExcerpt: string
  existingValue: string | undefined
  siteName: string
  siteDescription: string | undefined
  exclude: string[]
}

function buildUserPrompt(ctx: SuggestionContext): string {
  const spec = FIELD_SPECS[ctx.field]
  const lines = [
    `Write ${SUGGESTION_COUNT} ${spec.label} suggestions for the content below. Each must be ${spec.budget}.`,
    '',
    `Site: ${ctx.siteName}`,
    ...(ctx.siteDescription ? [`Site description: ${ctx.siteDescription}`] : []),
    `Content title: ${ctx.pageTitle}`,
    ...(ctx.existingValue ? [`Current ${spec.label}: ${ctx.existingValue}`] : []),
    ...(ctx.bodyExcerpt ? ['', 'Content excerpt:', ctx.bodyExcerpt] : []),
  ]
  if (ctx.exclude.length > 0) {
    lines.push('', 'Do NOT repeat any of these already-shown suggestions:')
    for (const item of ctx.exclude) lines.push(`- ${item}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Response parsing — tolerant of stray prose around the JSON array
// ---------------------------------------------------------------------------

export function parseSuggestionsText(text: string): string[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  const parsed = safeParseJson(text.slice(start, end + 1), SuggestionsSchema)
  if (!parsed.ok) return null
  const unique = [...new Set(parsed.value.map((item) => item.trim()).filter((item) => item !== ''))]
  return unique.length > 0 ? unique.slice(0, SUGGESTION_COUNT) : null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Bridge for tool-less calls — never invoked because `tools` is empty. */
const NOOP_BRIDGE: AiBrowserBridge = {
  callBrowser: () => Promise.reject(new Error('seo/generate runs without tools')),
}

export async function handleSeoGenerate(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'seo.manage')
  if (user instanceof Response) return user
  if (!userHasCapability(user, 'ai.chat')) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await readValidatedBody(req, GenerateBodySchema)
  if (!body) return badRequest('Invalid generate payload')

  const row = await getDataRow(db, body.id)
  if (!row) return jsonResponse({ error: 'Target not found' }, { status: 404 })

  // Provider + model from the scope defaults — content first (SEO copy is
  // content work), site as fallback. No default → actionable 409.
  const defaults = await listDefaults(db)
  const aiDefault =
    defaults.find((record) => record.scope === 'content') ??
    defaults.find((record) => record.scope === 'site')
  if (!aiDefault) {
    return jsonResponse(
      { error: 'No AI provider configured. Set a content or site default in the AI workspace.' },
      { status: 409 },
    )
  }
  const credential = await readCredentialForUser(db, user.id, aiDefault.credentialId)
  if (!credential) {
    return jsonResponse(
      { error: 'The default AI credential is not accessible to your account. Configure one in the AI workspace.' },
      { status: 409 },
    )
  }
  let resolvedCredential
  try {
    resolvedCredential = await resolveCredentialForDriver(credential)
  } catch (err) {
    console.error('[seo-generate] credential resolution failed:', err)
    return jsonResponse({ error: 'AI credential could not be resolved.' }, { status: 409 })
  }

  const site = await getDraftSite(db)
  const prompt = buildUserPrompt({
    field: body.field,
    pageTitle: readTitleCell(row.cells) || row.slug,
    bodyExcerpt: readBodyCell(row.cells).slice(0, 2000),
    existingValue: readSeoCell(row.cells)?.[body.field],
    siteName: site?.name ?? '',
    siteDescription: site?.settings.seo?.description,
    exclude: body.exclude ?? [],
  })

  const driver = resolveDriver(credential.providerId)
  let text = ''
  try {
    const stream = driver.stream({
      systemPrompt: [SYSTEM_PROMPT],
      messages: [{ role: 'user', content: [{ kind: 'text', text: prompt }] }],
      tools: [],
      modelId: aiDefault.modelId,
      modelCapabilities: driver.capabilities(aiDefault.modelId),
      credentials: resolvedCredential,
      signal: req.signal,
      bridge: NOOP_BRIDGE,
      toolContextBase: {
        db,
        userId: user.id,
        capabilities: user.capabilities,
        scope: 'content',
        conversationId: `seo-generate:${row.id}`,
        snapshot: null,
      },
    })
    for await (const event of stream) {
      if (event.type === 'text') text += event.text
      if (event.type === 'error') {
        console.error('[seo-generate] driver error:', event.message)
        return jsonResponse({ error: 'AI generation failed. Try again.' }, { status: 502 })
      }
    }
  } catch (err) {
    console.error('[seo-generate] driver call failed:', err)
    return jsonResponse({ error: 'AI generation failed. Try again.' }, { status: 502 })
  }

  const suggestions = parseSuggestionsText(text)
  if (!suggestions) {
    console.error('[seo-generate] unparsable model output:', text.slice(0, 200))
    return jsonResponse({ error: 'The model returned an unexpected format. Try again.' }, { status: 502 })
  }

  return jsonResponse({ suggestions })
}

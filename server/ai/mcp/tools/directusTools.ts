/**
 * Read-only Directus MCP tools. Never mutate. The Directus token stays
 * on the server; callers authenticate with the connector grant.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { SupportedLocaleSchema, type SupportedLocale } from '@core/locales'
import type { AiTool } from '../../runtime/types'
import {
  GEOGRAPHY_LEVELS,
  STRENGTH_IDS,
  SUB_ROW_STATUSES,
  WORKFIELD_INCLUDES,
  WORKFIELD_TYPES,
  getDirectusService,
  isDirectusError,
  isGeographyLevel,
} from '../../../directus'

function fail(err: unknown): { ok: false; error: string } {
  if (isDirectusError(err)) return { ok: false, error: err.message }
  throw err
}

const LocaleFields = {
  locale: Type.Optional(SupportedLocaleSchema),
  all_locales: Type.Optional(Type.Boolean()),
}

export const directusMcpTools: AiTool[] = [
  {
    name: 'directus_health',
    description:
      'Probe Directus connectivity and configuration. Read-only. Headless.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object({}, { additionalProperties: false }),
    requiredCapabilities: ['directus.read'],
    handler: async () => {
      try {
        return await getDirectusService().health()
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'directus_list_geography',
    description:
      'List one geography level (countries, regions, provinces, municipalities, localities). Always page municipalities. Read-only. Headless.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object(
      {
        level: Type.Union(GEOGRAPHY_LEVELS.map((level) => Type.Literal(level))),
        parent_id: Type.Optional(Type.String()),
        country: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        search: Type.Optional(Type.String()),
        ...LocaleFields,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: ['directus.read'],
    handler: async (input) => {
      const body = input as {
        level: string
        parent_id?: string
        country?: string
        slug?: string
        search?: string
        locale?: SupportedLocale
        all_locales?: boolean
        limit?: number
        page?: number
      }
      if (!isGeographyLevel(body.level)) return { ok: false, error: 'Unknown geography level' }
      try {
        return await getDirectusService().listGeography(body.level, {
          parentId: body.parent_id,
          country: body.country,
          slug: body.slug,
          search: body.search,
          locale: body.locale,
          allLocales: body.all_locales,
          limit: body.limit,
          page: body.page,
        })
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'directus_get_geography_ancestry',
    description:
      'Municipality → province → region → country in one call. The content-service /resolve stop at municipality. Read-only. Headless.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object(
      {
        slug: Type.Optional(Type.String()),
        id: Type.Optional(Type.String()),
        country: Type.Optional(Type.String()),
        ...LocaleFields,
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: ['directus.read'],
    handler: async (input) => {
      const body = input as {
        slug?: string
        id?: string
        country?: string
        locale?: SupportedLocale
        all_locales?: boolean
      }
      try {
        return await getDirectusService().getAncestry({
          slug: body.slug,
          id: body.id,
          country: body.country,
          locale: body.locale,
          allLocales: body.all_locales,
        })
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'directus_list_workfields',
    description:
      'List published workfields (trades, services, products, topics, categories, materials). Read-only. Headless.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object(
      {
        type: Type.Optional(Type.Union(WORKFIELD_TYPES.map((type) => Type.Literal(type)))),
        search: Type.Optional(Type.String()),
        ...LocaleFields,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        page: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: ['directus.read'],
    handler: async (input) => {
      const body = input as {
        type?: (typeof WORKFIELD_TYPES)[number]
        search?: string
        locale?: SupportedLocale
        all_locales?: boolean
        limit?: number
        page?: number
      }
      try {
        return await getDirectusService().listWorkfields({
          type: body.type,
          search: body.search,
          locale: body.locale,
          allLocales: body.all_locales,
          limit: body.limit,
          page: body.page,
        })
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'directus_get_workfield',
    description:
      'One workfield by slug, optionally with pricing, demands, blog, or generic FAQ. status filters those included sub-rows (draft, published, archived), never the workfield itself. all_locales returns every locale including declensions. Read-only. Headless.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object(
      {
        slug: Type.String({ minLength: 1 }),
        status: Type.Optional(Type.Union(SUB_ROW_STATUSES.map((status) => Type.Literal(status)))),
        include: Type.Optional(Type.Array(Type.Union(WORKFIELD_INCLUDES.map((inc) => Type.Literal(inc))))),
        ...LocaleFields,
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: ['directus.read'],
    handler: async (input) => {
      const body = input as {
        slug: string
        status?: (typeof SUB_ROW_STATUSES)[number]
        include?: Array<(typeof WORKFIELD_INCLUDES)[number]>
        locale?: SupportedLocale
        all_locales?: boolean
      }
      try {
        return await getDirectusService().getWorkfield(body.slug, {
          status: body.status,
          include: body.include,
          locale: body.locale,
          allLocales: body.all_locales,
        })
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'directus_get_workfield_faq',
    description:
      'FAQ for a workfield. include=faq on the detail tool is generic only; name a geography here for location_specific rows. Read-only. Headless.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object(
      {
        slug: Type.String({ minLength: 1 }),
        status: Type.Optional(Type.Union(SUB_ROW_STATUSES.map((status) => Type.Literal(status)))),
        type: Type.Optional(Type.Union([Type.Literal('generic'), Type.Literal('location_specific')])),
        geography_type: Type.Optional(Type.Union(GEOGRAPHY_LEVELS.map((level) => Type.Literal(level)))),
        geography_id: Type.Optional(Type.String()),
        locale: Type.Optional(SupportedLocaleSchema),
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: ['directus.read'],
    handler: async (input) => {
      const body = input as {
        slug: string
        status?: (typeof SUB_ROW_STATUSES)[number]
        type?: 'generic' | 'location_specific'
        geography_type?: (typeof GEOGRAPHY_LEVELS)[number]
        geography_id?: string
        locale?: SupportedLocale
      }
      try {
        return {
          data: await getDirectusService().listWorkfieldFaq(body.slug, {
            status: body.status,
            type: body.type,
            geographyType: body.geography_type,
            geographyId: body.geography_id,
            locale: body.locale,
          }),
        }
      } catch (err) {
        return fail(err)
      }
    },
  },
  {
    name: 'directus_list_strengths',
    description:
      'The fixed strengths ("troeven") catalog from intake screen 21. Store 3–6 of these ids on contentFacts.strengths and render the locale label — never author the words on the site. Each row carries an icon name and a names map for all 8 supported locales. Read-only. Headless. Static — works even when Directus is unconfigured.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object(
      {
        locale: Type.Optional(SupportedLocaleSchema),
        ids: Type.Optional(Type.Array(Type.Union(STRENGTH_IDS.map((id) => Type.Literal(id))))),
      },
      { additionalProperties: false },
    ),
    requiredCapabilities: ['directus.read'],
    handler: async (input) => {
      const body = input as { locale?: SupportedLocale; ids?: string[] }
      try {
        return getDirectusService().listStrengths({ locale: body.locale, ids: body.ids })
      } catch (err) {
        return fail(err)
      }
    },
  },
]

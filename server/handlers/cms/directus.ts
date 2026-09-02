/**
 * Read-only Directus proxy. GET only — geography, workfields, FAQ.
 * The Directus token never leaves the server.
 */
import { requireCapability } from '../../auth/authz'
import { jsonResponse } from '../../http'
import {
  getDirectusService,
  isDirectusError,
  parseAncestryQuery,
  parseGeographyListQuery,
  parseStrengthListQuery,
  parseWorkfieldDetailQuery,
  parseWorkfieldFaqQuery,
  parseWorkfieldListQuery,
} from '../../directus'
import type { DbClient } from '../../db/client'
import { CMS_API_PREFIX } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'

const PREFIX = `${CMS_API_PREFIX}/directus`

async function gate(req: Request, db: DbClient) {
  return requireCapability(req, db, 'directus.read')
}

function respondError(err: unknown): Response {
  if (isDirectusError(err)) {
    return jsonResponse({ error: err.message }, { status: err.status })
  }
  console.error('[directus]', err)
  return jsonResponse({ error: 'Directus upstream error' }, { status: 502 })
}

async function handleHealth(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    return jsonResponse(await getDirectusService().health())
  } catch (err) {
    return respondError(err)
  }
}

async function handleGeography(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    const parsed = parseGeographyListQuery(params.level ?? '', new URL(req.url).searchParams)
    const { level, ...query } = parsed
    return jsonResponse(await getDirectusService().listGeography(level, query))
  } catch (err) {
    return respondError(err)
  }
}

async function handleAncestry(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    const query = parseAncestryQuery(new URL(req.url).searchParams)
    return jsonResponse(await getDirectusService().getAncestry(query))
  } catch (err) {
    return respondError(err)
  }
}

async function handleWorkfields(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    const query = parseWorkfieldListQuery(new URL(req.url).searchParams)
    return jsonResponse(await getDirectusService().listWorkfields(query))
  } catch (err) {
    return respondError(err)
  }
}

async function handleWorkfield(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    const query = parseWorkfieldDetailQuery(new URL(req.url).searchParams)
    return jsonResponse(await getDirectusService().getWorkfield(params.slug ?? '', query))
  } catch (err) {
    return respondError(err)
  }
}

async function handleWorkfieldFaq(req: Request, db: DbClient, params: RouteParams): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    const query = parseWorkfieldFaqQuery(new URL(req.url).searchParams)
    return jsonResponse({
      data: await getDirectusService().listWorkfieldFaq(params.slug ?? '', query),
    })
  } catch (err) {
    return respondError(err)
  }
}

async function handleStrengths(req: Request, db: DbClient): Promise<Response> {
  const user = await gate(req, db)
  if (user instanceof Response) return user
  try {
    const query = parseStrengthListQuery(new URL(req.url).searchParams)
    return jsonResponse(getDirectusService().listStrengths(query))
  } catch (err) {
    return respondError(err)
  }
}

const ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: `${PREFIX}/health`, handler: handleHealth },
  { method: 'GET', pattern: `${PREFIX}/strengths`, handler: handleStrengths },
  { method: 'GET', pattern: `${PREFIX}/geography-ancestry`, handler: handleAncestry },
  { method: 'GET', pattern: new RegExp(`^${PREFIX}/geography/(?<level>[^/]+)$`), handler: handleGeography },
  { method: 'GET', pattern: new RegExp(`^${PREFIX}/workfields/(?<slug>[^/]+)/faq$`), handler: handleWorkfieldFaq },
  { method: 'GET', pattern: new RegExp(`^${PREFIX}/workfields/(?<slug>[^/]+)$`), handler: handleWorkfield },
  { method: 'GET', pattern: `${PREFIX}/workfields`, handler: handleWorkfields },
]

export async function handleDirectusRoutes(req: Request, db: DbClient): Promise<Response | null> {
  return runRouteTable(req, db, ROUTES)
}

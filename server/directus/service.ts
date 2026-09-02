import { readDirectusConfig, type DirectusConfig } from '../config'
import { createDirectusClient, type DirectusClient, type DirectusFetch } from './client'
import type { GeographyLevel } from './collections'
import { DirectusError, directusNotConfigured } from './errors'
import {
  getGeographyAncestry,
  listGeography,
  parseAncestryQuery,
  parseGeographyListQuery,
  type AncestryQuery,
  type GeographyAncestry,
  type GeographyListQuery,
  type GeographyListResult,
} from './geography'
import {
  listStrengths,
  parseStrengthListQuery,
  type StrengthListQuery,
  type StrengthRow,
} from './strengths'
import {
  getWorkfield,
  listWorkfieldFaq,
  listWorkfields,
  parseWorkfieldDetailQuery,
  parseWorkfieldFaqQuery,
  parseWorkfieldListQuery,
  type WorkfieldDetail,
  type WorkfieldDetailQuery,
  type WorkfieldFaqQuery,
  type WorkfieldFaqRow,
  type WorkfieldListQuery,
  type WorkfieldListResult,
} from './workfields'

export interface DirectusService {
  health(): Promise<{ reachable: boolean; configured: true; status: number; url: string; reason?: string }>
  listGeography(level: GeographyLevel, query: GeographyListQuery): Promise<GeographyListResult>
  getAncestry(query: AncestryQuery): Promise<GeographyAncestry>
  listWorkfields(query: WorkfieldListQuery): Promise<WorkfieldListResult>
  getWorkfield(slug: string, query: WorkfieldDetailQuery): Promise<WorkfieldDetail>
  listWorkfieldFaq(slug: string, query: WorkfieldFaqQuery): Promise<WorkfieldFaqRow[]>
  /** Static catalog — served even when Directus is unconfigured. */
  listStrengths(query: StrengthListQuery): { data: StrengthRow[]; count: number }
}

export function createDirectusService(options: {
  config?: DirectusConfig | null
  fetch?: DirectusFetch
  now?: () => number
  client?: DirectusClient
}): DirectusService {
  const config = options.config === undefined ? readDirectusConfig() : options.config
  const client = options.client ?? createDirectusClient({
    config,
    fetch: options.fetch,
    now: options.now,
  })

  if (!config && !options.client) {
    return {
      async health() { throw directusNotConfigured() },
      async listGeography() { throw directusNotConfigured() },
      async getAncestry() { throw directusNotConfigured() },
      async listWorkfields() { throw directusNotConfigured() },
      async getWorkfield() { throw directusNotConfigured() },
      async listWorkfieldFaq() { throw directusNotConfigured() },
      listStrengths: (query) => listStrengths(query),
    }
  }

  return {
    async health() {
      const probe = await client.getHealth()
      return { reachable: probe.reachable, configured: true, status: probe.status, url: client.url, reason: probe.reason }
    },
    listGeography: (level, query) => listGeography(client, level, query),
    getAncestry: (query) => getGeographyAncestry(client, query),
    listWorkfields: (query) => listWorkfields(client, query),
    getWorkfield: (slug, query) => getWorkfield(client, slug, query),
    listWorkfieldFaq: (slug, query) => listWorkfieldFaq(client, slug, query),
    listStrengths: (query) => listStrengths(query),
  }
}

let serviceOverride: DirectusService | null = null

export function setDirectusServiceForTests(service: DirectusService | null): void {
  serviceOverride = service
}

export function getDirectusService(): DirectusService {
  return serviceOverride ?? createDirectusService({})
}

export function isDirectusError(err: unknown): err is DirectusError {
  return err instanceof DirectusError
}

export {
  parseStrengthListQuery,
  parseAncestryQuery,
  parseGeographyListQuery,
  parseWorkfieldDetailQuery,
  parseWorkfieldFaqQuery,
  parseWorkfieldListQuery,
}

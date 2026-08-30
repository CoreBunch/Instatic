import { Type } from '@core/utils/typeboxHelpers'
import { apiRequest } from '@core/http'
import {
  StagingConnectionResultSchema,
  StagingEnvironmentSchema,
  StagingRefreshResultSchema,
  type SaveStagingEnvironment,
  type StagingEnvironment,
  type StagingRefreshResult,
} from '@core/staging'

const OkSchema = Type.Object({ ok: Type.Literal(true) })
const STAGING_PATH = '/admin/api/cms/staging'

export function getCmsStagingEnvironment(signal?: AbortSignal): Promise<StagingEnvironment> {
  return apiRequest(STAGING_PATH, {
    schema: StagingEnvironmentSchema,
    signal,
    fallbackMessage: 'Failed to load staging configuration',
  })
}

export function saveCmsStagingEnvironment(
  input: SaveStagingEnvironment,
): Promise<StagingEnvironment> {
  return apiRequest(STAGING_PATH, {
    method: 'PUT',
    body: input,
    schema: StagingEnvironmentSchema,
    fallbackMessage: 'Failed to save staging configuration',
  })
}

export async function deleteCmsStagingEnvironment(): Promise<void> {
  await apiRequest(STAGING_PATH, {
    method: 'DELETE',
    schema: OkSchema,
    fallbackMessage: 'Failed to remove staging configuration',
  })
}

export async function testCmsStagingEnvironment(): Promise<string> {
  const result = await apiRequest(`${STAGING_PATH}/test`, {
    method: 'POST',
    schema: StagingConnectionResultSchema,
    fallbackMessage: 'Staging connection test failed',
  })
  return result.origin
}

export function refreshCmsStagingEnvironment(): Promise<StagingRefreshResult> {
  return apiRequest(`${STAGING_PATH}/refresh`, {
    method: 'POST',
    schema: StagingRefreshResultSchema,
    fallbackMessage: 'Staging refresh failed',
  })
}

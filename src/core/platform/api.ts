import { apiRequest } from '@core/http'
import { Type } from '@sinclair/typebox'
import {
  PlatformSessionEnvelopeSchema,
  ProjectEnvelopeSchema,
  ProjectListEnvelopeSchema,
  type CreateProjectInput,
} from './schemas'

export async function getPlatformSession() {
  const payload = await apiRequest('/app/api/session', {
    schema: PlatformSessionEnvelopeSchema,
    fallbackMessage: 'Unable to load your Instatic session',
  })
  return payload.session
}

export async function createPlatformOrganization(name: string) {
  const input = { name }
  const payload = await apiRequest('/app/api/organizations', {
    method: 'POST',
    body: input,
    schema: PlatformSessionEnvelopeSchema,
    fallbackMessage: 'Unable to create the agency',
  })
  return payload.session
}

export async function listPlatformProjects() {
  const payload = await apiRequest('/app/api/projects', {
    schema: ProjectListEnvelopeSchema,
    fallbackMessage: 'Unable to load projects',
  })
  return payload.projects
}

export async function createPlatformProject(input: CreateProjectInput) {
  const payload = await apiRequest('/app/api/projects', {
    method: 'POST',
    body: input,
    schema: ProjectEnvelopeSchema,
    fallbackMessage: 'Unable to create the project',
  })
  return payload.project
}

export async function logoutPlatform(): Promise<string> {
  const payload = await apiRequest('/app/api/logout', {
    method: 'POST',
    schema: PlatformLogoutEnvelopeSchema,
    fallbackMessage: 'Unable to sign out',
  })
  return payload.redirectTo
}

const PlatformLogoutEnvelopeSchema = Type.Object({
  redirectTo: Type.String({ minLength: 1 }),
})

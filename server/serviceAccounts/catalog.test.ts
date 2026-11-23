import { expect, test } from 'bun:test'
import { createCapabilityTestHarness } from '../../src/__tests__/helpers/capabilityHarness'
import { cmsOperations, availableOperations, describeOperation } from './catalog'
import { FONTS_ROUTES } from '../handlers/cms/fonts'
import { REGISTRY_ROUTES } from '../handlers/cms/registry'
import { MEDIA_ROUTES } from '../handlers/cms/media'
import { MEDIA_FOLDER_ROUTES } from '../handlers/cms/mediaFolders'
import { LOOP_SOURCE_ROUTES } from '../handlers/cms/loopSources'
import { PLUGIN_ROUTES } from '../handlers/cms/plugins'
import { DATA_ROW_ROUTES } from '../handlers/cms/data/rows'
import { MEMBER_ROUTES } from '../handlers/cms/members'
import { MAIL_ROUTES } from '../handlers/cms/mail'
import { USERS_ROUTES } from '../handlers/cms/users'
import { ROLES_ROUTES } from '../handlers/cms/roles'

function samplePath(template: string): string {
  return template.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
    if (key === 'scope') return 'site'
    if (key === 'index') return '0'
    if (key === 'providerId') return 'openai'
    return 'fixture'
  })
}

test('the service catalog covers the operational route tables and contains unique method/path pairs', () => {
  const keys = cmsOperations.map(op => op.method + ' ' + op.path)
  expect(new Set(keys).size).toBe(keys.length)
  const tables = [
    ...FONTS_ROUTES, ...REGISTRY_ROUTES, ...MEDIA_ROUTES, ...MEDIA_FOLDER_ROUTES, ...LOOP_SOURCE_ROUTES,
    ...PLUGIN_ROUTES, ...DATA_ROW_ROUTES, ...MEMBER_ROUTES, ...MAIL_ROUTES, ...USERS_ROUTES,
    ...ROLES_ROUTES.filter(route => route.method === 'GET'), // mutations are installation-owner only
  ]
  for (const route of tables) {
    const covered = cmsOperations.some(operation => {
      if (operation.method !== route.method) return false
      const path = '/admin/api/cms/' + samplePath(operation.path)
      const parameters = operation.path.split('/').filter(part => part.startsWith(':')).length
      if (typeof route.pattern === 'string') return parameters === 0 && route.pattern === path
      const match = route.pattern.exec(path)
      return match !== null && Object.keys(match.groups ?? {}).length === parameters
    })
    expect(covered, route.method + ' ' + route.pattern).toBe(true)
  }
})

test('each documented built-in request reaches its normal CMS or AI dispatcher', async () => {
  const h = await createCapabilityTestHarness()
  try {
    for (const op of cmsOperations) {
      // cli-context is served by the service credential verifier itself.
      if (op.path === 'cli-context') continue
      const path = samplePath(op.path)
      const response = path.startsWith('/admin/api/ai/')
        ? await h.ai(path, { method: op.method })
        : await h.cms('/admin/api/cms/' + path, { method: op.method })
      expect(response.status, op.method + ' ' + op.path).toBe(op.path === 'public-site' ? 200 : 401)
    }
  } finally { await h.cleanup() }
})

test('discovery requires every independent permission, including a table family for row edits', () => {
  const paths = (grants: Parameters<typeof availableOperations>[0]) =>
    availableOperations(grants).map(op => op.method + ' ' + op.path)
  expect(paths(['dashboard.read'])).not.toContain('GET dashboard/plugins')
  expect(paths(['plugins.read'])).not.toContain('GET dashboard/plugins')
  expect(paths(['dashboard.read', 'plugins.read'])).toContain('GET dashboard/plugins')
  expect(paths(['content.edit.own'])).not.toContain('PATCH data/rows/:id')
  expect(paths(['content.edit.own', 'data.custom.tables.read'])).toContain('PATCH data/rows/:id')
  expect(paths(['data.system.tables.read'])).toContain('GET data/tables')
  const ops = availableOperations(['members.manage']).map(describeOperation)
  expect(ops.find(op => op.path === 'members/:id/tags' && op.method === 'DELETE')?.body).toBe('json')
  expect(ops.find(op => op.path === 'members/:id/sign-out')?.body).toBe('none')
})

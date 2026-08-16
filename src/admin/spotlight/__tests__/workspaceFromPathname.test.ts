import { describe, expect, it } from 'bun:test'
import { workspaceFromPathname } from '../workspaceFromPathname'

/**
 * workspaceFromPathname — one case per `AdminWorkspace`, mirroring the routes
 * `router.tsx` hands to `<AdminEntry section="...">`. The catch-all case
 * matters most: it used to default to `'site'`, which both leaked
 * site-only commands into every unrecognized route and made cross-workspace
 * commands like "Take the editor tour" think they were already on the Site
 * workspace (see the `fix(spotlight)` commit this test accompanies).
 */
describe('workspaceFromPathname', () => {
  it('classifies the Site editor', () => {
    expect(workspaceFromPathname('/admin/site')).toBe('site')
    expect(workspaceFromPathname('/admin/site/some/nested/path')).toBe('site')
  })

  it('classifies Content', () => {
    expect(workspaceFromPathname('/admin/content')).toBe('content')
  })

  it('classifies Data', () => {
    expect(workspaceFromPathname('/admin/data')).toBe('data')
  })

  it('classifies Media', () => {
    expect(workspaceFromPathname('/admin/media')).toBe('media')
  })

  it('classifies the plugin manager list as Plugins', () => {
    expect(workspaceFromPathname('/admin/plugins')).toBe('plugins')
  })

  it('classifies an installed plugin page as pluginPage, not Plugins', () => {
    expect(workspaceFromPathname('/admin/plugins/acme.widget/settings')).toBe('pluginPage')
  })

  it('classifies Users', () => {
    expect(workspaceFromPathname('/admin/users')).toBe('users')
  })

  it('classifies AI', () => {
    expect(workspaceFromPathname('/admin/ai')).toBe('ai')
    expect(workspaceFromPathname('/admin/ai/oauth/authorize')).toBe('ai')
  })

  it('classifies Account', () => {
    expect(workspaceFromPathname('/admin/account')).toBe('account')
  })

  it('classifies Dashboard', () => {
    expect(workspaceFromPathname('/admin/dashboard')).toBe('dashboard')
  })

  it('falls back to Dashboard for any unrecognized path, matching the router catch-all', () => {
    expect(workspaceFromPathname('/admin')).toBe('dashboard')
    expect(workspaceFromPathname('/')).toBe('dashboard')
    expect(workspaceFromPathname('/admin/not-a-real-workspace')).toBe('dashboard')
  })
})

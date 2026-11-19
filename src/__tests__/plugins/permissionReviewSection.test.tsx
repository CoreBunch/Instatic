/**
 * Tests for the upgrade permission diff in PermissionReviewSection.
 *
 * The critical safety invariant is: when a plugin upgrade requests new
 * permissions, the UI must surface them prominently so the site owner
 * can spot a permission expansion before clicking "Update".
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import {
  PermissionReviewSection,
  computePermissionDiff,
} from '@plugins/components/PermissionReviewSection'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'

afterEach(() => {
  cleanup()
})

const baseManifest: PluginManifest = {
  id: 'acme.test',
  name: 'Acme Plugin',
  version: '2.0.0',
  apiVersion: 1,
  description: 'Test plugin',
  permissions: [],
  resources: [],
  adminPages: [],
}

describe('computePermissionDiff', () => {
  it('returns all requested as new for a fresh install (no previously-granted)', () => {
    const rows = computePermissionDiff(['cms.routes', 'cms.storage'], undefined)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.status === 'new')).toBe(true)
  })

  it('puts new permissions first, then existing, then dropped', () => {
    const rows = computePermissionDiff(
      ['editor.commands', 'cms.routes', 'editor.canvas'] satisfies PluginPermission[],
      ['editor.commands', 'cms.storage'] satisfies PluginPermission[],
    )
    // Order: new (cms.routes, editor.canvas), existing (editor.commands), dropped (cms.storage)
    expect(rows.map((r) => r.permission)).toEqual([
      'cms.routes',
      'editor.canvas',
      'editor.commands',
      'cms.storage',
    ])
    expect(rows.map((r) => r.status)).toEqual(['new', 'new', 'existing', 'dropped'])
  })

  it('returns no rows when nothing is requested or previously granted', () => {
    expect(computePermissionDiff([], undefined)).toEqual([])
    expect(computePermissionDiff([], [])).toEqual([])
  })

  it('returns only dropped rows when the new manifest requests nothing', () => {
    const rows = computePermissionDiff([], ['cms.routes'])
    expect(rows).toEqual([{ permission: 'cms.routes', status: 'dropped' }])
  })

  it('returns only existing rows when nothing changes', () => {
    const rows = computePermissionDiff(
      ['cms.routes', 'cms.storage'],
      ['cms.routes', 'cms.storage'],
    )
    expect(rows.every((r) => r.status === 'existing')).toBe(true)
  })
})

describe('PermissionReviewSection — fresh install', () => {
  it('shows the review heading + lists every permission with no badges', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: { ...baseManifest, permissions: ['cms.routes', 'cms.storage'] },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByText('Review Acme Plugin')).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Approve and Install' }),
    ).toBeDefined()
    // Fresh install doesn't show diff badges.
    expect(screen.queryByText('Already approved')).toBeNull()
    expect(screen.queryByText('No longer requested')).toBeNull()
  })

  it('renders a "no permissions requested" notice for a zero-permission install', () => {
    render(
      <PermissionReviewSection
        pending={{ manifest: { ...baseManifest, permissions: [] } }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const empty = screen.getByTestId('permission-review-empty')
    expect(empty.textContent).toContain('No permissions requested')
    expect(
      screen.getByRole('button', { name: 'Approve and Install' }),
    ).toBeDefined()
    // No unsandboxed-code callout for a declarative plugin.
    expect(screen.queryByTestId('unsandboxed-code-alert')).toBeNull()
  })

  it('flags editor.code installs with an unsandboxed-code alert', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['editor.code', 'editor.commands'] satisfies PluginPermission[],
            entrypoints: { editor: 'editor/index.js' },
          },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const alert = screen.getByTestId('unsandboxed-code-alert')
    expect(alert.textContent).toContain('outside the plugin sandbox')
    expect(alert.textContent).toContain('editor entrypoint')
  })

  it('names app pages in the unsandboxed-code alert when the manifest ships them', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['admin.navigation', 'editor.code'] satisfies PluginPermission[],
            adminPages: [{
              id: 'dashboard',
              title: 'Dashboard',
              route: '/admin/plugins/acme.test/dashboard',
              content: { kind: 'app', heading: 'Dashboard', entry: 'admin/dashboard.js' },
            }],
          },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByTestId('unsandboxed-code-alert').textContent).toContain('admin app pages')
  })
})

describe('PermissionReviewSection — upgrade with new permissions', () => {
  it('shows the alert highlighting the new-permission count', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['cms.routes', 'editor.canvas'] satisfies PluginPermission[],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['cms.routes'] satisfies PluginPermission[],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const alert = screen.getByTestId('permission-diff-alert')
    expect(alert.textContent).toContain('1 new permission')
  })

  it('puts the NEW row before existing rows in DOM order', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: [
              'cms.storage',
              'editor.canvas',
            ] satisfies PluginPermission[],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['cms.storage'] satisfies PluginPermission[],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-permission]'),
    )
    expect(rows[0].dataset.permission).toBe('editor.canvas')
    expect(rows[0].dataset.status).toBe('new')
    expect(rows[1].dataset.permission).toBe('cms.storage')
    expect(rows[1].dataset.status).toBe('existing')
  })

  it('upgrades the confirm button label to call out new-permission count', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['cms.routes', 'editor.canvas'] satisfies PluginPermission[],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['cms.routes'] satisfies PluginPermission[],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(
      screen.getByRole('button', {
        name: /Approve 1 new and update to 2\.0\.0/,
      }),
    ).toBeDefined()
  })

  it('shows a reassurance banner when the upgrade adds zero new permissions', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['cms.routes'] satisfies PluginPermission[],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['cms.routes'] satisfies PluginPermission[],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByTestId('permission-diff-noop')).toBeDefined()
    expect(screen.queryByTestId('permission-diff-alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Update to 2.0.0' })).toBeDefined()
  })

  it('renders dropped permissions as informational rows', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['cms.routes'] satisfies PluginPermission[],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: [
            'cms.routes',
            'cms.storage',
          ] satisfies PluginPermission[],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const droppedRow = container.querySelector('[data-status="dropped"]')
    expect(droppedRow).not.toBeNull()
    expect(droppedRow?.getAttribute('data-permission')).toBe('cms.storage')
  })

  it('lists what apps may be allowed to do through the plugin, and nothing when it declares none', () => {
    const view = (manifest: PluginManifest) =>
      render(
        <PermissionReviewSection pending={{ manifest }} uploading={false} onCancel={() => {}} onConfirm={() => {}} />,
      )
    const { container, unmount } = view({
      ...baseManifest,
      permissions: ['cms.routes', 'members.read'] satisfies PluginPermission[],
      appScopes: [
        { name: 'read', description: 'See your purchases and plan' },
        { name: 'manage', description: 'Create licences for you' },
      ],
    })
    const section = container.querySelector('[data-testid="permission-review-app-scopes"]')
    expect(section?.textContent).toContain('Access for apps')
    const rows = [...(section?.querySelectorAll('[data-app-scope]') ?? [])]
    expect(rows.map((row) => row.getAttribute('data-app-scope'))).toEqual(['read', 'manage'])
    expect(rows[0]?.textContent).toContain('See your purchases and plan')
    expect(rows[0]?.textContent).toContain('plugin:acme.test:read')
    unmount()

    expect(view(baseManifest).container.querySelector('[data-testid="permission-review-app-scopes"]')).toBeNull()
  })

  it('marks app scopes an update adds, rewords, keeps and removes, and says members will be asked again', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['cms.routes', 'members.read'] satisfies PluginPermission[],
            appScopes: [
              { name: 'read', description: 'See and change your purchases' },
              { name: 'manage', description: 'Create licences for you' },
              { name: 'export', description: 'Download your invoices' },
            ],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['cms.routes', 'members.read'],
          previousAppScopes: [
            { name: 'read', description: 'See your purchases' },
            { name: 'manage', description: 'Create licences for you' },
            { name: 'refund', description: 'Ask for a refund for you' },
          ],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const rows = [...container.querySelectorAll('[data-app-scope]')]
    expect(rows.map((row) => `${row.getAttribute('data-app-scope')}:${row.getAttribute('data-app-scope-status')}`)).toEqual([
      'read:changed',
      'manage:unchanged',
      'export:new',
      'refund:removed',
    ])
    expect(rows[0]?.textContent).toContain('Reworded')
    // The owner sees both wordings of a scope whose meaning moved.
    expect(rows[0]?.textContent).toContain('See and change your purchases')
    expect(rows[0]?.textContent).toContain('See your purchases')
    expect(rows[3]?.textContent).toContain('Removed')

    const alert = screen.getByTestId('app-scope-diff-alert')
    expect(alert.textContent).toContain('2 things')
    expect(alert.textContent).toContain('asked again')
    // No permission is new, but this is not an update with nothing to look at.
    expect(screen.queryByTestId('permission-diff-noop')).toBeNull()
  })

  it('keeps the reassurance when an update leaves the app scopes as they were', () => {
    const appScopes = [{ name: 'read', description: 'See your purchases' }]
    render(
      <PermissionReviewSection
        pending={{
          manifest: { ...baseManifest, permissions: ['cms.routes', 'members.read'] satisfies PluginPermission[], appScopes },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['cms.routes', 'members.read'],
          previousAppScopes: appScopes,
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.queryByTestId('app-scope-diff-alert')).toBeNull()
    expect(screen.getByTestId('permission-diff-noop')).toBeTruthy()
  })
})

describe('PermissionReviewSection — third-party origins on published pages', () => {
  const manifest: PluginManifest = {
    ...baseManifest,
    permissions: ['frontend.assets'] satisfies PluginPermission[],
    frontend: {
      assets: [],
      origins: { scripts: ['js.example.com'], frames: ['pay.example.com', 'hooks.example.com'] },
    },
  }

  it('lists each origin in plain words on a fresh install', () => {
    render(
      <PermissionReviewSection
        pending={{ manifest }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const section = screen.getByTestId('permission-review-frontend-origins')
    expect(section.textContent).toContain('May load scripts from js.example.com')
    expect(section.textContent).toContain('May embed frames from pay.example.com')
    expect(section.textContent).toContain('May embed frames from hooks.example.com')
    expect(screen.queryByTestId('frontend-origins-diff-alert')).toBeNull()
  })

  it('flags the origins an upgrade adds and shows the ones it drops', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest,
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['frontend.assets'] satisfies PluginPermission[],
          previousFrontendOrigins: { scripts: ['js.example.com', 'old.example.com'], frames: ['pay.example.com'] },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByTestId('frontend-origins-diff-alert').textContent).toContain('1 new third-party host')
    const status = (host: string) =>
      container.querySelector(`[data-frontend-origin="${host}"]`)?.getAttribute('data-status')
    expect(status('hooks.example.com')).toBe('new')
    expect(status('js.example.com')).toBe('existing')
    expect(status('old.example.com')).toBe('dropped')
  })

  it('warns under every wildcard origin, and only there', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...manifest,
            frontend: { assets: [], origins: { scripts: ['js.example.com', '*.js.example.com'] } },
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['frontend.assets'] satisfies PluginPermission[],
          previousFrontendOrigins: { scripts: ['js.example.com'], frames: ['*.old.example.com'] },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const warning = (host: string) =>
      container.querySelector(`[data-frontend-origin="${host}"] [data-testid="frontend-origin-wildcard-warning"]`)
    expect(warning('*.js.example.com')?.textContent).toContain('Any subdomain of js.example.com')
    expect(warning('js.example.com')).toBeNull()
    // An origin the update drops is going away; nothing to warn about.
    expect(warning('*.old.example.com')).toBeNull()
  })

  it('renders no section when the plugin declares no origins', () => {
    render(
      <PermissionReviewSection
        pending={{ manifest: baseManifest }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.queryByTestId('permission-review-frontend-origins')).toBeNull()
  })
})

describe('PermissionReviewSection — email templates', () => {
  it('names the emails a plugin can send and says they can be reworded', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: ['mail.send', 'mail.send.external'] satisfies PluginPermission[],
            mail: {
              templates: [
                { key: 'reply', label: 'Ticket reply', description: 'Sent when the team answers.', variables: [], subject: 'S', body: 'B' },
                { key: 'opened', label: 'New ticket', description: 'Sent to the support inbox.', variables: [], subject: 'S', body: 'B' },
              ],
            },
          },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const section = screen.getByTestId('permission-review-mail-templates')
    expect(section.textContent).toContain('Adds 2 email templates')
    expect(section.textContent).toContain('Ticket reply')
    expect(section.textContent).toContain('Sent to the support inbox.')
    expect(section.textContent).toContain('Email → Templates')
    // Both permissions are listed with what they allow.
    expect(document.body.textContent).toContain('Email site members')
    expect(document.body.textContent).toContain('Email any address')
  })

  it('shows what each email says, in a frame that runs nothing', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            id: 'acme.desk',
            permissions: ['mail.send'] satisfies PluginPermission[],
            mail: {
              templates: [{
                key: 'reply',
                label: 'Ticket reply',
                description: 'Sent when the team answers.',
                variables: [{ name: 'subject', label: 'Ticket subject', sample: 'Publishing stops' }],
                subject: 'Re: {subject}',
                body: 'We answered **{subject}**.',
              }],
            },
          },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const row = container.querySelector('[data-mail-template="reply"]')
    expect(row?.textContent).toContain('Re: Publishing stops')
    const frame = row?.querySelector('iframe')
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('srcdoc')).toContain('We answered <strong>Publishing stops</strong>.')
    // A first install has nothing to compare with: no badges, no alert.
    expect(screen.queryByTestId('mail-templates-diff-alert')).toBeNull()
  })

  it('flags the emails an upgrade adds or rewords, like an added permission', () => {
    const template = (key: string, body: string) => ({
      key, label: key, description: 'd', variables: [], subject: 'S', body,
    })
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            version: '2.0.0',
            permissions: ['mail.send'] satisfies PluginPermission[],
            mail: {
              templates: [
                template('same', 'Same.'),
                template('reworded', 'Send us your password.'),
                template('added', 'New.'),
                // Same words, but a variable that could now carry an address.
                { ...template('retyped', 'Go: {where}'), variables: [{ name: 'where', label: 'Where', sample: 'https://example.com/', kind: 'link' as const }] },
              ],
            },
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['mail.send'] satisfies PluginPermission[],
          previousMailTemplates: [
            template('same', 'Same.'),
            template('reworded', 'Thanks.'),
            { ...template('retyped', 'Go: {where}'), variables: [{ name: 'where', label: 'Where', sample: 'there' }] },
          ],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.getByTestId('mail-templates-diff-alert').textContent).toContain('3 email templates')
    const status = (key: string) => container.querySelector(`[data-mail-template="${key}"]`)?.getAttribute('data-mail-status')
    expect(status('same')).toBe('existing')
    expect(status('reworded')).toBe('changed')
    expect(status('added')).toBe('new')
    expect(status('retyped')).toBe('changed')
    // The changed ones are open to be read; the approve button counts them.
    expect(container.querySelector('[data-mail-template="reworded"] details')?.hasAttribute('open')).toBe(true)
    expect(container.querySelector('[data-mail-template="same"] details')?.hasAttribute('open')).toBe(false)
    expect(document.body.textContent).toContain('Approve 3 new and update to 2.0.0')
  })

  it('flags mail.send.external as new when an upgrade adds it', () => {
    const { container } = render(
      <PermissionReviewSection
        pending={{
          manifest: { ...baseManifest, version: '2.0.0', permissions: ['mail.send', 'mail.send.external'] satisfies PluginPermission[] },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: ['mail.send'] satisfies PluginPermission[],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(container.querySelector('[data-permission="mail.send.external"]')?.getAttribute('data-status')).toBe('new')
    expect(container.querySelector('[data-permission="mail.send"]')?.getAttribute('data-status')).toBe('existing')
    expect(screen.getByTestId('permission-diff-alert').textContent).toContain('1 new permission')
  })

  it('renders no section when the plugin declares no templates', () => {
    render(
      <PermissionReviewSection pending={{ manifest: baseManifest }} uploading={false} onCancel={() => {}} onConfirm={() => {}} />,
    )
    expect(screen.queryByTestId('permission-review-mail-templates')).toBeNull()
  })
})

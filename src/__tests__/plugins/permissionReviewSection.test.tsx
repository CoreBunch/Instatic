/**
 * Tests for the upgrade permission diff in PermissionReviewSection.
 *
 * The critical safety invariant is: when a plugin upgrade requests new
 * permissions, the UI must surface them prominently so the site owner
 * can spot a permission expansion before clicking "Update". The same
 * invariant covers the manifest's `contentAccess[]` allowlist — a new
 * table, or a new mode on an already-approved table, must show as new.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import {
  OWN_CREATED_CONTENT_TABLE,
  PermissionReviewSection,
  computeContentAccessDiff,
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

describe('computeContentAccessDiff', () => {
  it('marks every entry new on a fresh install and sorts modes canonically', () => {
    const rows = computeContentAccessDiff(
      [{ table: 'posts', modes: ['write', 'read'] }],
      undefined,
      false,
    )
    expect(rows).toEqual([
      { table: 'posts', modes: ['read', 'write'], addedModes: [], status: 'new' },
    ])
  })

  it('diffs new, existing, and dropped tables on upgrade, new first', () => {
    const rows = computeContentAccessDiff(
      [
        { table: 'pages', modes: ['read'] },
        { table: 'reviews', modes: ['read', 'write'] },
      ],
      [
        { table: 'pages', modes: ['read'] },
        { table: 'posts', modes: ['read'] },
      ],
      true,
    )
    expect(rows.map((r) => [r.table, r.status])).toEqual([
      ['reviews', 'new'],
      ['pages', 'existing'],
      ['posts', 'dropped'],
    ])
  })

  it('promotes an already-approved table to new when the update adds modes', () => {
    const rows = computeContentAccessDiff(
      [{ table: 'posts', modes: ['read', 'write'] }],
      [{ table: 'posts', modes: ['read'] }],
      true,
    )
    expect(rows).toEqual([
      { table: 'posts', modes: ['read', 'write'], addedModes: ['write'], status: 'new' },
    ])
  })

  it('keeps a table with reduced modes as existing, showing the requested modes', () => {
    const rows = computeContentAccessDiff(
      [{ table: 'posts', modes: ['read'] }],
      [{ table: 'posts', modes: ['read', 'write'] }],
      true,
    )
    expect(rows).toEqual([
      { table: 'posts', modes: ['read'], addedModes: [], status: 'existing' },
    ])
  })

  it('renders dropped rows with the previously-declared modes', () => {
    const rows = computeContentAccessDiff(
      [],
      [{ table: 'posts', modes: ['delete', 'read'] }],
      true,
    )
    expect(rows).toEqual([
      { table: 'posts', modes: ['read', 'delete'], addedModes: [], status: 'dropped' },
    ])
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
})

describe('PermissionReviewSection — content tables', () => {
  it('lists each contentAccess entry with its modes on a fresh install', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: [
              'cms.content.read',
              'cms.content.write',
            ] satisfies PluginPermission[],
            contentAccess: [
              { table: 'posts', modes: ['read', 'write'] },
              { table: 'pages', modes: ['read'] },
            ],
          },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const section = screen.getByTestId('permission-review-content-tables')
    expect(section.textContent).toContain('Content tables')
    const rows = Array.from(
      section.querySelectorAll<HTMLElement>('[data-content-table]'),
    )
    expect(rows.map((row) => row.dataset.contentTable)).toEqual(['pages', 'posts'])
    expect(rows[1].textContent).toContain('posts')
    expect(rows[1].textContent).toContain('Read, write')
    // Fresh install shows no diff badges.
    expect(screen.queryByText('Already approved')).toBeNull()
  })

  it('omits the section when the manifest declares no contentAccess', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: { ...baseManifest, permissions: ['cms.routes'] },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(screen.queryByTestId('permission-review-content-tables')).toBeNull()
  })

  it('renders the @own-created marker human-readably', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: [
              'cms.content.read',
              'cms.content.write',
            ] satisfies PluginPermission[],
            contentAccess: [
              { table: OWN_CREATED_CONTENT_TABLE, modes: ['read', 'write'] },
            ],
          },
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const section = screen.getByTestId('permission-review-content-tables')
    expect(section.textContent).toContain('Tables this plugin creates')
    expect(section.textContent).not.toContain(OWN_CREATED_CONTENT_TABLE)
  })

  it('badges new tables, added modes, and dropped tables on upgrade', () => {
    render(
      <PermissionReviewSection
        pending={{
          manifest: {
            ...baseManifest,
            permissions: [
              'cms.content.read',
              'cms.content.write',
            ] satisfies PluginPermission[],
            contentAccess: [
              // `write` is newly requested on the already-approved table.
              { table: 'posts', modes: ['read', 'write'] },
              // Brand-new table.
              { table: 'reviews', modes: ['read'] },
            ],
          },
          upgradeFromVersion: '1.0.0',
          previouslyGrantedPermissions: [
            'cms.content.read',
            'cms.content.write',
          ] satisfies PluginPermission[],
          previousContentAccess: [
            { table: 'posts', modes: ['read'] },
            { table: 'legacy', modes: ['read'] },
          ],
        }}
        uploading={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    const section = screen.getByTestId('permission-review-content-tables')
    const rows = Array.from(
      section.querySelectorAll<HTMLElement>('[data-content-table]'),
    )
    expect(rows.map((row) => [row.dataset.contentTable, row.dataset.status])).toEqual([
      ['posts', 'new'],
      ['reviews', 'new'],
      ['legacy', 'dropped'],
    ])
    // The already-approved table that gained a mode calls the mode out.
    expect(rows[0].textContent).toContain('newly requested: write')
    // The dropped table shows its previously-declared modes, struck through.
    expect(rows[2].textContent).toContain('No longer requested')
    expect(rows[2].textContent).toContain('Read')
  })
})

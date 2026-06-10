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
})

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  EDITOR_LAYOUT_STORAGE_KEY,
  readEditorLayout,
  readStoredPanelPosition,
  readStoredPanelSize,
  readWorkspaceLayout,
  workspaceFromPathname,
  writeStoredPanelPosition,
  writeStoredPanelSize,
  writeWorkspaceLayout,
} from '@admin/state/workspaceLayoutStorage'

beforeEach(() => {
  localStorage.clear()
})

describe('workspaceLayoutStorage — floating panel positions', () => {
  it('stores floating panel positions at the top-level (not per-workspace)', () => {
    writeStoredPanelPosition('agent', { x: 640, y: 120 })

    expect(readStoredPanelPosition('agent')).toEqual({ x: 640, y: 120 })
    expect(readEditorLayout()?.panelPositions?.agent).toEqual({ x: 640, y: 120 })
  })

  it('preserves workspace layouts when updating a panel position', () => {
    writeWorkspaceLayout('site', { leftWidth: 400, rightOpen: true })
    writeStoredPanelPosition('agent', { x: 420, y: 240 })

    expect(readWorkspaceLayout('site').leftWidth).toBe(400)
    expect(readWorkspaceLayout('site').rightOpen).toBe(true)
    expect(readStoredPanelPosition('agent')).toEqual({ x: 420, y: 240 })
  })

  it('does not write retired per-panel localStorage keys', () => {
    writeStoredPanelPosition('agent', { x: 24, y: 180 })

    expect(localStorage.getItem('instatic-agent-panel-pos')).toBeNull()
  })
})

describe('workspaceLayoutStorage — floating panel sizes', () => {
  it('stores floating panel dimensions without clobbering its position', () => {
    writeStoredPanelPosition('site', { x: 420, y: 140 })
    writeStoredPanelSize('site', { width: 540, height: 460 })

    expect(readStoredPanelPosition('site')).toEqual({ x: 420, y: 140 })
    expect(readStoredPanelSize('site')).toEqual({ width: 540, height: 460 })
    expect(readEditorLayout()?.panelSizes?.site).toEqual({ width: 540, height: 460 })
  })

  it('preserves workspace layout state when updating floating dimensions', () => {
    writeWorkspaceLayout('site', {
      leftWidth: 380,
      leftPanelModes: { explorer: 'floating' },
    })
    writeStoredPanelSize('properties', { width: 480, height: 620 })

    expect(readWorkspaceLayout('site')).toMatchObject({
      leftWidth: 380,
      leftPanelModes: { explorer: 'floating' },
    })
    expect(readStoredPanelSize('properties')).toEqual({ width: 480, height: 620 })
  })
})

describe('workspaceLayoutStorage — per-workspace layouts', () => {
  it('namespaces sidebar state by workspace', () => {
    writeWorkspaceLayout('site', { leftWidth: 400, rightOpen: true, rightWidth: 380 })
    writeWorkspaceLayout('media', { leftWidth: 280, activeLeftPanel: 'storage' })

    expect(readWorkspaceLayout('site')).toMatchObject({
      leftWidth: 400,
      rightOpen: true,
      rightWidth: 380,
    })
    expect(readWorkspaceLayout('media')).toMatchObject({
      leftWidth: 280,
      activeLeftPanel: 'storage',
    })
    // content has nothing yet — empty object, not the site layout
    expect(readWorkspaceLayout('content')).toEqual({})
  })

  it('merges partial updates into a workspace layout without clobbering siblings', () => {
    writeWorkspaceLayout('content', { leftWidth: 320, rightOpen: true })
    writeWorkspaceLayout('content', { activeLeftPanel: 'media' })

    expect(readWorkspaceLayout('content')).toEqual({
      leftWidth: 320,
      rightOpen: true,
      activeLeftPanel: 'media',
    })
  })

  it('persists the v2 storage shape under the bumped key', () => {
    writeWorkspaceLayout('data', { leftWidth: 360 })

    const raw = localStorage.getItem(EDITOR_LAYOUT_STORAGE_KEY) ?? '{}'
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(2)
    expect(parsed.workspaces?.data?.leftWidth).toBe(360)
  })

  it('ignores corrupted JSON and returns null', () => {
    localStorage.setItem(EDITOR_LAYOUT_STORAGE_KEY, '{not valid')
    expect(readEditorLayout()).toBeNull()
    expect(readWorkspaceLayout('site')).toEqual({})
  })
})

describe('workspaceLayoutStorage — workspaceFromPathname', () => {
  it('maps admin canvas routes onto workspace ids', () => {
    expect(workspaceFromPathname('/admin/site')).toBe('site')
    expect(workspaceFromPathname('/admin/site/pages/abc')).toBe('site')
    expect(workspaceFromPathname('/admin/content')).toBe('content')
    expect(workspaceFromPathname('/admin/data')).toBe('data')
    expect(workspaceFromPathname('/admin/media')).toBe('media')
  })

  it('returns null for non-canvas admin routes', () => {
    expect(workspaceFromPathname('/admin/account')).toBeNull()
    expect(workspaceFromPathname('/admin/users')).toBeNull()
    expect(workspaceFromPathname('/admin/plugins')).toBeNull()
    expect(workspaceFromPathname('/')).toBeNull()
  })
})

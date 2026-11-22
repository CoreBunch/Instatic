import { create } from 'zustand'
import { isMobileViewport } from '@admin/lib/mobileViewport'
import {
  readWorkspaceLayout,
  workspaceFromPathname,
  type EditorWorkspaceId,
  type StoredWorkspaceLayout,
} from './workspaceLayoutStorage'

export const SIDEBAR_MIN_WIDTH = 300
export const SIDEBAR_MAX_WIDTH = 520
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 320
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 360

export interface WorkspacePanelState {
  collapsed: boolean
  width: number
}

interface WorkspaceLayoutState {
  leftSidebarWidth: number
  rightPanel: WorkspacePanelState
  dataSidebarCollapsed: boolean
  setLeftSidebarWidth: (width: number) => void
  setRightPanel: (patch: Partial<WorkspacePanelState>) => void
  setDataSidebarCollapsed: (collapsed: boolean) => void
  hydrateWorkspaceLayout: (
    workspace: EditorWorkspaceId,
    layout: StoredWorkspaceLayout,
  ) => void
}

function finiteNumberOrCurrent(value: unknown, current: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : current
}

export function clampSidebarWidth(width: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)))
}

function leftSidebarWidth(layout: StoredWorkspaceLayout, currentWidth: number): number {
  return clampSidebarWidth(finiteNumberOrCurrent(
    layout.leftWidth,
    currentWidth || LEFT_SIDEBAR_DEFAULT_WIDTH,
  ))
}

function rightPanelWidth(layout: StoredWorkspaceLayout, currentWidth: number): number {
  return finiteNumberOrCurrent(layout.rightWidth, currentWidth || RIGHT_SIDEBAR_DEFAULT_WIDTH)
}

function rightPanelCollapsed(layout: StoredWorkspaceLayout): boolean {
  return layout.rightOpen === undefined ? isMobileViewport() : !layout.rightOpen
}

function initialNonSiteLayout(): Pick<
  WorkspaceLayoutState,
  'leftSidebarWidth' | 'rightPanel' | 'dataSidebarCollapsed'
> {
  const workspace = typeof window !== 'undefined'
    ? workspaceFromPathname(window.location.pathname)
    : null
  const layout = workspace && workspace !== 'site'
    ? readWorkspaceLayout(workspace)
    : {}
  const dataSidebarCollapsed = workspace === 'data' && typeof layout.leftOpen === 'boolean'
    ? !layout.leftOpen
    : false

  return {
    leftSidebarWidth: leftSidebarWidth(layout, LEFT_SIDEBAR_DEFAULT_WIDTH),
    rightPanel: {
      collapsed: rightPanelCollapsed(layout),
      width: rightPanelWidth(layout, RIGHT_SIDEBAR_DEFAULT_WIDTH),
    },
    dataSidebarCollapsed,
  }
}

export const useWorkspaceLayout = create<WorkspaceLayoutState>((set, get) => ({
  ...initialNonSiteLayout(),

  setLeftSidebarWidth: (width) => {
    const nextWidth = clampSidebarWidth(width)
    if (Object.is(get().leftSidebarWidth, nextWidth)) return
    set({ leftSidebarWidth: nextWidth })
  },

  setRightPanel: (patch) => {
    const current = get().rightPanel
    const next: WorkspacePanelState = {
      ...current,
      ...patch,
      width: patch.width === undefined
        ? current.width
        : finiteNumberOrCurrent(patch.width, current.width),
    }
    if (
      Object.is(current.collapsed, next.collapsed) &&
      Object.is(current.width, next.width)
    ) {
      return
    }
    set({ rightPanel: next })
  },

  setDataSidebarCollapsed: (collapsed) => {
    if (Object.is(get().dataSidebarCollapsed, collapsed)) return
    set({ dataSidebarCollapsed: collapsed })
  },

  hydrateWorkspaceLayout: (workspace, layout) => {
    const current = get()
    const nextLeftWidth = leftSidebarWidth(layout, current.leftSidebarWidth)
    const nextRightPanel: WorkspacePanelState = {
      collapsed: rightPanelCollapsed(layout),
      width: rightPanelWidth(layout, current.rightPanel.width),
    }
    const nextDataSidebarCollapsed = workspace === 'data' && typeof layout.leftOpen === 'boolean'
      ? !layout.leftOpen
      : current.dataSidebarCollapsed

    if (
      Object.is(current.leftSidebarWidth, nextLeftWidth) &&
      Object.is(current.rightPanel.collapsed, nextRightPanel.collapsed) &&
      Object.is(current.rightPanel.width, nextRightPanel.width) &&
      Object.is(current.dataSidebarCollapsed, nextDataSidebarCollapsed)
    ) {
      return
    }

    set({
      leftSidebarWidth: nextLeftWidth,
      rightPanel: nextRightPanel,
      dataSidebarCollapsed: nextDataSidebarCollapsed,
    })
  },
}))

import { rawReturn } from 'mutative'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { EditorStore } from '@site/store/types'
import type { ExplorerPanelTab } from '@site/store/slices/uiSlice'
import {
  readWorkspaceLayout,
  writeWorkspaceLayout,
  type PropertiesPanelMode,
  type StoredWorkspaceLayout,
} from '@admin/state/workspaceLayoutStorage'
import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
} from '@admin/state/workspaceLayout'

type EditorStoreApi = UseBoundStore<StoreApi<EditorStore>>

export type SiteLayoutSelection = readonly [
  explorerOpen: boolean,
  propertiesOpen: boolean,
  selectorsOpen: boolean,
  frameworkOpen: boolean,
  dependenciesOpen: boolean,
  codeEditorOpen: boolean,
  agentOpen: boolean,
  explorerTab: ExplorerPanelTab,
  propertiesMode: PropertiesPanelMode,
  leftSidebarWidth: number,
  propertiesWidth: number,
  activeEditorFileId: string | null,
]

function boolOrCurrent(value: unknown, current: boolean): boolean {
  return typeof value === 'boolean' ? value : current
}

function finiteNumberOrCurrent(value: unknown, current: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : current
}

function explorerTab(
  value: unknown,
  current: ExplorerPanelTab,
): ExplorerPanelTab {
  return value === 'layers' || value === 'site' || value === 'code' || value === 'media'
    ? value
    : current
}

function propertiesMode(
  layout: StoredWorkspaceLayout,
  currentMode: PropertiesPanelMode,
): PropertiesPanelMode {
  const mode = layout.propertiesPanelMode
  return mode === 'floating' || mode === 'docked' ? mode : currentMode
}

function leftSidebarWidth(layout: StoredWorkspaceLayout, currentWidth: number): number {
  return clampSidebarWidth(finiteNumberOrCurrent(
    layout.leftWidth,
    currentWidth || LEFT_SIDEBAR_DEFAULT_WIDTH,
  ))
}

export function selectSiteLayoutState(s: EditorStore): SiteLayoutSelection {
  return [
    s.explorerPanelOpen,
    !s.propertiesPanel.collapsed,
    s.selectorsPanelOpen,
    s.frameworkPanelOpen,
    s.dependenciesPanelOpen,
    s.codeEditorPanelOpen,
    s.isAgentOpen,
    s.explorerPanelTab,
    s.propertiesPanelMode,
    s.leftSidebarWidth,
    s.propertiesPanel.width,
    s.activeEditorFileId,
  ] as const
}

export function sameLayoutSelection<T extends readonly unknown[]>(a: T, b: T): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

function deriveSiteActiveLeftPanel(selection: SiteLayoutSelection): string | null {
  const [
    explorerOpen,
    ,
    selectorsOpen,
    frameworkOpen,
    dependenciesOpen,
    ,
    agentOpen,
  ] = selection

  if (explorerOpen) return 'explorer'
  if (selectorsOpen) return 'selectors'
  if (frameworkOpen) return 'framework'
  if (dependenciesOpen) return 'dependencies'
  if (agentOpen) return 'agent'
  return null
}

export function siteLayoutFromSelection(
  selection: SiteLayoutSelection,
): StoredWorkspaceLayout {
  const [
    ,
    propertiesOpen,
    ,
    ,
    ,
    codeEditorOpen,
    ,
    explorerTab,
    propertiesMode,
    leftSidebarWidth,
    propertiesWidth,
    activeEditorFileId,
  ] = selection

  return {
    leftWidth: clampSidebarWidth(leftSidebarWidth),
    rightWidth: propertiesWidth,
    leftOpen: deriveSiteActiveLeftPanel(selection) !== null,
    rightOpen: propertiesOpen,
    activeLeftPanel: deriveSiteActiveLeftPanel(selection),
    explorerPanelTab: explorerTab,
    activeEditorFileId,
    codeEditorPanelOpen: codeEditorOpen,
    propertiesPanelMode: propertiesMode,
  }
}

export function restoreStoredSiteEditorLayout(
  api: EditorStoreApi,
  layout: StoredWorkspaceLayout,
): void {
  api.setState((state) => {
    const propertiesOpen = boolOrCurrent(layout.rightOpen, !state.propertiesPanel.collapsed)
    const storedActivePanel = layout.activeLeftPanel
    const applyLeftPanel = storedActivePanel !== undefined

    const leftPanelPatch = applyLeftPanel
      ? {
          explorerPanelOpen: storedActivePanel === 'explorer',
          selectorsPanelOpen: storedActivePanel === 'selectors',
          frameworkPanelOpen: storedActivePanel === 'framework',
          dependenciesPanelOpen: storedActivePanel === 'dependencies',
          isAgentOpen: storedActivePanel === 'agent',
        }
      : {}

    return rawReturn({
      propertiesPanel: {
        ...state.propertiesPanel,
        collapsed: !propertiesOpen,
        width: finiteNumberOrCurrent(layout.rightWidth, state.propertiesPanel.width),
      },
      propertiesPanelMode: propertiesMode(layout, state.propertiesPanelMode),
      leftSidebarWidth: leftSidebarWidth(layout, state.leftSidebarWidth),
      explorerPanelTab: explorerTab(layout.explorerPanelTab, state.explorerPanelTab),
      codeEditorPanelOpen: boolOrCurrent(layout.codeEditorPanelOpen, state.codeEditorPanelOpen),
      activeEditorFileId: layout.activeEditorFileId !== undefined
        ? layout.activeEditorFileId
        : state.activeEditorFileId,
      ...leftPanelPatch,
    } satisfies Partial<EditorStore>)
  })
}

export function restorePersistedSiteEditorLayout(api: EditorStoreApi): void {
  restoreStoredSiteEditorLayout(api, readWorkspaceLayout('site'))
}

export function writeSiteEditorLayout(selection: SiteLayoutSelection): void {
  writeWorkspaceLayout('site', siteLayoutFromSelection(selection))
}

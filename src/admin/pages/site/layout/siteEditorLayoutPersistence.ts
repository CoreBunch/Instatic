import { rawReturn } from 'mutative'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { EditorStore } from '@site/store/types'
import type {
  ExplorerPanelTab,
  LeftPanelModes,
  LeftSidebarPanelId,
} from '@site/store/slices/uiSlice'
import {
  CODE_DOCK_PANEL_IDS,
  clampCodeDockHeight,
  isCodeDockPanelId,
  type CodeDockColumnWeights,
  type CodeDockPanelId,
  type CodeDockPanelVisibility,
  clampCodeDockColumnWeight,
} from '@site/store/slices/codeDockSlice'
import {
  readWorkspaceLayout,
  writeWorkspaceLayout,
  type PanelMode,
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
  propertiesMode: PanelMode,
  leftPanelModes: LeftPanelModes,
  leftSidebarWidth: number,
  propertiesWidth: number,
  activeEditorFileId: string | null,
  godModeActive: boolean,
  codeDockHeight: number,
  codeDockPanels: CodeDockPanelVisibility,
  codeDockActiveTab: CodeDockPanelId,
  codeDockColumnWeights: CodeDockColumnWeights,
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
  currentMode: PanelMode,
): PanelMode {
  const mode = layout.propertiesPanelMode
  return mode === 'floating' || mode === 'docked' ? mode : currentMode
}

function storedPanelMode(value: unknown, currentMode: PanelMode): PanelMode {
  return value === 'floating' || value === 'docked' ? value : currentMode
}

const LEFT_PANEL_IDS: LeftSidebarPanelId[] = [
  'explorer',
  'selectors',
  'framework',
  'dependencies',
  'agent',
]

function storedLeftPanelModes(
  value: Record<string, PanelMode> | undefined,
  currentModes: LeftPanelModes,
): LeftPanelModes {
  return Object.fromEntries(LEFT_PANEL_IDS.map((panel) => [
    panel,
    storedPanelMode(value?.[panel], currentModes[panel]),
  ])) as LeftPanelModes
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
    s.leftPanelModes,
    s.leftSidebarWidth,
    s.propertiesPanel.width,
    s.activeEditorFileId,
    s.godModeActive,
    s.codeDockHeight,
    s.codeDockPanels,
    s.codeDockActiveTab,
    s.codeDockColumnWeights,
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
  ] = selection

  const modes = selection[9]
  if (explorerOpen && modes.explorer === 'docked') return 'explorer'
  if (selectorsOpen && modes.selectors === 'docked') return 'selectors'
  if (frameworkOpen && modes.framework === 'docked') return 'framework'
  if (dependenciesOpen && modes.dependencies === 'docked') return 'dependencies'
  if (selection[6] && modes.agent === 'docked') return 'agent'
  return null
}

function deriveOpenLeftPanels(selection: SiteLayoutSelection): LeftSidebarPanelId[] {
  const [explorer, , selectors, framework, dependencies, , agent] = selection
  return LEFT_PANEL_IDS.filter((panel) => ({
    explorer,
    selectors,
    framework,
    dependencies,
    agent,
  })[panel])
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
    leftPanelModes,
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
    leftPanelModes,
    openLeftPanels: deriveOpenLeftPanels(selection),
    godModeActive: selection[13],
    codeDockHeight: selection[14],
    codeDockPanels: selection[15],
    codeDockActiveTab: selection[16],
    codeDockColumnWeights: selection[17],
  }
}

function storedCodeDockPanels(
  value: Record<string, boolean> | undefined,
  current: CodeDockPanelVisibility,
): CodeDockPanelVisibility {
  return Object.fromEntries(CODE_DOCK_PANEL_IDS.map((panel) => [
    panel,
    typeof value?.[panel] === 'boolean' ? value[panel] : current[panel],
  ])) as CodeDockPanelVisibility
}

function storedCodeDockTab(
  value: unknown,
  current: CodeDockPanelId,
): CodeDockPanelId {
  return isCodeDockPanelId(value) ? value : current
}

function storedCodeDockWeights(
  value: Record<string, number> | undefined,
  current: CodeDockColumnWeights,
): CodeDockColumnWeights {
  const valid = value !== undefined && CODE_DOCK_PANEL_IDS.every(
    (panel) => Number.isFinite(value[panel]) && (value[panel] as number) > 0,
  )
  // Always build a fresh object: `current` may be a Mutative draft proxy that
  // is revoked when the recipe returns (this runs inside a rawReturn recipe).
  return Object.fromEntries(
    CODE_DOCK_PANEL_IDS.map((panel) => [
      panel,
      valid ? clampCodeDockColumnWeight(value[panel] as number) : current[panel],
    ]),
  ) as CodeDockColumnWeights
}

function storedCodeDockHeight(value: unknown, current: number): number {
  return clampCodeDockHeight(finiteNumberOrCurrent(value, current))
}

export function restoreStoredSiteEditorLayout(
  api: EditorStoreApi,
  layout: StoredWorkspaceLayout,
): void {
  api.setState((state) => {
    const propertiesOpen = boolOrCurrent(layout.rightOpen, !state.propertiesPanel.collapsed)
    const storedActivePanel = layout.activeLeftPanel
    const applyLeftPanel = storedActivePanel !== undefined
    const openLeftPanels = layout.openLeftPanels
    const isStoredOpen = (panel: LeftSidebarPanelId, current: boolean) => (
      openLeftPanels ? openLeftPanels.includes(panel) : current
    )

    const leftPanelPatch = applyLeftPanel
      ? {
          explorerPanelOpen: isStoredOpen('explorer', storedActivePanel === 'explorer'),
          selectorsPanelOpen: isStoredOpen('selectors', storedActivePanel === 'selectors'),
          frameworkPanelOpen: isStoredOpen('framework', storedActivePanel === 'framework'),
          dependenciesPanelOpen: isStoredOpen('dependencies', storedActivePanel === 'dependencies'),
        }
      : {}

    return rawReturn({
      propertiesPanel: {
        ...state.propertiesPanel,
        collapsed: !propertiesOpen,
        width: finiteNumberOrCurrent(layout.rightWidth, state.propertiesPanel.width),
      },
      propertiesPanelMode: propertiesMode(layout, state.propertiesPanelMode),
      leftPanelModes: storedLeftPanelModes(layout.leftPanelModes, state.leftPanelModes),
      leftSidebarWidth: leftSidebarWidth(layout, state.leftSidebarWidth),
      explorerPanelTab: explorerTab(layout.explorerPanelTab, state.explorerPanelTab),
      codeEditorPanelOpen: boolOrCurrent(layout.codeEditorPanelOpen, state.codeEditorPanelOpen),
      isAgentOpen: isStoredOpen('agent', state.isAgentOpen),
      activeEditorFileId: layout.activeEditorFileId !== undefined
        ? layout.activeEditorFileId
        : state.activeEditorFileId,
      godModeActive: boolOrCurrent(layout.godModeActive, state.godModeActive),
      codeDockHeight: storedCodeDockHeight(layout.codeDockHeight, state.codeDockHeight),
      codeDockPanels: storedCodeDockPanels(layout.codeDockPanels, state.codeDockPanels),
      codeDockActiveTab: storedCodeDockTab(layout.codeDockActiveTab, state.codeDockActiveTab),
      codeDockColumnWeights: storedCodeDockWeights(
        layout.codeDockColumnWeights,
        state.codeDockColumnWeights,
      ),
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

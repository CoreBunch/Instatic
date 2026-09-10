import { useEffect, useState } from 'react'
import { readWorkspaceLayout, writeWorkspaceLayout } from '@admin/state/workspaceLayoutStorage'
import type { ContentPanelId } from '../components/ContentSidebar/ContentSidebar'

const PANEL_IDS: ReadonlySet<ContentPanelId> = new Set(['content', 'media', 'agent'])
function initialPanel(): ContentPanelId | null {
  const stored = readWorkspaceLayout('content').activeLeftPanel
  if (stored === null) return null
  return typeof stored === 'string' && PANEL_IDS.has(stored as ContentPanelId) ? stored as ContentPanelId : 'content'
}

export function useContentPanel() {
  const [panel, setPanel] = useState<ContentPanelId | null>(initialPanel)
  useEffect(() => { writeWorkspaceLayout('content', { activeLeftPanel: panel }) }, [panel])
  return [panel, setPanel] as const
}

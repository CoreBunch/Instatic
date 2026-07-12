/**
 * Register the Plugin IDE's imperative tool surface and keep its MCP relay
 * connected for the entire SitePluginIdePage mount. Deliberately outside
 * PluginIdeAgentMount: opening or closing the AI panel must not decide
 * whether an external MCP client can reach the already-open IDE — same
 * policy as `useContentToolBridge`.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { sitePluginIdFromLocalId, type SitePluginSummary } from '@core/site-plugins'
import { useMcpWorkspaceBridge } from '@admin/ai/useMcpWorkspaceBridge'
import type { IdeCollabSession, IdeFileMeta } from '../ideCollab'
import { executePluginTool } from './pluginBridge'
import {
  setPluginIdeBridgeHandle,
  summarySnapshotFields,
  type PluginIdeAgentCurrentUser,
  type PluginIdeAgentSnapshot,
  type PluginIdeBridgeHandle,
} from './pluginBridgeHandle'

interface UsePluginIdeToolBridgeOptions {
  localId: string
  folder: string
  session: IdeCollabSession | null
  files: IdeFileMeta[]
  activeFile: { id: string; path: string } | null
  summary: SitePluginSummary | null
  /** null until the first validation run — distinct from "clean". */
  diagnostics: string[] | null
  selectFile: (fileId: string | null) => void
  canEdit: boolean
  currentUser: PluginIdeAgentCurrentUser
}

export function usePluginIdeToolBridge(options: UsePluginIdeToolBridgeOptions): void {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  const { localId } = options
  useEffect(() => {
    // File metas come from the LIVE session (the Y doc), never from React
    // state: back-to-back tool calls mutate and re-read without giving React
    // a render turn, so the state array lags one commit behind — a
    // create-then-describe would miss its own file. Same class of problem
    // the content bridge solves with flushSync; reading the CRDT directly is
    // the simpler correct answer here.
    const liveFiles = () => {
      const current = optionsRef.current
      return current.session?.pluginFiles() ?? current.files
    }
    const handle: PluginIdeBridgeHandle = {
      localId,
      buildSnapshot(): PluginIdeAgentSnapshot {
        const current = optionsRef.current
        return {
          localId,
          pluginId: sitePluginIdFromLocalId(localId),
          files: liveFiles().map((file) => ({
            id: file.id,
            path: file.path.slice(current.folder.length),
          })),
          activeFile: current.activeFile
            ? {
                id: current.activeFile.id,
                path: current.activeFile.path.slice(current.folder.length),
              }
            : null,
          ...summarySnapshotFields(current.summary),
          latestDiagnostics: current.diagnostics,
          currentUser: current.currentUser,
        }
      },
      session: () => optionsRef.current.session,
      files: liveFiles,
      selectFile: (fileId) => optionsRef.current.selectFile(fileId),
      canEdit: () => optionsRef.current.canEdit,
    }
    setPluginIdeBridgeHandle(handle)
    return () => {
      setPluginIdeBridgeHandle(null)
    }
  }, [localId])

  useMcpWorkspaceBridge('plugin', executePluginTool)
}

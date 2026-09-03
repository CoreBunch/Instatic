/**
 * FileTreePane — the Plugin IDE's file explorer.
 *
 * Composed from the SAME primitives as the Site Explorer / DOM panel trees:
 * the shared `Panel` shell (chrome, header, close) with `TreeRow` rows whose
 * interactive surface is a ghost Button (`TreeChevron` + `TreeIconSlot` +
 * `TreeLabelGroup`), F2/double-click inline rename, and the standard
 * point-anchored context menu. Peers editing a file show as identity
 * avatars on its row.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  TreeChevron,
  TreeContainer,
  TreeIconSlot,
  TreeLabel,
  TreeLabelGroup,
  TreeRow,
} from '@site/ui/Tree'
import { Panel } from '@admin/shared/Panel'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { sitePluginFolder } from '@core/site-plugins'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { PeerAvatar } from '@site/collab/PeerAvatar'
import type { IdeFileMeta } from './ideCollab'
import type { IdePeer } from './idePresence'
import styles from './FileTreePane.module.css'

interface TreeEntry {
  key: string
  kind: 'folder' | 'file'
  label: string
  depth: number
  fileId?: string
  /** Plugin-folder-relative path. */
  path: string
}

interface MenuState {
  x: number
  y: number
  entry: TreeEntry
}

/** Flatten paths into depth-annotated rows; folders derive from prefixes. */
function buildRows(
  files: IdeFileMeta[],
  folder: string,
  collapsed: ReadonlySet<string>,
): TreeEntry[] {
  const rows: TreeEntry[] = []
  const seenFolders = new Set<string>()
  for (const file of files) {
    const relative = file.path.slice(folder.length)
    const segments = relative.split('/')
    let prefix = ''
    let hidden = false
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const segment = segments[depth]!
      const folderPath = prefix ? `${prefix}/${segment}` : segment
      if (!hidden && !seenFolders.has(folderPath)) {
        seenFolders.add(folderPath)
        rows.push({
          key: `folder:${folderPath}`,
          kind: 'folder',
          label: segment,
          depth,
          path: folderPath,
        })
      }
      if (collapsed.has(folderPath)) hidden = true
      prefix = folderPath
    }
    if (!hidden) {
      rows.push({
        key: `file:${file.id}`,
        kind: 'file',
        label: segments[segments.length - 1] ?? relative,
        depth: segments.length - 1,
        fileId: file.id,
        path: relative,
      })
    }
  }
  return rows
}

interface FileTreePaneProps {
  localId: string
  /** The plugin's display name — the panel is titled with it so the IDE always says which plugin is open. */
  pluginName: string
  /** Active generated version (`1.0.<n>+<hash>`), shown muted beside the name; null before the first build. */
  activeVersion: string | null
  files: IdeFileMeta[]
  activeFileId: string | null
  peers: IdePeer[]
  canEdit: boolean
  /**
   * False until the live draft has synced. Creating, renaming, or deleting
   * before that would write into an unseeded doc — the session refuses it,
   * and the tree keeps the controls disabled with the reason.
   */
  ready: boolean
  onSelect: (fileId: string) => void
  onCreate: (relativePath: string) => void
  onRename: (fileId: string, relativePath: string) => void
  onDelete: (fileId: string) => void
  onClose: () => void
}

export function FileTreePane({
  localId,
  pluginName,
  activeVersion,
  files,
  activeFileId,
  peers,
  canEdit,
  ready,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onClose,
}: FileTreePaneProps) {
  const folder = sitePluginFolder(localId)
  const canMutate = canEdit && ready
  const mutateBlockedReason = !canEdit
    ? 'Requires the plugins.edit permission'
    : !ready
      ? 'Connecting to the live draft…'
      : null
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [pendingNew, setPendingNew] = useState<string | null>(null) // parent folder ('' = root)
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const rows = buildRows(files, folder, collapsed)
  const peersByFileId = new Map<string, IdePeer[]>()
  for (const peer of peers) {
    if (!peer.ideFile) continue
    const bucket = peersByFileId.get(peer.ideFile.fileId) ?? []
    bucket.push(peer)
    peersByFileId.set(peer.ideFile.fileId, bucket)
  }

  const toggleFolder = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openMenu = (event: MouseEvent, entry: TreeEntry): void => {
    if (!canMutate) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }

  const submitNew = (relativePath: string): void => {
    setPendingNew(null)
    const trimmed = relativePath.trim()
    if (!trimmed) return
    try {
      onCreate(trimmed)
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Could not create file',
        body: getErrorMessage(err, 'Invalid path'),
      })
    }
  }

  const submitRename = (fileId: string, relativePath: string): void => {
    setRenamingFileId(null)
    const trimmed = relativePath.trim()
    if (!trimmed) return
    try {
      onRename(fileId, trimmed)
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Could not rename file',
        body: getErrorMessage(err, 'Invalid path'),
      })
    }
  }

  return (
    <Panel
      panelId="ide-files"
      title={pluginName}
      titleContent={(
        <span className={styles.titleContent}>
          <span className={styles.titleName}>{pluginName}</span>
          {activeVersion && (
            // The generated version is `1.0.<n>+<content hash>`; the hash is
            // for the build's skip check, not for people.
            <span className={styles.titleVersion} title={activeVersion}>
              v{activeVersion.replace(/\+.*$/, '')}
            </span>
          )}
        </span>
      )}
      ariaLabel={`${pluginName} files`}
      testId="ide-file-tree"
      body="bare"
      bodyClassName={styles.body}
      onClose={onClose}
      headerActions={(
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="New file"
          tooltip={mutateBlockedReason ?? 'New file'}
          disabled={!canMutate}
          onClick={() => setPendingNew('')}
          data-testid="ide-new-file"
        >
          <FilePlusSolidIcon size={14} aria-hidden="true" />
        </Button>
      )}
    >
      <div className={styles.tree}>
        <TreeContainer ariaLabel="Site plugin files">
          {rows.map((entry) => {
            const filePeers = entry.fileId ? (peersByFileId.get(entry.fileId) ?? []) : []
            const isRenaming = entry.kind === 'file' && renamingFileId === entry.fileId
            return (
              <TreeRow
                key={entry.key}
                depth={entry.depth}
                selected={entry.kind === 'file' && entry.fileId === activeFileId}
                role="treeitem"
                aria-label={entry.label}
                aria-level={entry.depth + 1}
                aria-expanded={entry.kind === 'folder' ? !collapsed.has(entry.path) : undefined}
                data-testid={entry.kind === 'file' ? 'ide-file-row' : 'ide-folder-row'}
                data-path={entry.path}
              >
                {isRenaming ? (
                  <>
                    <TreeIconSlot icon={FileTextSolidIcon} iconSize={12} />
                    <InlineRenameInput
                      value={entry.path}
                      ariaLabel={`Rename ${entry.label}`}
                      onCommit={(value) => submitRename(entry.fileId!, value)}
                      onCancel={() => setRenamingFileId(null)}
                    />
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    align="start"
                    className={styles.treeRowButton}
                    aria-label={entry.label}
                    onClick={() => {
                      if (entry.kind === 'folder') toggleFolder(entry.path)
                      else if (entry.fileId) onSelect(entry.fileId)
                    }}
                    onContextMenu={(event) => openMenu(event, entry)}
                    onDoubleClick={(event) => {
                      if (entry.kind !== 'file' || !canMutate) return
                      event.preventDefault()
                      event.stopPropagation()
                      setRenamingFileId(entry.fileId ?? null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'F2' && entry.kind === 'file' && canMutate) {
                        event.preventDefault()
                        event.stopPropagation()
                        setRenamingFileId(entry.fileId ?? null)
                      }
                    }}
                  >
                    {entry.kind === 'folder' ? (
                      <>
                        <TreeChevron expanded={!collapsed.has(entry.path)} />
                        <TreeIconSlot icon={FolderGlyphIcon} iconSize={12} />
                      </>
                    ) : (
                      <TreeIconSlot icon={FileTextSolidIcon} iconSize={12} />
                    )}
                    <TreeLabelGroup>
                      <TreeLabel>{entry.label}</TreeLabel>
                    </TreeLabelGroup>
                    {filePeers.length > 0 && (
                      <span
                        className={styles.rowPeers}
                        aria-label={`${filePeers.length} peer(s) editing this file`}
                      >
                        {filePeers.slice(0, 3).map((peer) => (
                          <PeerAvatar key={peer.clientId} user={peer.user} size={14} />
                        ))}
                      </span>
                    )}
                  </Button>
                )}
              </TreeRow>
            )
          })}

          {pendingNew !== null && (
            <TreeRow depth={pendingNew === '' ? 0 : pendingNew.split('/').length}>
              <TreeIconSlot icon={FilePlusSolidIcon} iconSize={12} />
              <InlineRenameInput
                value={pendingNew === '' ? '' : `${pendingNew}/`}
                placeholder="path/to/file.ts"
                ariaLabel="New file path"
                onCommit={submitNew}
                onCancel={() => setPendingNew(null)}
              />
            </TreeRow>
          )}
        </TreeContainer>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="File actions"
          onClose={() => setMenu(null)}
        >
          {menu.entry.kind === 'folder' ? (
            <ContextMenuItem
              onClick={() => {
                setPendingNew(menu.entry.path)
                setMenu(null)
              }}
            >
              New file…
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem
                onClick={() => {
                  setRenamingFileId(menu.entry.fileId ?? null)
                  setMenu(null)
                }}
              >
                Rename…
              </ContextMenuItem>
              <ContextMenuItem
                danger
                disabled={menu.entry.path === 'plugin.json'}
                tooltip={
                  menu.entry.path === 'plugin.json'
                    ? 'plugin.json is required — delete the whole site plugin instead'
                    : undefined
                }
                onClick={() => {
                  if (menu.entry.fileId) onDelete(menu.entry.fileId)
                  setMenu(null)
                }}
              >
                Delete file
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>
      )}
    </Panel>
  )
}

interface InlineRenameInputProps {
  value: string
  ariaLabel: string
  placeholder?: string
  onCommit: (value: string) => void
  onCancel: () => void
}

/** Same behavior as the Site Explorer's inline rename: select-all on mount,
 *  Enter commits, Escape cancels, blur commits (empty cancels). */
function InlineRenameInput({
  value,
  ariaLabel,
  placeholder,
  onCommit,
  onCancel,
}: InlineRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function commit(): void {
    const trimmed = inputRef.current?.value.trim() ?? ''
    if (!trimmed) {
      onCancel()
      return
    }
    onCommit(trimmed)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      commit()
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <Input
      ref={inputRef}
      fieldSize="xs"
      autoFocus
      defaultValue={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

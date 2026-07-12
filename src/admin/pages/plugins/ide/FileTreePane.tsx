/**
 * FileTreePane — the Plugin IDE's file explorer.
 *
 * Rows derive from the plugin's live co-edited file list (folders inferred
 * from paths), rendered with the shared Tree primitives. Context menu on
 * rows offers new file, rename, and delete; new/rename edit inline. Peers
 * editing a file show as identity-colored avatars on its row.
 */
import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import {
  TreeChevron,
  TreeContainer,
  TreeIconSlot,
  TreeLabel,
  TreeLabelGroup,
  TreeRow,
} from '@site/ui/Tree'
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
  files: IdeFileMeta[]
  activeFileId: string | null
  peers: IdePeer[]
  canEdit: boolean
  onSelect: (fileId: string) => void
  onCreate: (relativePath: string) => void
  onRename: (fileId: string, relativePath: string) => void
  onDelete: (fileId: string) => void
}

export function FileTreePane({
  localId,
  files,
  activeFileId,
  peers,
  canEdit,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: FileTreePaneProps) {
  const folder = sitePluginFolder(localId)
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
    if (!canEdit) return
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
    <div className={styles.pane} data-testid="ide-file-tree">
      <header className={styles.header}>
        <span className={styles.title}>Files</span>
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label="New file"
          tooltip={canEdit ? 'New file' : 'Editing requires the site structure permission'}
          disabled={!canEdit}
          onClick={() => setPendingNew('')}
          data-testid="ide-new-file"
        >
          <FilePlusSolidIcon size={14} aria-hidden="true" />
        </Button>
      </header>

      <div className={styles.tree}>
        <TreeContainer ariaLabel="Site plugin files">
          {rows.map((entry) => {
            const filePeers = entry.fileId ? (peersByFileId.get(entry.fileId) ?? []) : []
            return (
              <TreeRow
                key={entry.key}
                depth={entry.depth}
                selected={entry.kind === 'file' && entry.fileId === activeFileId}
                onClick={() => {
                  if (entry.kind === 'folder') toggleFolder(entry.path)
                  else if (entry.fileId) onSelect(entry.fileId)
                }}
                onContextMenu={(event) => openMenu(event, entry)}
                data-testid={entry.kind === 'file' ? 'ide-file-row' : 'ide-folder-row'}
                data-path={entry.path}
              >
                {entry.kind === 'folder' ? (
                  <>
                    <TreeChevron expanded={!collapsed.has(entry.path)} />
                    <TreeIconSlot>
                      <FolderGlyphIcon size={12} aria-hidden="true" />
                    </TreeIconSlot>
                  </>
                ) : (
                  <TreeIconSlot>
                    <FileTextSolidIcon size={12} aria-hidden="true" />
                  </TreeIconSlot>
                )}
                <TreeLabelGroup>
                  {entry.kind === 'file' && renamingFileId === entry.fileId ? (
                    <InlinePathInput
                      defaultValue={entry.path}
                      onSubmit={(value) => submitRename(entry.fileId!, value)}
                      onCancel={() => setRenamingFileId(null)}
                    />
                  ) : (
                    <TreeLabel>{entry.label}</TreeLabel>
                  )}
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
              </TreeRow>
            )
          })}

          {pendingNew !== null && (
            <TreeRow depth={pendingNew === '' ? 0 : pendingNew.split('/').length}>
              <TreeIconSlot>
                <FilePlusSolidIcon size={12} aria-hidden="true" />
              </TreeIconSlot>
              <TreeLabelGroup>
                <InlinePathInput
                  defaultValue={pendingNew === '' ? '' : `${pendingNew}/`}
                  placeholder="path/to/file.ts"
                  onSubmit={submitNew}
                  onCancel={() => setPendingNew(null)}
                />
              </TreeLabelGroup>
            </TreeRow>
          )}
        </TreeContainer>
      </div>

      <footer className={styles.footer}>
        <p className={styles.hint}>
          Files live in <code>{folder}</code> and save live — every open
          editor co-edits the same draft.
        </p>
      </footer>

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
    </div>
  )
}

interface InlinePathInputProps {
  defaultValue: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

function InlinePathInput({ defaultValue, placeholder, onSubmit, onCancel }: InlinePathInputProps) {
  const [value, setValue] = useState(defaultValue)
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onSubmit(value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }
  return (
    <Input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label="File path"
      className={styles.inlineInput}
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={handleKeyDown}
      onBlur={onCancel}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

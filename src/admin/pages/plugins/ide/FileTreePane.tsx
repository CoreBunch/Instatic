/**
 * FileTreePane — the Plugin IDE's file explorer.
 *
 * Composed from the SAME primitives as the Layers panel and the Site
 * Explorer: the shared `Panel` shell (chrome, header, close), `TreeGroup`
 * subtrees (a folder row plus its children — one raised surface while the
 * folder is the selection), `TreeRow` rows whose interactive surface is a
 * ghost Button, F2/double-click inline rename, and the standard
 * point-anchored context menu. Folders carry their chevron at the end of
 * the row so files and folders at one depth share the same left edge. Peers
 * editing a file show as identity avatars on its row.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  TreeChevron,
  TreeContainer,
  TreeGroup,
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
import { sitePluginDisplayVersion, sitePluginFolder } from '@core/site-plugins'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { PeerAvatar } from '@site/collab/PeerAvatar'
import type { IdeFileMeta } from './ideCollab'
import type { IdePeer } from './idePresence'
import styles from './FileTreePane.module.css'

interface FolderEntry {
  kind: 'folder'
  label: string
  /** Plugin-folder-relative path. */
  path: string
  children: TreeEntry[]
}

interface FileEntry {
  kind: 'file'
  label: string
  path: string
  fileId: string
}

type TreeEntry = FolderEntry | FileEntry

interface MenuState {
  x: number
  y: number
  entry: TreeEntry
}

const ROOT = ''

function compareLabels(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
}

/** Nest plugin-relative paths into folders; folders first, then files, by name. */
function buildTree(files: IdeFileMeta[], folder: string): TreeEntry[] {
  const root: FolderEntry = { kind: 'folder', label: ROOT, path: ROOT, children: [] }
  const folders = new Map<string, FolderEntry>([[ROOT, root]])
  for (const file of files) {
    const relative = file.path.slice(folder.length)
    const segments = relative.split('/')
    let parent = root
    for (let depth = 0; depth < segments.length - 1; depth++) {
      const segment = segments[depth]!
      const path = parent.path ? `${parent.path}/${segment}` : segment
      let next = folders.get(path)
      if (!next) {
        next = { kind: 'folder', label: segment, path, children: [] }
        folders.set(path, next)
        parent.children.push(next)
      }
      parent = next
    }
    parent.children.push({
      kind: 'file',
      label: segments[segments.length - 1] ?? relative,
      path: relative,
      fileId: file.id,
    })
  }
  for (const entry of folders.values()) entry.children.sort(compareLabels)
  return root.children
}

function parentFolderOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut === -1 ? ROOT : relativePath.slice(0, cut)
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
  // The folder the user last clicked. Like a selected container in the
  // Layers panel, its expanded subtree paints as one surface. Selecting a
  // file hands the selection back to the file.
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [pendingNew, setPendingNew] = useState<string | null>(null) // parent folder ('' = root)
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const tree = buildTree(files, folder)
  const peersByFileId = new Map<string, IdePeer[]>()
  for (const peer of peers) {
    if (!peer.ideFile) continue
    const bucket = peersByFileId.get(peer.ideFile.fileId) ?? []
    bucket.push(peer)
    peersByFileId.set(peer.ideFile.fileId, bucket)
  }

  const expand = (path: string): void => {
    setCollapsed((current) => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
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

  const startNewFile = (parentFolder: string): void => {
    expand(parentFolder)
    setPendingNew(parentFolder)
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

  const renderRowButton = (entry: TreeEntry, expanded: boolean, children: ReactNode) => (
    <Button
      variant="ghost"
      size="sm"
      align="start"
      className={styles.treeRowButton}
      aria-label={entry.label}
      onClick={() => {
        if (entry.kind === 'folder') {
          setSelectedFolder(entry.path)
          toggleFolder(entry.path)
        } else {
          setSelectedFolder(null)
          onSelect(entry.fileId)
        }
      }}
      onContextMenu={(event) => openMenu(event, entry)}
      onDoubleClick={(event) => {
        if (entry.kind !== 'file' || !canMutate) return
        event.preventDefault()
        event.stopPropagation()
        setRenamingFileId(entry.fileId)
      }}
      onKeyDown={(event) => {
        if (event.key === 'F2' && entry.kind === 'file' && canMutate) {
          event.preventDefault()
          event.stopPropagation()
          setRenamingFileId(entry.fileId)
        }
      }}
    >
      {children}
      {entry.kind === 'folder' && <TreeChevron expanded={expanded} className={styles.chevronEnd} />}
    </Button>
  )

  const renderPendingNew = (parentFolder: string, depth: number) => (
    <TreeRow depth={depth} data-testid="ide-new-file-row">
      <TreeIconSlot icon={FilePlusSolidIcon} iconSize={12} />
      <InlineRenameInput
        value={parentFolder === ROOT ? '' : `${parentFolder}/`}
        placeholder="path/to/file.ts"
        ariaLabel="New file path"
        onCommit={submitNew}
        onCancel={() => setPendingNew(null)}
      />
    </TreeRow>
  )

  const renderFile = (entry: FileEntry, depth: number) => {
    const filePeers = peersByFileId.get(entry.fileId) ?? []
    const isRenaming = renamingFileId === entry.fileId
    return (
      <TreeRow
        key={`file:${entry.fileId}`}
        depth={depth}
        selected={entry.fileId === activeFileId}
        role="treeitem"
        aria-label={entry.label}
        aria-level={depth + 1}
        data-testid="ide-file-row"
        data-path={entry.path}
      >
        {isRenaming ? (
          <>
            <TreeIconSlot icon={FileTextSolidIcon} iconSize={12} />
            <InlineRenameInput
              value={entry.path}
              ariaLabel={`Rename ${entry.label}`}
              onCommit={(value) => submitRename(entry.fileId, value)}
              onCancel={() => setRenamingFileId(null)}
            />
          </>
        ) : (
          renderRowButton(entry, false, (
            <>
              <TreeIconSlot icon={FileTextSolidIcon} iconSize={12} />
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
            </>
          ))
        )}
      </TreeRow>
    )
  }

  const renderFolder = (entry: FolderEntry, depth: number) => {
    const expanded = !collapsed.has(entry.path)
    const selected = selectedFolder === entry.path
    return (
      <TreeGroup key={`folder:${entry.path}`} open={selected && expanded} data-path={entry.path}>
        <TreeRow
          depth={depth}
          selected={selected}
          role="treeitem"
          aria-label={entry.label}
          aria-level={depth + 1}
          aria-expanded={expanded}
          data-testid="ide-folder-row"
          data-path={entry.path}
        >
          {renderRowButton(entry, expanded, (
            <>
              <TreeIconSlot icon={FolderGlyphIcon} iconSize={12} />
              <TreeLabelGroup>
                <TreeLabel>{entry.label}</TreeLabel>
              </TreeLabelGroup>
            </>
          ))}
        </TreeRow>
        {expanded && (
          <div role="group">
            {renderEntries(entry.children, depth + 1)}
            {pendingNew === entry.path && renderPendingNew(entry.path, depth + 1)}
          </div>
        )}
      </TreeGroup>
    )
  }

  const renderEntries = (entries: TreeEntry[], depth: number) =>
    entries.map((entry) => (entry.kind === 'folder' ? renderFolder(entry, depth) : renderFile(entry, depth)))

  return (
    <Panel
      panelId="ide-files"
      title={pluginName}
      titleContent={(
        <span className={styles.titleContent}>
          <span className={styles.titleName}>{pluginName}</span>
          {activeVersion && (
            <span className={styles.titleVersion} title={activeVersion}>
              v{sitePluginDisplayVersion(activeVersion)}
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
          onClick={() => startNewFile(ROOT)}
          data-testid="ide-new-file"
        >
          <FilePlusSolidIcon size={14} aria-hidden="true" />
        </Button>
      )}
    >
      <div className={styles.tree}>
        <TreeContainer ariaLabel="Site plugin files">
          {renderEntries(tree, 0)}
          {pendingNew === ROOT && renderPendingNew(ROOT, 0)}
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
                startNewFile(menu.entry.path)
                setMenu(null)
              }}
            >
              New file…
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem
                onClick={() => {
                  startNewFile(parentFolderOf(menu.entry.path))
                  setMenu(null)
                }}
              >
                New file here…
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  setRenamingFileId(menu.entry.kind === 'file' ? menu.entry.fileId : null)
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
                  if (menu.entry.kind === 'file') onDelete(menu.entry.fileId)
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

/**
 * FontsSection — site fonts library shown at the top of the Typography panel.
 *
 * Lists every font installed on the site and lets the user add another from
 * Google's directory (custom uploads are a planned next step). All file work
 * happens on the server: this component only mutates `site.settings.fonts`
 * via the `addFont` / `removeFont` zustand actions and triggers the install /
 * uninstall HTTP endpoints.
 *
 * The section embeds into `FrameworkScalePanel` via the `extraSections` slot;
 * see `TypographyPanel.tsx` for the wiring.
 */

import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { SplitButton, type SplitButtonMenuItem } from '@ui/components/SplitButton'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { useInstalledFontFaces } from '@site/hooks/useInstalledFontFaces'
import type { FontEntry, FontToken } from '@core/fonts'
import { compareVariants } from '@core/fonts'
import {
  defaultFontTokenFallback,
  resolveFontTokenStack,
  sortFontTokens,
} from '@core/fonts'
import { deleteCmsFontFamily } from '@core/persistence/cmsFonts'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { AddGoogleFontDialog } from './AddGoogleFontDialog'
import { AddCustomFontDialog } from './AddCustomFontDialog'
import { FontTokenDialog } from './FontTokenDialog'
import styles from './FontsSection.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const EMPTY_FONTS: FontEntry[] = []
const EMPTY_TOKENS: FontToken[] = []

export function FontsSection() {
  const fonts = useEditorStore((s) => s.site?.settings.fonts?.items ?? EMPTY_FONTS)
  const fontTokens = useEditorStore((s) => s.site?.settings.fonts?.tokens ?? EMPTY_TOKENS)
  const addFont = useEditorStore((s) => s.addFont)
  const removeFont = useEditorStore((s) => s.removeFont)
  const createFontToken = useEditorStore((s) => s.createFontToken)
  const updateFontToken = useEditorStore((s) => s.updateFontToken)
  const deleteFontToken = useEditorStore((s) => s.deleteFontToken)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [editEntry, setEditEntry] = useState<FontEntry | null>(null)
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [editToken, setEditToken] = useState<FontToken | null>(null)

  useInstalledFontFaces(fonts, 'instatic-admin-installed-fonts')

  const installedFamiliesLower = new Set(fonts.map((f) => f.family.toLowerCase()))

  // When editing, the font being edited is already installed — exclude its own
  // family from the dedup set so keeping the same name isn't flagged as taken.
  const editInstalledFamilies = editEntry
    ? new Set([...installedFamiliesLower].filter((f) => f !== editEntry.family.toLowerCase()))
    : installedFamiliesLower

  function ensureTokenForFont(entry: FontEntry) {
    const currentTokens = useEditorStore.getState().site?.settings.fonts?.tokens ?? EMPTY_TOKENS
    if (currentTokens.some((token) => token.familyId === entry.id)) return
    const tokenName = currentTokens.length === 0 ? 'Primary' : entry.family
    createFontToken({
      name: tokenName,
      variable: tokenName,
      familyId: entry.id,
      fallback: defaultFontTokenFallback(entry),
    })
  }

  function handleEdited(entry: FontEntry) {
    const committed = addFont(entry)
    setEditEntry(null)
    ensureTokenForFont(committed)
  }

  function handleInstalled(entry: FontEntry) {
    const committed = addFont(entry)
    ensureTokenForFont(committed)
  }

  async function handleRemove(entry: FontEntry) {
    // Optimistically drop the entry from the library — the on-disk woff2 files
    // are best-effort to delete; a stale folder is harmless and gets pruned on
    // the next install of the same family.
    const removed = removeFont(entry.id)
    if (!removed) {
      pushToast({
        kind: 'error',
        title: 'Font still in use',
        body: 'Reassign or delete the font tokens that reference this family before removing it.',
      })
      return
    }
    if (entry.source === 'google') {
      try {
        await deleteCmsFontFamily(entry.family)
      } catch (err) {
        console.error('[FontsSection] delete font files failed:', err)
        pushToast({
          kind: 'error',
          title: 'Could not delete font files',
          body: getErrorMessage(err, 'Unknown font deletion error'),
        })
      }
    }
  }

  function handleTokenSave(input: { name: string; variable: string; familyId?: string | null; fallback: string }) {
    if (editToken) {
      updateFontToken(editToken.id, input)
      setEditToken(null)
    } else {
      createFontToken(input)
      setTokenDialogOpen(false)
    }
  }

  function openCreateTokenDialog() {
    setEditToken(null)
    setTokenDialogOpen(true)
  }

  const sortedTokens = sortFontTokens(fontTokens)

  // Single add-font affordance: a primary "Add Google font" button fused to a
  // chevron that drops down both install paths. Reused by the empty state and
  // the "Installed font files" header so the action reads the same everywhere.
  const addFontMenuItems: SplitButtonMenuItem[] = [
    {
      id: 'google',
      label: 'Add Google font',
      icon: PlusIcon,
      onSelect: () => setDialogOpen(true),
      testId: 'fonts-add-google-font-item',
    },
    {
      id: 'custom',
      label: 'Upload custom font',
      icon: UploadIcon,
      onSelect: () => setCustomDialogOpen(true),
      testId: 'fonts-upload-custom-font-item',
    },
  ]

  const addFontButton = (
    <SplitButton
      label="Add Google font"
      onClick={() => setDialogOpen(true)}
      menuItems={addFontMenuItems}
      menuTriggerLabel="More font options"
      menuLabel="Add a font"
      primaryTestId="fonts-add-google-font-btn"
      menuTriggerTestId="fonts-add-font-trigger"
      menuTestId="fonts-add-font-menu"
    />
  )

  return (
    <div className={styles.section}>
      {fonts.length === 0 && sortedTokens.length === 0 ? (
        // Mirror the "No <kind> scales yet." empty state used in the Scales
        // section so the two empty states inside the Typography panel read
        // consistently. The CTA is the same split add-font control used in the
        // "Installed font files" header.
        <EmptyState
          plain
          compact
          title="No fonts installed yet."
          action={addFontButton}
        />
      ) : (
        <>
          <div className={styles.tokenToolbar}>
            <span className={styles.tokenToolbarTitle}>Font tokens</span>
            {sortedTokens.length > 0 && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={openCreateTokenDialog}
              >
                Create token
              </Button>
            )}
          </div>

          {sortedTokens.length === 0 ? (
            <EmptyState
              plain
              compact
              title="No font tokens yet."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={openCreateTokenDialog}
                >
                  Create token
                </Button>
              }
            />
          ) : (
            <ul className={styles.list} aria-label="Font tokens">
              {sortedTokens.map((token) => (
                <FontTokenRow
                  key={token.id}
                  token={token}
                  fonts={fonts}
                  onEdit={() => setEditToken(token)}
                  onRemove={() => { deleteFontToken(token.id) }}
                />
              ))}
            </ul>
          )}

          <div className={styles.tokenToolbar}>
            <span className={styles.tokenToolbarTitle}>Installed fonts</span>
            {addFontButton}
          </div>

          {fonts.length === 0 ? (
            <EmptyState plain compact title="No fonts installed yet." />
          ) : (
            <ul className={styles.assetList} aria-label="Installed fonts">
              {fonts.map((entry) => (
                <FontRow
                  key={entry.id}
                  entry={entry}
                  onEdit={() => setEditEntry(entry)}
                  onRemove={() => { void handleRemove(entry) }}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {dialogOpen && (
        <AddGoogleFontDialog
          installedFamilies={installedFamiliesLower}
          onCancel={() => setDialogOpen(false)}
          onInstalled={(entry) => {
            handleInstalled(entry)
            setDialogOpen(false)
          }}
        />
      )}

      {customDialogOpen && (
        <AddCustomFontDialog
          installedFamilies={installedFamiliesLower}
          onCancel={() => setCustomDialogOpen(false)}
          onInstalled={(entry) => {
            handleInstalled(entry)
            setCustomDialogOpen(false)
          }}
        />
      )}

      {editEntry?.source === 'google' && (
        <AddGoogleFontDialog
          editEntry={editEntry}
          installedFamilies={editInstalledFamilies}
          onCancel={() => setEditEntry(null)}
          onInstalled={handleEdited}
        />
      )}

      {editEntry?.source === 'custom' && (
        <AddCustomFontDialog
          editEntry={editEntry}
          installedFamilies={editInstalledFamilies}
          onCancel={() => setEditEntry(null)}
          onInstalled={handleEdited}
        />
      )}

      {(tokenDialogOpen || editToken) && (
        <FontTokenDialog
          token={editToken ?? undefined}
          fonts={fonts}
          onCancel={() => {
            setTokenDialogOpen(false)
            setEditToken(null)
          }}
          onSave={handleTokenSave}
        />
      )}
    </div>
  )
}

interface FontTokenRowProps {
  token: FontToken
  fonts: FontEntry[]
  onEdit: () => void
  onRemove: () => void
}

function FontTokenRow({
  token,
  fonts,
  onEdit,
  onRemove,
}: FontTokenRowProps) {
  const familyStack = resolveFontTokenStack(token, { items: fonts, tokens: [token] })
  const assigned = token.familyId ? fonts.find((entry) => entry.id === token.familyId) : undefined
  const variable = `--${token.variable}`

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span
          className={styles.rowFamily}
          style={{ fontFamily: familyStack } as CSSProperties}
        >
          {token.name}
        </span>
        <span className={styles.rowMeta}>
          {variable}
          {' · '}
          {assigned?.family ?? token.fallback}
        </span>
      </div>
      <div className={styles.rowActions}>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Edit ${token.name}`}
          tooltip={`Edit ${token.name}`}
          onClick={onEdit}
        >
          <EditSolidIcon size={12} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Delete ${token.name}`}
          tooltip={`Delete ${token.name}`}
          onClick={onRemove}
        >
          <TrashSolidIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}

interface FontRowProps {
  entry: FontEntry
  onEdit: () => void
  onRemove: () => void
}

function FontRow({ entry, onEdit, onRemove }: FontRowProps) {
  const variants = entry.variants.toSorted(compareVariants)
  const variantSummary =
    variants.length === 0
      ? ''
      : variants.length <= 3
        ? variants.join(', ')
        : `${variants.slice(0, 3).join(', ')}, +${variants.length - 3}`

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span
          className={styles.rowFamily}
          style={{ fontFamily: `"${entry.family}", system-ui, sans-serif` } as CSSProperties}
        >
          {entry.family}
        </span>
        <span className={styles.rowMeta}>
          {entry.source === 'google' ? 'Google' : 'Custom'}
          {variantSummary && ` · ${variantSummary}`}
          {entry.subsets.length > 0 && ` · ${entry.subsets.length} subset${entry.subsets.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className={styles.rowActions}>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Edit ${entry.family}`}
          tooltip={`Edit ${entry.family}`}
          onClick={onEdit}
        >
          <EditSolidIcon size={12} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={`Remove ${entry.family}`}
          tooltip={`Remove ${entry.family}`}
          onClick={onRemove}
        >
          <TrashSolidIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}

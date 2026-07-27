/**
 * PageAccessDialog — per-page access control (Phase 3 — D14).
 *
 * Opened from the Site Explorer page context menu ("Page access…"). Sets a
 * page's access level: **Public** (anyone) or **Restricted to groups** (a
 * logged-in visitor in ANY of the selected member groups may view the page;
 * everyone else is gated — anonymous → login, logged-in-but-not-in-group →
 * the built-in "no access" page).
 *
 * Loads the visitor group list (the same list the Members workspace manages)
 * so the group multi-select shows real, current groups. Writes the resolved
 * access through {@link PageAccessPayload}, which the Site Explorer commits to
 * the page via the `setPageAccess` store action (mirroring how template
 * settings are committed via `convertPageToTemplate`).
 */
import { useState, type FormEvent } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import type { Page, PageAccess } from '@core/page-tree'
import { listVisitorGroups, type VisitorGroup } from '@core/persistence'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { Select } from '@ui/components/Select'
import dialogStyles from '../SiteCreateDialog/SiteCreateDialog.module.css'

export interface PageAccessPayload {
  access: PageAccess
}

interface PageAccessDialogProps {
  page: Page
  onCancel: () => void
  onSave: (payload: PageAccessPayload) => void
}

/** Segmented access level — mirrors the `PageAccess['level']` union. */
type AccessLevel = 'public' | 'groups'

const FORM_ID = 'page-access-form'

const LEVEL_OPTIONS = [
  { value: 'public', label: 'Public — anyone' },
  { value: 'groups', label: 'Restricted — specific member groups' },
]

/**
 * Resolve the page's current access level + selected group ids for the form's
 * initial state. A missing `access` field (every pre-Phase-3 page) is public.
 */
function initialAccess(page: Page): { level: AccessLevel; groupIds: string[] } {
  if (page.access?.level === 'groups') {
    return { level: 'groups', groupIds: [...(page.access.groups ?? [])] }
  }
  return { level: 'public', groupIds: [] }
}

export function PageAccessDialog({ page, onCancel, onSave }: PageAccessDialogProps) {
  const initial = initialAccess(page)
  const [level, setLevel] = useState<AccessLevel>(initial.level)
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set(initial.groupIds))

  // Load the visitor group list for the multi-select. Best-effort: a failed
  // load leaves an empty list (the admin can still set the level to public).
  const { data: groups } = useAsyncResource(
    () => listVisitorGroups(),
    [],
    { swallowErrors: true },
  )
  const loadedGroups: VisitorGroup[] = groups ?? []

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      const next = new Set(current)
      if (checked) next.add(groupId)
      else next.delete(groupId)
      return next
    })
  }

  const groupsEmpty = level === 'groups' && selectedGroupIds.size === 0

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (groupsEmpty) return
    const groupIds = [...selectedGroupIds]
    // Public (or an empty groups list) is committed as `{ level: 'public' }`;
    // the `setPageAccess` store action normalises both to the field's absence.
    onSave({ access: { level, groups: groupIds } })
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Page access"
      eyebrow={page.title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form={FORM_ID} disabled={groupsEmpty}>
            Save
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor="page-access-level" className={dialogStyles.label}>Who can view this page</label>
          <Select
            id="page-access-level"
            aria-label="Who can view this page"
            fieldSize="sm"
            value={level}
            options={LEVEL_OPTIONS}
            onChange={(event) => setLevel(event.target.value as AccessLevel)}
          />
        </div>

        {level === 'groups' && (
          <div className={dialogStyles.field}>
            <span className={dialogStyles.label}>Allowed groups</span>
            {loadedGroups.length > 0 ? (
              loadedGroups.map((group) => (
                <label key={group.id} className={dialogStyles.checkboxRow}>
                  <Checkbox
                    checked={selectedGroupIds.has(group.id)}
                    onCheckedChange={(checked) => toggleGroup(group.id, checked)}
                    aria-label={group.name}
                  />
                  <span>{group.name}</span>
                </label>
              ))
            ) : (
              <p className={dialogStyles.errorText}>
                No member groups exist yet. Create one on the Members page first.
              </p>
            )}
            {groupsEmpty && loadedGroups.length > 0 && (
              <p role="alert" className={dialogStyles.errorText}>Select at least one group.</p>
            )}
          </div>
        )}
      </form>
    </Dialog>
  )
}

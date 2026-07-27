/**
 * AssignGroupsDialog — pick a visitor's member-group memberships + primary
 * group (Phase 3 — D13/D15).
 *
 * Opened from the Visitors table's "Groups" cell. Lists every visitor group
 * with a membership checkbox; among the checked groups, one can be designated
 * the visitor's primary group (D15 — drives the login landing path). Reads
 * the current membership set on open via {@link getVisitorGroups}, writes the
 * full set via {@link setVisitorGroups} (the PUT replaces the membership set
 * wholesale).
 *
 * Mirrors the shared-dialog form/field styling; the primary-group picker uses
 * the `Select` primitive (only the checked groups are selectable, plus a
 * "None" option to clear the primary).
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { Select } from '@ui/components/Select'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { getVisitorGroups, setVisitorGroups, type AdminVisitorUser, type VisitorGroup } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import dialogStyles from '@admin/shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'

interface AssignGroupsDialogProps {
  user: AdminVisitorUser
  /** Every visitor group (for the membership checkboxes + primary picker). */
  groups: VisitorGroup[]
  onClose: () => void
  /** Fired after a successful save with the resolved membership group ids + primary id. */
  onSaved: (result: { groupIds: string[]; primaryGroupId: string | null }) => void
}

/** Sentinel value used by the primary-group `<Select>` for "no primary". */
const NO_PRIMARY = '__none__'

export function AssignGroupsDialog({ user, groups, onClose, onSaved }: AssignGroupsDialogProps) {
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [primaryId, setPrimaryId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load the current membership set on open. The primary group is whichever
  // membership carries `isPrimary === true`. The dialog is remounted per user
  // (keyed by id in VisitorsTable), so `loading` starts `true` and only flips
  // `false` inside the async callbacks — no synchronous setState in the body.
  useEffect(() => {
    let cancelled = false
    getVisitorGroups(user.id)
      .then(({ groups: memberships }) => {
        if (cancelled) return
        const ids = new Set(memberships.map((m) => m.group.id))
        const primary = memberships.find((m) => m.isPrimary)?.group.id ?? null
        setSelected(ids)
        // Guard against a stale primary that is no longer a membership (a
        // server-side race); the select only offers current memberships.
        setPrimaryId(primary && ids.has(primary) ? primary : null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(getErrorMessage(err, 'Could not load this visitor\u2019s groups'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user.id])

  function toggleGroup(groupId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(groupId)
      else next.delete(groupId)
      return next
    })
    // Removing the current primary from the set also clears the primary
    // (the server rejects a primary that isn't a membership).
    if (!checked && primaryId === groupId) {
      setPrimaryId(null)
    }
  }

  const selectedList = [...selected]
  const primaryOptions = [
    { value: NO_PRIMARY, label: 'None' },
    ...groups
      .filter((group) => selected.has(group.id))
      .map((group) => ({ value: group.id, label: group.name })),
  ]

  async function handleSave() {
    setBusy(true)
    setError(null)
    try {
      const groupIds = selectedList
      const primaryGroupId = primaryId ?? null
      await setVisitorGroups(user.id, { groupIds, primaryGroupId })
      onSaved({ groupIds, primaryGroupId })
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save group membership'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title="Assign groups"
      eyebrow={user.displayName?.trim() ? user.displayName : user.email}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => void handleSave()} disabled={busy || loading}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {loading ? (
        <SkeletonBlock minHeight={120} ariaLabel="Loading visitor group membership" />
      ) : (
        <div className={dialogStyles.form}>
          {groups.length > 0 ? (
            <>
              <div className={dialogStyles.field}>
                <span className={dialogStyles.label}>Groups</span>
                {groups.map((group) => (
                  <label key={group.id} className={dialogStyles.checkboxRow}>
                    <Checkbox
                      checked={selected.has(group.id)}
                      onCheckedChange={(checked) => toggleGroup(group.id, checked)}
                      aria-label={group.name}
                    />
                    <span>{group.name}</span>
                  </label>
                ))}
              </div>

              <div className={dialogStyles.field}>
                <label htmlFor="visitor-primary-group" className={dialogStyles.label}>
                  Primary group
                </label>
                <Select
                  id="visitor-primary-group"
                  aria-label="Primary group"
                  fieldSize="sm"
                  value={primaryId ?? NO_PRIMARY}
                  options={primaryOptions}
                  onChange={(event) =>
                    setPrimaryId(event.target.value === NO_PRIMARY ? null : event.target.value)
                  }
                />
              </div>
            </>
          ) : (
            <p>No member groups exist yet. Create one on the Groups tab first.</p>
          )}

          {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
        </div>
      )}
    </Dialog>
  )
}

/**
 * Module-level DataMeta cache for the shared data-binding picker.
 *
 * Lives in a separate `.ts` file so picker components remain pure component
 * files (required for React Fast Refresh to work correctly).
 *
 * `clearDataMetaCache` is exported for test isolation; import it from this
 * module directly — do not re-export it from the `.tsx` component file.
 */

import type { DataMeta } from '@core/data/schemas'
import { getDataMeta } from '@core/persistence/cmsData'
import type { MemberProfileField } from '@core/members'
import { getCmsMemberSettings } from '@core/persistence'

export let _cachedMeta: DataMeta | null = null
let _metaPromise: Promise<DataMeta> | null = null

/** @internal - for test use only */
export function clearDataMetaCache(): void {
  _cachedMeta = null
  _metaPromise = null
}

export function loadDataMeta(): Promise<DataMeta> {
  if (_cachedMeta) return Promise.resolve(_cachedMeta)
  if (_metaPromise) return _metaPromise
  _metaPromise = getDataMeta()
    .then((m) => {
      _cachedMeta = m
      _metaPromise = null
      return m
    })
    .catch((err) => {
      // Clear so a retry is possible after an error.
      _metaPromise = null
      throw err
    })
  return _metaPromise
}

// ---------------------------------------------------------------------------
// Member profile fields — the picker lists one binding per field the owner
// defined. Read once per page load; an editor whose role cannot read member
// settings simply gets the built-in field list.
// ---------------------------------------------------------------------------

export let _cachedMemberFields: MemberProfileField[] | null = null
let _memberFieldsPromise: Promise<MemberProfileField[] | null> | null = null

/** Forget the fields, so the picker reads them again. Called when the member settings are saved. */
export function forgetMemberProfileFields(): void {
  _cachedMemberFields = null
  _memberFieldsPromise = null
}

/** The site's profile fields, or null when this user may not read them. */
export function loadMemberProfileFields(): Promise<MemberProfileField[] | null> {
  if (_cachedMemberFields) return Promise.resolve(_cachedMemberFields)
  _memberFieldsPromise ??= getCmsMemberSettings()
    .then((response) => {
      _cachedMemberFields = response.settings.profileFields
      return _cachedMemberFields
    })
    .catch((_err) => {
      // No permission (or no connection): the picker falls back to the built-in list.
      _memberFieldsPromise = null
      return null
    })
  return _memberFieldsPromise
}

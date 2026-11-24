import { fragmentInsertDocument } from '@site/store/slices/fragmentsSlice'
import { collabBranchId } from '@site/store/slices/site/collabBranch'
import { isSameActiveDocument } from '@site/store/slices/uiSlice'
import { useEditorStore } from '@site/store/store'

/** A preview reads the current document once its branch's collection list is ready. */
export function capturePreviewBranch(): () => void {
  const branch = collabBranchId()
  return () => {
    if (collabBranchId() !== branch) throw new Error('The branch changed. Open the preview again.')
  }
}

/** Pin an insert to the site and document open when the user started it. */
export function captureFragmentTarget(): () => void {
  const state = useEditorStore.getState()
  const branch = collabBranchId()
  const document = fragmentInsertDocument(state)
  return () => {
    const current = useEditorStore.getState()
    if (current.site !== state.site || collabBranchId() !== branch
      || !isSameActiveDocument(document, fragmentInsertDocument(current))) {
      throw new Error('The destination changed. Review the fragment again before inserting it.')
    }
  }
}

/** Pin a site-wide theme to the site and branch open when the user started it. */
export function captureThemeTarget(): () => void {
  const { site } = useEditorStore.getState()
  const branch = collabBranchId()
  return () => {
    if (useEditorStore.getState().site !== site || collabBranchId() !== branch) {
      throw new Error('The destination changed. Review the theme again before applying it.')
    }
  }
}

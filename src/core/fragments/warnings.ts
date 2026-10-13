/**
 * Notes the fragment engine raises while extracting, planning or committing.
 * None of them stop the operation — anything that must stop it throws a typed
 * error instead (`FragmentExtractError`, `FragmentInsertError`,
 * `FragmentCommitError`). Each note is something the insert report shows the
 * user so nothing changes silently.
 */
export type FragmentWarningCode =
  // extract
  | 'unresolved-custom-property'
  | 'missing-component'
  | 'missing-table'
  | 'unsupported-table'
  | 'unsupported-loop-source'
  | 'missing-page-link'
  | 'missing-media-bytes'
  // plan
  | 'framework-class-dropped'
  | 'color-variant-missing'
  | 'missing-scale-group'
  | 'scale-step-not-added'
  | 'missing-context'
  | 'component-ref-dropped'
  | 'relation-field-dropped'
  | 'field-type-mismatch'
  | 'link-unresolved'
  // commit
  | 'font-install-failed'

export interface FragmentWarning {
  code: FragmentWarningCode
  message: string
  /** The name, id or path the note is about, for grouping in a report. */
  subject?: string
}

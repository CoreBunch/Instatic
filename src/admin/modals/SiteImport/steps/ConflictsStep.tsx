/**
 * ConflictsStep — the third step of the Super Import wizard.
 *
 * Shows page slug conflicts and class name conflicts with resolution pickers.
 * Each row uses `ConflictRow` to let the user choose between auto-rename,
 * overwrite, skip, or a custom value.
 * Section-level controls apply the common actions to every conflict in a
 * category, so large repeat imports do not require hundreds of row edits.
 *
 * The modal's Next handler auto-skips this step when there are no conflicts
 * after selection filtering. This component guards with an early return just
 * in case it's rendered without conflicts.
 */
import type { ImportPlan, ConflictResolution } from '@core/siteImport'
import { Button } from '@ui/components/Button'
import { ConflictRow } from '../shared/ConflictRow'
import { crossSheetConflictKey, tokenConflictKey } from '../shared/importPlanning'
import styles from './ConflictsStep.module.css'

type BulkResolutionAction = Extract<ConflictResolution['action'], 'auto-rename' | 'overwrite' | 'skip'>

function resolutionForAction(
  action: BulkResolutionAction,
  conflict: { defaultResolution: ConflictResolution },
): ConflictResolution {
  if (action === 'auto-rename') return conflict.defaultResolution
  return { action }
}

interface ConflictsStepProps {
  plan: ImportPlan
  pageResolutions: Map<string, ConflictResolution>
  ruleResolutions: Map<string, ConflictResolution>
  tokenResolutions: Map<string, ConflictResolution>
  crossSheetResolutions: Map<string, ConflictResolution>
  onPageResolutionChange: (source: string, resolution: ConflictResolution) => void
  onRuleResolutionChange: (desiredName: string, resolution: ConflictResolution) => void
  onTokenResolutionChange: (key: string, resolution: ConflictResolution) => void
  onCrossSheetResolutionChange: (key: string, resolution: ConflictResolution) => void
}

export function ConflictsStep({
  plan,
  pageResolutions,
  ruleResolutions,
  tokenResolutions,
  crossSheetResolutions,
  onPageResolutionChange,
  onRuleResolutionChange,
  onTokenResolutionChange,
  onCrossSheetResolutionChange,
}: ConflictsStepProps) {
  const {
    pages: pageConflicts,
    rules: ruleConflicts,
    tokens: tokenConflicts,
    crossSheetClasses: crossSheetConflicts,
  } = plan.conflicts
  const pageBulkOverwriteAvailable = pageConflicts.every((conflict) => conflict.existingPageId !== '')

  if (
    pageConflicts.length === 0 &&
    ruleConflicts.length === 0 &&
    tokenConflicts.length === 0 &&
    crossSheetConflicts.length === 0
  ) {
    return null
  }

  function applyPageResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of pageConflicts) {
      onPageResolutionChange(conflict.source, resolutionForAction(action, conflict))
    }
  }

  function applyRuleResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of ruleConflicts) {
      onRuleResolutionChange(conflict.desiredName, resolutionForAction(action, conflict))
    }
  }

  function applyTokenResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of tokenConflicts) {
      onTokenResolutionChange(tokenConflictKey(conflict), resolutionForAction(action, conflict))
    }
  }

  function applyCrossSheetResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of crossSheetConflicts) {
      onCrossSheetResolutionChange(crossSheetConflictKey(conflict), resolutionForAction(action, conflict))
    }
  }

  return (
    <div className={styles.wrapper}>
      {pageConflicts.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              Page slug conflicts ({pageConflicts.length})
            </h3>
            <fieldset className={styles.bulkActions}>
              <legend className={styles.bulkLegend}>Bulk page slug conflict actions</legend>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Rename all page slug conflicts"
                onClick={() => applyPageResolutionToAll('auto-rename')}
              >
                Rename all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Skip all page slug conflicts"
                onClick={() => applyPageResolutionToAll('skip')}
              >
                Skip all
              </Button>
              {pageBulkOverwriteAvailable && (
                <Button
                  variant="secondary"
                  size="xs"
                  type="button"
                  aria-label="Overwrite all page slug conflicts"
                  onClick={() => applyPageResolutionToAll('overwrite')}
                >
                  Overwrite all
                </Button>
              )}
            </fieldset>
          </div>
          <p className={styles.hint}>
            These pages share a slug with an existing page, or with another
            page in this import. Choose how to resolve each one.
          </p>
          <div className={styles.rows}>
            {pageConflicts.map((conflict) => (
              <ConflictRow
                key={conflict.source}
                kind="page"
                source={conflict.source}
                desired={conflict.desiredSlug}
                current={pageResolutions.get(conflict.source) ?? conflict.defaultResolution}
                // No existing page id ⇒ intra-batch collision; nothing to overwrite.
                canOverwrite={conflict.existingPageId !== ''}
                onChange={(next) => onPageResolutionChange(conflict.source, next)}
              />
            ))}
          </div>
        </section>
      )}

      {ruleConflicts.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              Class name conflicts ({ruleConflicts.length})
            </h3>
            <fieldset className={styles.bulkActions}>
              <legend className={styles.bulkLegend}>Bulk class name conflict actions</legend>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Rename all class name conflicts"
                onClick={() => applyRuleResolutionToAll('auto-rename')}
              >
                Rename all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Skip all class name conflicts"
                onClick={() => applyRuleResolutionToAll('skip')}
              >
                Skip all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Overwrite all class name conflicts"
                onClick={() => applyRuleResolutionToAll('overwrite')}
              >
                Overwrite all
              </Button>
            </fieldset>
          </div>
          <p className={styles.hint}>
            These class names are already used in this site's style registry.
          </p>
          <div className={styles.rows}>
            {ruleConflicts.map((conflict) => (
              <ConflictRow
                key={conflict.desiredName}
                kind="rule"
                source={conflict.source}
                desired={conflict.desiredName}
                current={ruleResolutions.get(conflict.desiredName) ?? conflict.defaultResolution}
                onChange={(next) => onRuleResolutionChange(conflict.desiredName, next)}
              />
            ))}
          </div>
        </section>
      )}

      {crossSheetConflicts.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              Stylesheets disagree ({crossSheetConflicts.length})
            </h3>
            <fieldset className={styles.bulkActions}>
              <legend className={styles.bulkLegend}>Bulk cross-stylesheet conflict actions</legend>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Rename all cross-stylesheet conflicts"
                onClick={() => applyCrossSheetResolutionToAll('auto-rename')}
              >
                Rename all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Keep the first definition for all cross-stylesheet conflicts"
                onClick={() => applyCrossSheetResolutionToAll('skip')}
              >
                Keep first all
              </Button>
            </fieldset>
          </div>
          <p className={styles.hint}>
            Two imported stylesheets define the same class differently. Rename
            keeps each page faithful to its own stylesheet (the listed pages
            move to the new name); skip uses the first definition everywhere;
            overwrite makes this definition win the original name.
          </p>
          <div className={styles.rows}>
            {crossSheetConflicts.map((conflict) => {
              const key = crossSheetConflictKey(conflict)
              return (
                <ConflictRow
                  key={key}
                  kind="rule"
                  source={`${conflict.sources.join(', ') || 'imported stylesheets'} · ${conflict.pageSources.join(', ')}`}
                  desired={conflict.desiredName}
                  current={crossSheetResolutions.get(key) ?? conflict.defaultResolution}
                  onChange={(next) => onCrossSheetResolutionChange(key, next)}
                />
              )
            })}
          </div>
        </section>
      )}

      {tokenConflicts.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              Design token conflicts ({tokenConflicts.length})
            </h3>
            <fieldset className={styles.bulkActions}>
              <legend className={styles.bulkLegend}>Bulk design token conflict actions</legend>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Rename all design token conflicts"
                onClick={() => applyTokenResolutionToAll('auto-rename')}
              >
                Rename all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Skip all design token conflicts"
                onClick={() => applyTokenResolutionToAll('skip')}
              >
                Skip all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Overwrite all design token conflicts"
                onClick={() => applyTokenResolutionToAll('overwrite')}
              >
                Overwrite all
              </Button>
            </fieldset>
          </div>
          <p className={styles.hint}>
            These colour / font variables already exist in this site. Rename keeps
            the imported value on a new <code>--variable</code> (and rewrites the
            imported CSS to match); skip keeps your current token; overwrite
            replaces your token's value.
          </p>
          <div className={styles.rows}>
            {tokenConflicts.map((conflict) => {
              const key = tokenConflictKey(conflict)
              const label = conflict.kind === 'color' ? 'Colour' : 'Font'
              return (
                <ConflictRow
                  key={key}
                  kind="token"
                  source={`${label} · --${conflict.desiredVariable}`}
                  desired={conflict.desiredVariable}
                  current={tokenResolutions.get(key) ?? conflict.defaultResolution}
                  onChange={(next) => onTokenResolutionChange(key, next)}
                />
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

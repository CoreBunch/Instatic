/**
 * ConflictsStep — the third step of the Super Import wizard.
 *
 * Shows page slug, class name, design token, site file and media conflicts
 * with resolution pickers. Each row uses `ConflictRow`: renamable kinds choose
 * between auto-rename, overwrite, skip, or a custom value; files and media
 * already in the site choose between reusing them and importing again.
 * Section-level controls apply the common actions to every conflict in a
 * category, so large repeat imports do not require hundreds of row edits.
 * Every category renders through `ConflictSection`.
 *
 * The modal's Next handler auto-skips this step when there are no conflicts
 * after selection filtering. This component guards with an early return just
 * in case it's rendered without conflicts.
 */
import type { ReactNode } from 'react'
import type { ImportPlan, ConflictResolution, FileConflict } from '@core/siteImport'
import { Button } from '@ui/components/Button'
import { ConflictRow } from '../shared/ConflictRow'
import {
  classRowKey,
  crossSheetConflictKey,
  fileConflictKey,
  tokenConflictKey,
  type ConflictCategory,
  type ConflictResolutionMaps,
} from '../shared/importPlanning'
import styles from './ConflictsStep.module.css'

type BulkResolutionAction = Extract<ConflictResolution['action'], 'auto-rename' | 'overwrite' | 'skip'>

function withRenameTarget(
  choice: ConflictResolution,
  conflict: { defaultResolution: ConflictResolution },
): ConflictResolution {
  return choice.action === 'auto-rename' ? { ...conflict.defaultResolution, action: choice.action } : choice
}

const FILE_STATE_LABEL: Record<FileConflict['state'], string> = {
  unchanged: 'unchanged',
  changed: 'changed in this import',
  edited: 'edited in Instatic since the last import',
  differs: 'content differs',
}

/** One "apply to every row" button in a section header. */
interface BulkAction {
  label: string
  ariaLabel: string
  onClick: () => void
}

interface ConflictSectionProps {
  heading: string
  count: number
  bulkLegend: string
  bulkActions: BulkAction[]
  hint: ReactNode
  children: ReactNode
}

function ConflictSection({ heading, count, bulkLegend, bulkActions, hint, children }: ConflictSectionProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.heading}>
          {heading} ({count})
        </h3>
        <fieldset className={styles.bulkActions}>
          <legend className={styles.bulkLegend}>{bulkLegend}</legend>
          {bulkActions.map((action) => (
            <Button
              key={action.ariaLabel}
              variant="secondary"
              size="xs"
              type="button"
              aria-label={action.ariaLabel}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </fieldset>
      </div>
      <p className={styles.hint}>{hint}</p>
      <div className={styles.rows}>{children}</div>
    </section>
  )
}

interface ConflictsStepProps {
  plan: ImportPlan
  classNameProblems: Map<string, string>
  resolutions: ConflictResolutionMaps
  onResolutionChange: (category: ConflictCategory, key: string, resolution: ConflictResolution) => void
}

export function ConflictsStep({ plan, classNameProblems, resolutions, onResolutionChange }: ConflictsStepProps) {
  const {
    pages: pageConflicts,
    rules: ruleConflicts,
    tokens: tokenConflicts,
    crossSheetClasses: crossSheetConflicts,
    files: fileConflicts,
    media: mediaConflicts,
  } = plan.conflicts
  const pageBulkOverwriteAvailable = pageConflicts.every((conflict) => conflict.existingPageId !== '')

  if (
    pageConflicts.length === 0 &&
    ruleConflicts.length === 0 &&
    tokenConflicts.length === 0 &&
    crossSheetConflicts.length === 0 &&
    fileConflicts.length === 0 &&
    mediaConflicts.length === 0
  ) {
    return null
  }

  function applyPageResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of pageConflicts) {
      onResolutionChange('pages', conflict.source, withRenameTarget({ action }, conflict))
    }
  }

  function applyRuleResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of ruleConflicts) {
      onResolutionChange('rules', conflict.desiredName, withRenameTarget({ action }, conflict))
    }
  }

  function applyTokenResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of tokenConflicts) {
      onResolutionChange('tokens', tokenConflictKey(conflict), withRenameTarget({ action }, conflict))
    }
  }

  function applyCrossSheetResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of crossSheetConflicts) {
      onResolutionChange('crossSheetClasses', crossSheetConflictKey(conflict), withRenameTarget({ action }, conflict))
    }
  }

  function applyFileResolutionToAll(action: 'skip' | 'overwrite') {
    for (const conflict of fileConflicts) onResolutionChange('files', fileConflictKey(conflict), { action })
  }

  function applyMediaResolutionToAll(action: 'skip' | 'auto-rename') {
    for (const conflict of mediaConflicts) onResolutionChange('media', conflict.sourcePath, { action })
  }

  return (
    <div className={styles.wrapper}>
      {pageConflicts.length > 0 && (
        <ConflictSection
          heading="Page slug conflicts"
          count={pageConflicts.length}
          bulkLegend="Bulk page slug conflict actions"
          bulkActions={[
            { label: 'Rename all', ariaLabel: 'Rename all page slug conflicts', onClick: () => applyPageResolutionToAll('auto-rename') },
            { label: 'Skip all', ariaLabel: 'Skip all page slug conflicts', onClick: () => applyPageResolutionToAll('skip') },
            ...(pageBulkOverwriteAvailable
              ? [{ label: 'Overwrite all', ariaLabel: 'Overwrite all page slug conflicts', onClick: () => applyPageResolutionToAll('overwrite') }]
              : []),
          ]}
          hint="These pages share a slug with an existing page, or with another page in this import. Choose how to resolve each one."
        >
          {pageConflicts.map((conflict) => (
            <ConflictRow
              key={conflict.source}
              kind="page"
              source={conflict.source}
              desired={conflict.desiredSlug}
              current={resolutions.pages.get(conflict.source) ?? conflict.defaultResolution}
              // No existing page id ⇒ intra-batch collision; nothing to overwrite.
              canOverwrite={conflict.existingPageId !== ''}
              onChange={(next) => onResolutionChange('pages', conflict.source, withRenameTarget(next, conflict))}
            />
          ))}
        </ConflictSection>
      )}

      {ruleConflicts.length > 0 && (
        <ConflictSection
          heading="Class name conflicts"
          count={ruleConflicts.length}
          bulkLegend="Bulk class name conflict actions"
          bulkActions={[
            { label: 'Rename all', ariaLabel: 'Rename all class name conflicts', onClick: () => applyRuleResolutionToAll('auto-rename') },
            { label: 'Skip all', ariaLabel: 'Skip all class name conflicts', onClick: () => applyRuleResolutionToAll('skip') },
            { label: 'Overwrite all', ariaLabel: 'Overwrite all class name conflicts', onClick: () => applyRuleResolutionToAll('overwrite') },
          ]}
          hint="These class names are already used in this site's style registry."
        >
          {ruleConflicts.map((conflict) => (
            <ConflictRow
              key={conflict.desiredName}
              kind="rule"
              source={conflict.source}
              desired={conflict.desiredName}
              current={resolutions.rules.get(conflict.desiredName) ?? conflict.defaultResolution}
              error={classNameProblems.get(classRowKey('rule', conflict.desiredName))}
              onChange={(next) => onResolutionChange('rules', conflict.desiredName, withRenameTarget(next, conflict))}
            />
          ))}
        </ConflictSection>
      )}

      {crossSheetConflicts.length > 0 && (
        <ConflictSection
          heading="Stylesheets disagree"
          count={crossSheetConflicts.length}
          bulkLegend="Bulk cross-stylesheet conflict actions"
          bulkActions={[
            { label: 'Rename all', ariaLabel: 'Rename all cross-stylesheet conflicts', onClick: () => applyCrossSheetResolutionToAll('auto-rename') },
            {
              label: 'Keep first all',
              ariaLabel: 'Keep the first definition for all cross-stylesheet conflicts',
              onClick: () => applyCrossSheetResolutionToAll('skip'),
            },
          ]}
          hint="Imported classes are shared across pages. Rename confines the rules to the listed pages. Skip leaves the rules out. Overwrite applies them on every page."
        >
          {crossSheetConflicts.map((conflict) => {
            const key = crossSheetConflictKey(conflict)
            return (
              <ConflictRow
                key={key}
                kind="rule"
                source={conflict.kind === 'leak' ? `${conflict.sources[0]} would also style pages that do not load it · ${conflict.pageSources.join(', ')}` : `${conflict.sources.join(', ') || 'imported stylesheets'} · ${conflict.pageSources.join(', ')}`}
                desired={conflict.desiredName}
                current={resolutions.crossSheetClasses.get(key) ?? conflict.defaultResolution}
                error={classNameProblems.get(classRowKey('cross-sheet', key))}
                onChange={(next) => onResolutionChange('crossSheetClasses', key, withRenameTarget(next, conflict))}
              />
            )
          })}
        </ConflictSection>
      )}

      {tokenConflicts.length > 0 && (
        <ConflictSection
          heading="Design token conflicts"
          count={tokenConflicts.length}
          bulkLegend="Bulk design token conflict actions"
          bulkActions={[
            { label: 'Rename all', ariaLabel: 'Rename all design token conflicts', onClick: () => applyTokenResolutionToAll('auto-rename') },
            { label: 'Skip all', ariaLabel: 'Skip all design token conflicts', onClick: () => applyTokenResolutionToAll('skip') },
            { label: 'Overwrite all', ariaLabel: 'Overwrite all design token conflicts', onClick: () => applyTokenResolutionToAll('overwrite') },
          ]}
          hint={
            <>
              These colour / font variables already exist in this site. Rename keeps
              the imported value on a new <code>--variable</code> (and rewrites the
              imported CSS to match); skip keeps your current token; overwrite
              replaces your token&apos;s value.
            </>
          }
        >
          {tokenConflicts.map((conflict) => {
            const key = tokenConflictKey(conflict)
            const label = conflict.kind === 'color' ? 'Colour' : 'Font'
            return (
              <ConflictRow
                key={key}
                kind="token"
                source={`${label} · --${conflict.desiredVariable}`}
                desired={conflict.desiredVariable}
                current={resolutions.tokens.get(key) ?? conflict.defaultResolution}
                onChange={(next) => onResolutionChange('tokens', key, withRenameTarget(next, conflict))}
              />
            )
          })}
        </ConflictSection>
      )}

      {fileConflicts.length > 0 && (
        <ConflictSection
          heading="Files already in this site"
          count={fileConflicts.length}
          bulkLegend="Bulk site file conflict actions"
          bulkActions={[
            { label: 'Use existing all', ariaLabel: 'Use the existing file for all site file conflicts', onClick: () => applyFileResolutionToAll('skip') },
            { label: 'Replace all', ariaLabel: 'Replace all site file conflicts', onClick: () => applyFileResolutionToAll('overwrite') },
          ]}
          hint="These scripts and stylesheets are already in this site, usually from an earlier import of the same files. Use existing keeps your file; replace swaps in the imported one, the default only when this import changed it and nobody edited it here. Either way the imported pages load it. Keep both adds a second copy."
        >
          {fileConflicts.map((conflict) => {
            const key = fileConflictKey(conflict)
            return (
              <ConflictRow
                key={key}
                kind="file"
                source={`${conflict.kind === 'script' ? 'Script' : 'Stylesheet'} · ${FILE_STATE_LABEL[conflict.state]}`}
                desired={conflict.sitePath}
                current={resolutions.files.get(key) ?? conflict.defaultResolution}
                onChange={(next) => onResolutionChange('files', key, next)}
              />
            )
          })}
        </ConflictSection>
      )}

      {mediaConflicts.length > 0 && (
        <ConflictSection
          heading="Media already in the library"
          count={mediaConflicts.length}
          bulkLegend="Bulk media conflict actions"
          bulkActions={[
            { label: 'Use existing all', ariaLabel: 'Use the existing file for all media conflicts', onClick: () => applyMediaResolutionToAll('skip') },
            { label: 'Upload copies', ariaLabel: 'Upload copies for all media conflicts', onClick: () => applyMediaResolutionToAll('auto-rename') },
          ]}
          hint="The Media Library already has a file with exactly these bytes. Use existing points the import at it instead of uploading a copy."
        >
          {mediaConflicts.map((conflict) => (
            <ConflictRow
              key={conflict.sourcePath}
              kind="media"
              source={conflict.sourcePath}
              desired={conflict.existingFilename}
              current={resolutions.media.get(conflict.sourcePath) ?? conflict.defaultResolution}
              onChange={(next) => onResolutionChange('media', conflict.sourcePath, next)}
            />
          ))}
        </ConflictSection>
      )}
    </div>
  )
}

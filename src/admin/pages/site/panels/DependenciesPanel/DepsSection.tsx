/**
 * DepsSection — dependency management content body.
 *
 * Mounted as the sole child of the shared `Panel`'s padded body in
 * `DependenciesPanel`. Owns no panel chrome — the outer `<aside>`,
 * header, and 8px content padding all come from `Panel`.
 *
 * Behaviour:
 *   - SAFE_PACKAGE_NAME validation on every add (Constraint #361 Rule 5 / CWE-78)
 *   - Inline remove confirmation (Guideline #258)
 *   - Search with aria-live result count (WCAG 2.1 AA)
 *   - setDependency / removeDependency store actions
 *
 * @see Constraint #361 — Phase G Security (Rule 5: package-name validation, CWE-78)
 * @see Guideline #258 — Inline Confirmation UI Pattern
 * @see Contribution #512 — Phase E+ Site Panel UX Spec §4
 */
import { useState, useRef, useId } from 'react'
import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { Switch } from '@ui/components/Switch'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import {
  getSiteModuleDependencyUsage,
  registry,
  type SiteModuleDependencyUsage,
} from '@core/module-engine'
import {
  analyzeRuntimeScriptImports,
  type RuntimePackageDependencyUsage,
  type SiteRuntimeDiagnostic,
} from '@core/site-runtime'
import { evaluateDependencyLockStatus } from './lockStatus'
import styles from './DepsSection.module.css'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoveConfirmState {
  name: string
  /** TODO(Phase G): used by `bun remove --dev` when bridge is active */
  dev: boolean
}

interface DependencyUsageSummary {
  moduleUsage?: SiteModuleDependencyUsage
  scriptUsage?: RuntimePackageDependencyUsage
}

interface RuntimeDependencyIssue {
  code: string
  packageName: string
  message: string
  action: 'add' | 'move-to-runtime' | null
}

// ---------------------------------------------------------------------------
// DepsSection
// ---------------------------------------------------------------------------

export function DepsSection() {
  const site = useEditorStore((s) => s.site)
  const packageJson = useEditorStore((s) => s.packageJson)
  const siteRuntime = useEditorStore((s) => s.siteRuntime)
  const setDependency = useEditorStore((s) => s.setDependency)
  const removeDependency = useEditorStore((s) => s.removeDependency)
  const resolveDependencyLock = useEditorStore((s) => s.resolveDependencyLock)
  const resolveStatus = useEditorStore((s) => s.dependencyResolveStatus)
  const resolveLockedCount = useEditorStore((s) => s.dependencyResolveLockedCount)
  const resolveError = useEditorStore((s) => s.dependencyResolveError)

  // ── Local state ─────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [addName, setAddName] = useState('')
  const [addDev, setAddDev] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const devToggleId = useId()
  const [removeConfirm, setRemoveConfirm] = useState<RemoveConfirmState | null>(null)

  const cancelRef = useRef<HTMLButtonElement>(null)

  // ── Filtered deps ────────────────────────────────────────────────────────
  const filterDeps = (deps: Record<string, string>) => {
    if (!searchQuery.trim()) return Object.entries(deps)
    const q = searchQuery.toLowerCase()
    return Object.entries(deps).filter(([name]) => name.toLowerCase().includes(q))
  }

  const filteredDeps = filterDeps(packageJson.dependencies)
  const filteredDevDeps = filterDeps(packageJson.devDependencies)
  const dependencyUsage = combineDependencyUsage(
    getSiteModuleDependencyUsage(site, registry),
    analyzeRuntimeScriptImports(site?.files ?? [], packageJson).usage,
  )
  const runtimeIssues = summarizeRuntimeDependencyIssues(
    analyzeRuntimeScriptImports(site?.files ?? [], packageJson).diagnostics,
  )

  const totalFiltered = filteredDeps.length + filteredDevDeps.length
  const totalAll =
    Object.keys(packageJson.dependencies).length +
    Object.keys(packageJson.devDependencies).length

  const lockedPackages = siteRuntime.dependencyLock.packages
  const lockStatus = evaluateDependencyLockStatus(packageJson, lockedPackages)

  // The slice's `resolved` status hangs around until the next attempt — when
  // the lock has fallen out of sync since (user added another package after
  // a successful resolve), the "N locked" toast would be misleading. Hide
  // the toast in that window; the auto-resolve hook will re-fire and the
  // toast re-appears once the new lock lands.
  const isResolveToastStale =
    lockStatus.kind !== 'in-sync' && resolveStatus === 'resolved'
  const displayedResolveStatus = isResolveToastStale ? 'idle' : resolveStatus
  const displayedResolveMessage = (() => {
    if (isResolveToastStale) return null
    if (resolveStatus === 'resolving') return 'Resolving…'
    if (resolveStatus === 'resolved') return `${resolveLockedCount} locked`
    if (resolveStatus === 'error') return resolveError ?? 'Dependency resolution failed'
    return null
  })()

  // ── Add package handler ──────────────────────────────────────────────────
  const handleAddPackage = () => {
    const name = addName.trim()
    if (!name) {
      setAddError('Package name is required')
      return
    }
    // Client-side gate (Constraint #361 Rule 5) — validate every dispatch
    if (!isSafePackageName(name)) {
      setAddError('Invalid package name (lowercase, no special chars)')
      return
    }
    setDependency(name, '*', addDev)
    setAddName('')
    setAddError(null)
    // TODO(Phase G): ask the site bridge to install this in the user site.
  }

  const handleRuntimeIssueAction = (issue: RuntimeDependencyIssue) => {
    if (issue.action === 'add') {
      setDependency(issue.packageName, '*', false)
      return
    }

    if (issue.action === 'move-to-runtime') {
      const version = packageJson.devDependencies[issue.packageName] ?? '*'
      setDependency(issue.packageName, version, false)
    }
  }

  // ── Remove confirmation (Guideline #258) ────────────────────────────────
  const requestRemove = (name: string, dev: boolean) => {
    setRemoveConfirm({ name, dev })
    // Focus moves to Cancel button on reveal (Guideline #258)
    requestAnimationFrame(() => cancelRef.current?.focus())
  }

  const confirmRemove = () => {
    if (removeConfirm) {
      removeDependency(removeConfirm.name)
      setRemoveConfirm(null)
      // TODO(Phase G): ask the site bridge to remove this from the user site.
    }
  }

  const cancelRemove = () => {
    setRemoveConfirm(null)
  }

  const handleRemoveKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelRemove()
    }
  }

  // ── Add input validation on change ───────────────────────────────────────
  const handleAddNameChange = (value: string) => {
    setAddName(value)
    if (!value.trim()) {
      setAddError(null)
      return
    }
    if (!isSafePackageName(value.trim())) {
      setAddError('Invalid package name (use lowercase, hyphens, dots, @ scopes)')
    } else {
      setAddError(null)
    }
  }

  const runtimeDependencyCount = Object.keys(packageJson.dependencies).length

  const handleResolveDependencies = () => {
    // The auto-resolve hook handles the common case (dep added/removed →
    // background resolve). This button is the manual escape hatch: surface
    // when an auto-resolve errored, or let the user re-run on demand.
    resolveDependencyLock().catch(() => {/* slice stores the error */})
  }

  return (
    <div
      id="deps-section-body"
      className={styles.body}
      data-testid="deps-section"
    >
      <SearchBar
        value={searchQuery}
        onValueChange={setSearchQuery}
        placeholder="Search packages..."
        aria-label="Search packages"
      />
      {/* Live region for search results (Guideline #221) */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className={styles.srLiveRegion}
      >
        {searchQuery
          ? `${totalFiltered} of ${totalAll} packages shown`
          : ''}
      </div>

      {/* ─── Package list ──────────────────────────────────────────── */}
      <div className={styles.packageList} data-testid="deps-tab">
        {runtimeIssues.length > 0 && (
          <div
            className={styles.runtimeIssues}
            aria-label="Runtime dependency issues"
          >
            {runtimeIssues.map((issue) => (
              <div
                key={`${issue.code}:${issue.packageName}`}
                className={styles.runtimeIssue}
              >
                <span className={styles.runtimeIssueText}>
                  <span className={styles.runtimeIssuePackage}>{issue.packageName}</span>
                  <span>{issue.message}</span>
                </span>
                {issue.action && (
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => handleRuntimeIssueAction(issue)}
                  >
                    {issue.action === 'add' ? 'Add' : 'Move'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* dependencies section */}
        {filteredDeps.length > 0 && (
          <>
            <div className={styles.sectionLabel}>dependencies</div>
            {filteredDeps.map(([name, version]) => (
              <DepRow
                key={name}
                name={name}
                version={version}
                lockedVersion={lockedPackages[name]?.version}
                dev={false}
                usage={dependencyUsage.get(name)}
                onRemove={requestRemove}
                confirmState={removeConfirm}
                cancelRef={cancelRef}
                onConfirmRemove={confirmRemove}
                onCancelRemove={cancelRemove}
                onKeyDown={handleRemoveKeyDown}
              />
            ))}
          </>
        )}

        {/* devDependencies section */}
        {filteredDevDeps.length > 0 && (
          <>
            <div className={styles.sectionLabel}>devDependencies</div>
            {filteredDevDeps.map(([name, version]) => (
              <DepRow
                key={name}
                name={name}
                version={version}
                dev={true}
                usage={dependencyUsage.get(name)}
                onRemove={requestRemove}
                confirmState={removeConfirm}
                cancelRef={cancelRef}
                onConfirmRemove={confirmRemove}
                onCancelRemove={cancelRemove}
                onKeyDown={handleRemoveKeyDown}
              />
            ))}
          </>
        )}

        {/* Empty / no-results state */}
        {filteredDeps.length === 0 && filteredDevDeps.length === 0 && (
          <div className={styles.emptyMsg}>
            {searchQuery ? `No packages matching "${searchQuery}"` : 'No dependencies yet.'}
          </div>
        )}
      </div>

      {/* ─── Add package form ──────────────────────────────────────── */}
      <div className={styles.addForm}>
        {runtimeDependencyCount > 0 && (
          <div className={styles.resolveRow}>
            {/* Manual re-resolve — auto-resolve covers the happy path; this
                button is here for "the network blipped, retry" and explicit
                refreshes. Hidden until something is worth surfacing. */}
            {(displayedResolveStatus === 'error' || lockStatus.kind !== 'in-sync') && (
              <Button
                variant={displayedResolveStatus === 'error' ? 'primary' : 'secondary'}
                size="xs"
                onClick={handleResolveDependencies}
                disabled={displayedResolveStatus === 'resolving'}
              >
                {displayedResolveStatus === 'resolving'
                  ? 'Resolving'
                  : displayedResolveStatus === 'error'
                    ? 'Retry resolve'
                    : 'Re-resolve'}
              </Button>
            )}
            {displayedResolveMessage && (
              <span
                className={styles.resolveStatus}
                data-status={displayedResolveStatus}
                role={displayedResolveStatus === 'error' ? 'alert' : undefined}
              >
                {displayedResolveMessage}
              </span>
            )}
          </div>
        )}

        <div className={styles.addRow}>
          <div className={styles.addInputArea}>
            <div className={styles.addInputWrapper}>
              <PackageSolidIcon size={11} color="var(--text-disabled)" aria-hidden="true" />
              <Input
                data-testid="add-dep-input"
                type="text"
                fieldSize="sm"
                value={addName}
                onChange={(e) => handleAddNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddPackage()
                }}
                monospace
                placeholder="package-name"
                aria-label="Add package name"
                aria-describedby={addError ? 'deps-add-error' : undefined}
                invalid={Boolean(addError)}
                className={styles.addInput}
              />
            </div>
            {addError && (
              <div
                id="deps-add-error"
                role="alert"
                className={styles.addError}
              >
                {addError}
              </div>
            )}
          </div>

          <Button
            variant="primary"
            size="xs"
            onClick={handleAddPackage}
            disabled={!!addError || !addName.trim()}
            aria-label="Add dependency"
            tooltip="Add dependency"
          >
            <PlusIcon size={11} aria-hidden="true" />
            Add
          </Button>
        </div>

        {/* dev toggle */}
        <div className={styles.devToggle}>
          <Switch
            id={devToggleId}
            checked={addDev}
            onCheckedChange={setAddDev}
            switchSize="sm"
          />
          <label htmlFor={devToggleId} className={styles.devLabel}>devDependency</label>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DepRow — single dependency row with inline remove confirmation
// ---------------------------------------------------------------------------

interface DepRowProps {
  name: string
  version: string
  lockedVersion?: string
  dev: boolean
  usage?: DependencyUsageSummary
  onRemove: (name: string, dev: boolean) => void
  confirmState: RemoveConfirmState | null
  cancelRef: React.RefObject<HTMLButtonElement | null>
  onConfirmRemove: () => void
  onCancelRemove: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

function DepRow({
  name,
  version,
  lockedVersion,
  dev,
  usage,
  onRemove,
  confirmState,
  cancelRef,
  onConfirmRemove,
  onCancelRemove,
  onKeyDown,
}: DepRowProps) {
  const isPendingRemoval = confirmState?.name === name

  if (isPendingRemoval) {
    // Inline confirmation (Guideline #258)
    return (
      <div
        data-testid={`dep-row-${name}`}
        onKeyDown={onKeyDown}
        className={styles.depRowConfirm}
      >
        <span className={styles.depConfirmText}>
          Remove <strong>{name}</strong>?
          {usage && (
            <span className={styles.depConfirmDetail}>
              {' '}Used by {formatDependencyUsage(usage)}.
            </span>
          )}
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirmRemove}
          aria-label={`Confirm remove ${name}`}
        >
          Remove
        </Button>
        <Button
          ref={cancelRef}
          variant="secondary"
          size="sm"
          onClick={onCancelRemove}
          aria-label="Cancel remove"
        >
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div
      data-testid={`dep-row-${name}`}
      className={styles.depRow}
    >
      <span className={styles.depRowIcon} aria-hidden="true">
        <PackageSolidIcon size={11} />
      </span>
      <span
        className={styles.depName}
        title={name}
      >
        {name}
      </span>
      <span className={styles.depVersion}>
        {version}
        {lockedVersion && lockedVersion !== version && (
          <>
            {' '}
            <span className={styles.depLockedVersion} title={`Locked at ${lockedVersion}`}>
              → {lockedVersion}
            </span>
          </>
        )}
      </span>
      {usage && (
        <span
          className={styles.depUsage}
          title={`Required by ${formatDependencyUsage(usage)}`}
        >
          in use
        </span>
      )}
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        data-testid={`remove-dep-${name}`}
        onClick={() => onRemove(name, dev)}
        aria-label={`Remove ${name}`}
        tooltip={`Remove ${name}`}
      >
        <CloseIcon size={10} aria-hidden="true" />
      </Button>
    </div>
  )
}

function formatModuleUsage(usage: SiteModuleDependencyUsage): string {
  if (usage.modules.length <= 2) return usage.modules.join(', ')
  return `${usage.modules.slice(0, 2).join(', ')} +${usage.modules.length - 2}`
}

function formatScriptUsage(usage: RuntimePackageDependencyUsage): string {
  const paths = usage.files.map((file) => file.path.split('/').pop() ?? file.path)
  if (paths.length <= 2) return paths.join(', ')
  return `${paths.slice(0, 2).join(', ')} +${paths.length - 2}`
}

function formatDependencyUsage(usage: DependencyUsageSummary): string {
  const parts: string[] = []
  if (usage.moduleUsage) parts.push(formatModuleUsage(usage.moduleUsage))
  if (usage.scriptUsage) parts.push(`scripts: ${formatScriptUsage(usage.scriptUsage)}`)
  return parts.join('; ')
}

function combineDependencyUsage(
  moduleUsage: Map<string, SiteModuleDependencyUsage>,
  scriptUsage: Map<string, RuntimePackageDependencyUsage>,
): Map<string, DependencyUsageSummary> {
  const combined = new Map<string, DependencyUsageSummary>()

  for (const [name, usage] of moduleUsage) {
    combined.set(name, { moduleUsage: usage })
  }

  for (const [name, usage] of scriptUsage) {
    const current = combined.get(name)
    combined.set(name, {
      ...current,
      scriptUsage: usage,
    })
  }

  return combined
}

function summarizeRuntimeDependencyIssues(
  diagnostics: SiteRuntimeDiagnostic[],
): RuntimeDependencyIssue[] {
  const issues = new Map<string, RuntimeDependencyIssue>()

  for (const diagnostic of diagnostics) {
    if (!diagnostic.packageName) continue
    if (
      diagnostic.code !== 'runtime-dependency-missing' &&
      diagnostic.code !== 'runtime-dependency-dev-only' &&
      diagnostic.code !== 'runtime-dependency-node-builtin' &&
      diagnostic.code !== 'runtime-dependency-invalid-name'
    ) {
      continue
    }

    const key = `${diagnostic.code}:${diagnostic.packageName}`
    if (issues.has(key)) continue

    const message =
      diagnostic.code === 'runtime-dependency-missing'
        ? 'missing from dependencies'
        : diagnostic.code === 'runtime-dependency-dev-only'
          ? 'declared as devDependency'
          : diagnostic.code === 'runtime-dependency-node-builtin'
            ? 'not available in browser runtime'
            : 'has an invalid package name'
    const action =
      diagnostic.code === 'runtime-dependency-missing'
        ? 'add'
        : diagnostic.code === 'runtime-dependency-dev-only'
          ? 'move-to-runtime'
          : null

    issues.set(key, {
      code: diagnostic.code,
      packageName: diagnostic.packageName,
      message,
      action,
    })
  }

  return [...issues.values()]
}


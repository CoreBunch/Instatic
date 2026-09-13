/**
 * Install / installed / remove control for one package.
 *
 *   not installed → version picker + "Install" split button (dev dependency
 *                   in the menu). With no package details — a registry
 *                   outage, or a name the registry does not list — it falls
 *                   back to declaring an open range, which is what the
 *                   resolver would pick anyway.
 *   installed     → locked-version pill + "Remove"; while the auto-resolve
 *                   runs it reads "Resolving…", and a failed resolve shows
 *                   the error with a retry right here, where the install
 *                   happened. Needs nothing from the registry, so a package
 *                   the registry no longer answers for can still be removed.
 *   removing      → the editor's confirm-delete dialog, naming what still
 *                   uses the package
 *
 * Both mutations are gated by `runtime.dependencies`; without it the buttons
 * stay visible but disabled, with the reason as their tooltip.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { SplitButton } from '@ui/components/SplitButton'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { RegistryPackageDetails } from '@core/registry'
import type { InstalledDependencies } from './useInstalledDependencies'
import { formatDependencyUsage } from './runtimeIssues'
import { versionChoices } from './packageVersions'
import styles from './InstallControl.module.css'

/** Offered when the registry could not describe the package: the resolver reads `*` as "newest". */
const ANY_VERSION = 'latest'

interface InstallControlProps {
  name: string
  /** Null while the package page is still loading or failed; the install branch then offers `latest`. */
  details: RegistryPackageDetails | null
  deps: InstalledDependencies
}

export function InstallControl({ name, details, deps }: InstallControlProps) {
  const [picked, setPicked] = useState<string | null>(null)
  const confirmDelete = useConfirmDelete()

  const declared = deps.declared(name)
  const locked = deps.lockedPackages[name]?.version
  const usage = deps.usageFor(name)

  if (declared) {
    const requestRemove = () =>
      confirmDelete({
        title: `Remove ${name}?`,
        description: usage
          ? `Used by ${formatDependencyUsage(usage)}. Those imports will stop resolving.`
          : 'The package is removed from this site’s manifest.',
        confirmLabel: 'Remove',
        // Removing a dependency is a manifest change with a blast radius
        // beyond the editor, and the `confirmBeforeDelete` preference is
        // about canvas layers. Always ask.
        alwaysConfirm: true,
        commit: () => deps.remove(name),
      })
    const removeButton = (
      <Button
        variant="secondary"
        size="sm"
        onClick={requestRemove}
        disabled={!deps.canManage}
        tooltip={deps.manageBlockedReason}
        data-testid={`dependency-remove-${name}`}
      >
        Remove
      </Button>
    )

    if (!locked && deps.resolve.kind === 'error') {
      return (
        <div className={styles.stack} data-testid={`dependency-installed-${name}`}>
          <div className={styles.errorRow} role="alert">
            <WarningDiamondSolidIcon size={11} aria-hidden="true" />
            <span className={styles.errorText}>{deps.resolve.message}</span>
          </div>
          <div className={styles.row}>
            <Button
              variant="primary"
              size="sm"
              onClick={deps.retryResolve}
              disabled={!deps.canManage}
              tooltip={deps.manageBlockedReason}
              data-testid={`dependency-retry-${name}`}
            >
              Retry resolve
            </Button>
            {removeButton}
          </div>
        </div>
      )
    }

    return (
      <div className={styles.row} data-testid={`dependency-installed-${name}`}>
        <span className={styles.installedPill}>
          <CheckIcon size={10} aria-hidden="true" />
          {locked ? (
            <span data-testid={`dependency-locked-${name}`}>v{locked}</span>
          ) : deps.resolve.kind === 'resolving' ? (
            'Resolving…'
          ) : (
            declared.range
          )}
          {declared.dev && <span className={styles.devTag}>dev</span>}
        </span>
        {removeButton}
      </div>
    )
  }

  const choices = details ? versionChoices(details) : []
  const options = choices.length > 0 ? choices : [ANY_VERSION]
  const version = picked ?? options[0]

  return (
    <div className={styles.row}>
      <Select
        fieldSize="sm"
        aria-label="Version to install"
        value={version}
        onChange={(event) => setPicked(event.target.value)}
        options={options.map((choice) => ({ value: choice, label: choice }))}
        className={styles.versionSelect}
        disabled={options.length < 2}
      />
      <SplitButton
        label="Install"
        icon={ArrowDownIcon}
        variant="primary"
        size="sm"
        onClick={() => deps.install(name, version)}
        // `disabled` covers the primary half only, so the gate has to remove
        // the menu items too — otherwise "Install as dev dependency" stays
        // clickable without the capability.
        menuItems={deps.canManage
          ? [{ id: 'dev', label: 'Install as dev dependency', onSelect: () => deps.install(name, version, true) }]
          : []}
        disabled={!deps.canManage}
        primaryTooltip={deps.manageBlockedReason}
        menuTriggerLabel="More install options"
        menuLabel="Install options"
        primaryTestId={`dependency-install-${name}`}
      />
    </div>
  )
}

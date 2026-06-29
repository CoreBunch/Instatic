/**
 * FrameworkImportModal — the onboarding "Choose Core Framework import" step.
 *
 * Offers two ways to seed `site.settings.framework` from the Core Framework
 * default preset (colors, typography + spacing scales, utility-class
 * generators), built by `buildCoreFrameworkSettings`:
 *
 *   • Full framework  — every generated utility class (`.bg-primary`,
 *     `.text-l`, `.padding-m`, …) PLUS the `:root` variables. Tree-shaking is
 *     turned off so the complete utility set ships in `framework.css`.
 *   • Variables only  — the same `:root` custom properties (colors, shades,
 *     tints, transparent steps, scale clamps) with NO utility classes.
 *
 * Applying loads the site shell, drops the built `FrameworkSettings` onto
 * `settings.framework`, and saves the shell only (no page/component/layout
 * rewrite). On success it calls `onImported` so the dashboard refreshes the
 * onboarding facts and the step flips to "done".
 */
import { useRef, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SlidersHorizontalIcon } from 'pixel-art-icons/icons/sliders-horizontal'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { cn } from '@ui/cn'
import { buildCoreFrameworkSettings } from '@core/framework'
import { cmsAdapter } from '@core/persistence/cms'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { PixelArtIconComponent } from '@core/dashboard'
import styles from './FrameworkImportModal.module.css'

type ImportMode = 'full' | 'variables'

interface ModeOption {
  id: ImportMode
  title: string
  desc: string
  icon: PixelArtIconComponent
  bullets: readonly string[]
}

const MODES: readonly ModeOption[] = [
  {
    id: 'full',
    title: 'Full framework',
    desc: 'Utility classes + variables. The complete Core Framework, ready to use on the canvas.',
    icon: CodeIcon,
    bullets: [
      'Color, text & spacing utility classes',
      ':root variables for every token',
      'Whole utility set shipped in framework.css',
    ],
  },
  {
    id: 'variables',
    title: 'Variables only',
    desc: 'Just the :root custom properties — bring your own classes and CSS.',
    icon: SlidersHorizontalIcon,
    bullets: [
      ':root variables for every token',
      'Shades, tints & transparent steps',
      'No generated utility classes',
    ],
  },
]

interface FrameworkImportModalProps {
  open: boolean
  onClose: () => void
  /** Called after the framework settings were saved successfully. */
  onImported: () => void
  /** True when the site already carries framework settings (import overwrites). */
  alreadyConfigured: boolean
}

export function FrameworkImportModal({
  open,
  onClose,
  onImported,
  alreadyConfigured,
}: FrameworkImportModalProps) {
  const [mode, setMode] = useState<ImportMode>('full')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const importButtonRef = useRef<HTMLButtonElement | null>(null)

  function requestClose() {
    if (saving) return
    setError(null)
    onClose()
  }

  async function handleImport() {
    setSaving(true)
    setError(null)
    try {
      const site = await cmsAdapter.loadSite('default')
      if (!site) {
        throw new Error('Site is not ready yet — finish setup first.')
      }
      site.settings.framework = buildCoreFrameworkSettings({
        includeUtilities: mode === 'full',
      })
      // Shell-only save: empty dirty sets keep pages/components/layouts
      // untouched while the shell PUT persists the new framework settings.
      await cmsAdapter.saveSite(site, {
        baselinePageIds: site.pages.map((page) => page.id),
        dirty: {
          all: false,
          pageIds: new Set(),
          componentIds: new Set(),
          layoutIds: new Set(),
        },
      })
      onImported()
      onClose()
    } catch (err) {
      console.error('[FrameworkImportModal] import failed:', err)
      setError(getErrorMessage(err, 'Could not import the framework.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      eyebrow="Core Framework"
      title="Import the framework"
      size="lg"
      initialFocusRef={importButtonRef}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            ref={importButtonRef}
            variant="primary"
            onClick={handleImport}
            disabled={saving}
          >
            {saving ? 'Importing…' : 'Import framework'}
          </Button>
        </>
      }
    >
      <p className={styles.lede}>
        Seed your design tokens from the Core Framework defaults — colors, a
        fluid type scale, a spacing scale, and their utility classes. Pick how
        much you want.
      </p>

      <div className={styles.options} role="radiogroup" aria-label="Import mode">
        {MODES.map((option) => {
          const OptionIcon = option.icon
          const selected = mode === option.id
          return (
            <button
              type="button"
              key={option.id}
              role="radio"
              aria-checked={selected}
              className={cn(styles.option, selected && styles.optionSelected)}
              onClick={() => setMode(option.id)}
              disabled={saving}
            >
              <span className={styles.optionHead}>
                <span className={styles.optionIcon} aria-hidden="true">
                  <OptionIcon size={16} />
                </span>
                <span className={styles.optionTitle}>{option.title}</span>
                {selected && (
                  <span className={styles.optionTick} aria-hidden="true">
                    <CheckIcon size={11} />
                  </span>
                )}
              </span>
              <span className={styles.optionDesc}>{option.desc}</span>
              <ul className={styles.optionBullets}>
                {option.bullets.map((bullet) => (
                  <li key={bullet}>
                    <span className={styles.bulletIcon} aria-hidden="true">
                      <CheckIcon size={11} />
                    </span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </button>
          )
        })}
      </div>

      {alreadyConfigured && (
        <p className={styles.note} role="status">
          Your site already has framework settings. Importing replaces them with
          the Core Framework defaults.
        </p>
      )}

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}

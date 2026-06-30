/**
 * OnboardingPanel — five-step setup checklist rendered above the widget
 * grid. Step state comes from `useOnboardingState` (live CMS lookups),
 * so steps tick to "done" as the user actually completes them.
 *
 * Layout
 * ------
 * Two-column grid (collapses to a single column on narrow viewports):
 *
 *   ┌──────────────────────┬───────────────────────────────────┐
 *   │                      │  step 1 — full-width row          │
 *   │   (big progress      ├───────────────────────────────────┤
 *   │    ring)             │  step 2 — full-width row          │
 *   │                      ├───────────────────────────────────┤
 *   │   Finish setting     │  step 3                           │
 *   │   up your site       ├───────────────────────────────────┤
 *   │   (large headline    │  …                                │
 *   │    below the ring)   │                                   │
 *   │                      │                                   │
 *   │   short description  │                                   │
 *   │                      │                                   │
 *   │   [Dismiss]          │                                   │
 *   └──────────────────────┴───────────────────────────────────┘
 *
 * The panel stays visible at all times until the user dismisses it
 * (the previous "Hide steps" toggle was removed — there's no in-between
 * collapsed state). Dismissal persists in localStorage per user.
 */
import { useState } from 'react'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { Button } from '@ui/components/Button'
import type { PixelArtIconComponent } from '@core/dashboard'
import type { OnboardingFacts, OnboardingStepState } from '../hooks/useOnboardingState'
import { LiquidProgressRing } from './LiquidProgressRing'
import {
  FrameworkManagerDialog,
  type FrameworkManagerApplier,
} from '@admin/shared/dialogs/FrameworkManagerDialog'
import { cmsAdapter } from '@core/persistence/cms'
import { applyFrameworkPreset } from '@core/framework'
import { reconcileFrameworkClasses } from '@site/store/slices/site/framework/reconcile'
import styles from './OnboardingPanel.module.css'

interface StepDef {
  id: keyof Pick<OnboardingFacts, 'identity' | 'framework' | 'firstPage' | 'plugin' | 'team'>
  title: string
  desc: string
  cta: string
  icon: PixelArtIconComponent
  action:
    | { kind: 'navigate'; to: string }
    | { kind: 'settings-modal' }
    | { kind: 'framework-import' }
}

const STEPS: readonly StepDef[] = [
  {
    id: 'identity',
    title: 'Set site identity',
    desc:
      'Pick a favicon, logo and site title. Used everywhere — admin chrome, OG tags, published pages.',
    cta: 'Open settings',
    icon: ImageSolidIcon,
    action: { kind: 'settings-modal' },
  },
  {
    id: 'framework',
    title: 'Choose Core Framework import',
    desc:
      'Variables only, the full utility framework, or skip it and bring your own CSS.',
    cta: 'Import',
    icon: CodeIcon,
    action: { kind: 'framework-import' },
  },
  {
    id: 'firstPage',
    title: 'Create your first page',
    desc:
      'Start from a blank canvas, a starter layout, or import HTML and we will scaffold a tree.',
    cta: 'New page',
    icon: FileTextSolidIcon,
    action: { kind: 'navigate', to: '/admin/site' },
  },
  {
    id: 'plugin',
    title: 'Install a plugin',
    desc:
      'Add SEO, comments, image optimization or workflow extensions from the registry.',
    cta: 'Browse plugins',
    icon: PackageSolidIcon,
    action: { kind: 'navigate', to: '/admin/plugins' },
  },
  {
    id: 'team',
    title: 'Invite your team',
    desc:
      'Editors, designers and developers — each role gets a tuned set of editor permissions.',
    cta: 'Add members',
    icon: UsersSolidIcon,
    action: { kind: 'navigate', to: '/admin/users' },
  },
]

interface OnboardingPanelProps {
  facts: OnboardingFacts
  onDismiss: () => void
  /** Called after the Core Framework import saved — refresh the onboarding facts. */
  onFrameworkImported: () => void
}

function stateLabel(state: OnboardingStepState): string {
  if (state === 'done') return 'Completed'
  if (state === 'active') return 'In progress'
  return 'Not started'
}

export function OnboardingPanel({ facts, onDismiss, onFrameworkImported }: OnboardingPanelProps) {
  const navigate = useAdminNavigate()
  const openSettings = useAdminUi((s) => s.openSettings)
  const [frameworkImportOpen, setFrameworkImportOpen] = useState(false)

  // Same dialog, same behaviour as the in-editor Manage Framework host: the
  // full Full / Variables only / None state picker, reconciled the same way
  // (merge add-missing + flip utilities). Onboarding just persists through the
  // cmsAdapter instead of the live editor store.
  const onboardingApplier: FrameworkManagerApplier = {
    capabilities: { canRemove: true },
    apply: async (target) => {
      const site = await cmsAdapter.loadSite('default')
      if (!site) throw new Error('Site is not ready yet — finish setup first.')
      site.settings.framework = applyFrameworkPreset(site.settings.framework, target)
      // Regenerate / prune the generated `framework:` utility classes (and strip
      // stale classIds off nodes) to match the new settings — the same reconcile
      // the in-editor store runs. Without it, removing the framework here would
      // leave its `.text-primary` / `.bg-primary` classes lingering in the saved
      // styleRules, so the Site editor keeps showing them until a hard refresh.
      reconcileFrameworkClasses(site)
      await cmsAdapter.saveSite(site, {
        baselinePageIds: site.pages.map((page) => page.id),
        dirty: { all: false, pageIds: new Set(), componentIds: new Set(), layoutIds: new Set() },
      })
      // The framework settings were written to storage outside the editor. If
      // the Site editor's store was hydrated earlier this session, its in-memory
      // `site` is now stale and `usePersistence`'s mount-load early-returns
      // without refetching — so the editor would keep showing the pre-import
      // framework ("stuck on variables only"). Signal a reload, matching every
      // other out-of-editor site mutation (bundle import, plugin install, data
      // edits). The in-editor applier doesn't need this — it mutates the store
      // directly.
      requestCmsSiteReload()
    },
  }

  const states = STEPS.map((step) => ({ step, state: facts[step.id] }))
  const done = states.filter((s) => s.state === 'done').length
  const total = STEPS.length

  function runStep(step: StepDef) {
    if (step.action.kind === 'navigate') {
      navigate(step.action.to)
    } else if (step.action.kind === 'framework-import') {
      setFrameworkImportOpen(true)
    } else {
      openSettings('general')
    }
  }

  return (
    <section className={styles.onboarding}>
      <header className={styles.head}>
        <div className={styles.headBlock}>
          <LiquidProgressRing value={done} total={total} />
          <h2 className={styles.headTitle}>Finish setting up your site</h2>
          <p className={styles.headDesc}>
            {done} of {total} steps complete. Hit each one in any order — your site is live the
            moment you publish a page.
          </p>
        </div>
        <div className={styles.headActions}>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </header>
      <ol className={styles.steps}>
        {states.map(({ step, state }, i) => {
          const StepIcon = step.icon
          const variant: 'ghost' | 'secondary' | 'primary' =
            state === 'done' ? 'ghost' : state === 'active' ? 'primary' : 'secondary'
          return (
            <li className={styles.step} data-state={state} key={step.id}>
              <span className={styles.stepCheck} aria-hidden="true">
                {state === 'done' ? (
                  <CheckIcon size={11} />
                ) : (
                  String(i + 1).padStart(2, '0')
                )}
              </span>
              <span className={styles.stepIcon} aria-hidden="true">
                <StepIcon size={14} />
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepTitle}>
                  <span className={styles.stepIndex}>STEP {String(i + 1).padStart(2, '0')}</span>
                  <span>{step.title}</span>
                </div>
                <div className={styles.stepDesc}>{step.desc}</div>
              </div>
              <div className={styles.stepCta}>
                <span className={styles.stepHint} data-state={state}>
                  {stateLabel(state)}
                </span>
                <Button
                  variant={variant}
                  size="sm"
                  onClick={() => runStep(step)}
                >
                  {step.cta}
                  <ChevronRightIcon size={10} aria-hidden="true" />
                </Button>
              </div>
            </li>
          )
        })}
      </ol>

      <FrameworkManagerDialog
        open={frameworkImportOpen}
        onClose={() => setFrameworkImportOpen(false)}
        applier={onboardingApplier}
        currentState={facts.framework === 'done' ? 'full' : 'none'}
        // The onboarding step's intent is "import the framework" — open with
        // Full pre-selected so the primary button reads "Import framework" and
        // one click imports, rather than landing on the no-op current state.
        initialTarget="full"
        onApplied={onFrameworkImported}
      />
    </section>
  )
}

import { Suspense, useState } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { AppLoadingScreen } from './AppLoadingScreen'
import type { AdminWorkspace } from './workspace'
import { AdminPreAuthForm, type PreAuthPhase } from './preauth/AdminPreAuthForm'
import { useAdminBoot } from './preauth/useAdminBoot'
import { prewarmedLazy } from './lib/prewarmedLazy'
import { useEditorAppearancePreferences } from '@site/preferences/editorPreferences'

// AuthenticatedAdmin lives in its own chunk so the cold /admin login screen
// never downloads / evaluates SpotlightRoot, AdminSessionProvider,
// StepUpProvider, installPluginRuntime, or any of the per-workspace page
// chunks. The chunk only fires when `boot.phase === 'editor'` — i.e. after
// a successful login. Cold-load JS execution gap drops by ~50–100 ms
// because the browser doesn't compile + execute the authenticated
// provider tree during the unauthenticated boot probe.
//
// `prewarmedLazy` (vs React.lazy) gives us two properties React.lazy lacks:
//   1. Synchronous-render fast path once the chunk has loaded — eliminates
//      the one-tick Suspense flash that React.lazy produces even when the
//      module is fully cached.
//   2. Explicit `.preload()` trigger so we can kick off the chunk fetch
//      AS SOON AS we have a hint the user is authenticated (cookie sniff
//      at module load — see below) instead of waiting for the boot probe
//      to resolve. The chunk downloads IN PARALLEL with the /me request
//      instead of sequentially after it.
const AuthenticatedAdmin = prewarmedLazy<{ section: AdminWorkspace; currentUser: CmsCurrentUser }>(
  () => import('./AuthenticatedAdmin'),
  { displayName: 'AuthenticatedAdmin' },
)

// Speculative preload at module-evaluation time.
//
// `window.__instaticAuthed` is set by `server/static.ts` ONLY when the request
// carried a valid session cookie. The session cookie itself is HttpOnly
// (XSS mitigation) so JS can't read it directly — the server tells us
// "yes, this user is authenticated" via this flag.
//
// In numbers: this moves AuthenticatedAdmin's chunk download from "after
// /me resolves (~150-250 ms post-mount)" to "in parallel with /me (~5 ms
// post-mount)". On the cached-chunk path the preload returns the cached
// promise instantly — no penalty. main.tsx ALSO `await`s the import for
// the same cookie-bearing path, which forces the post-Suspense render to
// be flushSync-able and eliminates the concurrent-mode commit delay.
if (typeof window !== 'undefined' && (window as unknown as { __instaticAuthed?: number }).__instaticAuthed === 1) {
  void AuthenticatedAdmin.preload().catch(() => {
    // Best-effort. If the preload fails the cold-path render will retry
    // when React actually requests AuthenticatedAdmin via Suspense.
  })
}

type AdminSection = AdminWorkspace

// After boot, the pre-auth form can lift us into MFA or into the editor.
// `null` means "follow whatever the boot hook resolved to" — the form has
// not produced a transition yet.
type PreAuthOverride =
  | { phase: PreAuthPhase }
  | { phase: 'editor'; user: CmsCurrentUser }

interface AdminEntryProps {
  section?: AdminSection
}

export default function AdminEntry({ section = 'dashboard' }: AdminEntryProps) {
  useEditorAppearancePreferences()
  const boot = useAdminBoot()
  const [override, setOverride] = useState<PreAuthOverride | null>(null)

  if (boot.status === 'loading') return <AppLoadingScreen />

  const livePhase = override?.phase ?? boot.phase
  const liveUser =
    override?.phase === 'editor' ? override.user : boot.currentUser

  if (livePhase === 'editor') {
    if (!liveUser) return <AppLoadingScreen />
    return (
      <Suspense fallback={<AppLoadingScreen />}>
        <AuthenticatedAdmin section={section} currentUser={liveUser} />
      </Suspense>
    )
  }

  return (
    <AdminPreAuthForm
      phase={livePhase}
      publicSite={boot.publicSite}
      initialError={boot.initialError}
      onPhaseChange={(phase) => setOverride({ phase })}
      onAuthenticated={(user) => setOverride({ phase: 'editor', user })}
    />
  )
}

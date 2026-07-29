/**
 * useSiteSettingsController — one source of truth for the Settings modal's
 * site-level fields (General + Publishing), regardless of which admin page
 * opened the modal.
 *
 * The problem this solves
 * ───────────────────────
 * The Settings modal is global — openable from every admin route — but its
 * General and Publishing sections used to read `site` straight off the heavy
 * editor store (`@site/store/store`). That store is only hydrated by
 * `usePersistence` on the Site editor (AdminCanvasLayout). On Content / Data /
 * Media (AdminWorkspaceCanvasLayout) and Plugins / Users / Account
 * (AdminPageLayout) the editor store's `site` is `null`, so those sections
 * rendered an endless skeleton. Settings was only "global" in name.
 *
 * Two genuinely different sources of truth
 * ────────────────────────────────────────
 * The fields edited here (`name`, `settings.*`, framework preferences) live in
 * the persisted `SiteDocument`. Where that document lives depends on context:
 *
 *   - On the Site editor, the document is a LIVE DRAFT in the editor store with
 *     unsaved page-tree edits. Settings edits MUST join that draft (so they
 *     save together via the editor's autosave / Save pipeline and are never
 *     clobbered). → delegate to the editor store mutations.
 *
 *   - Everywhere else there is no in-memory draft. Settings edits load the
 *     persisted document, patch it, and persist it immediately through the CMS
 *     adapter (there is no Save button on those pages). → use the standalone
 *     store below.
 *
 * This hook hides that split behind one uniform shape. It reads BOTH stores
 * unconditionally (hooks can't be conditional) and picks the active source by
 * whether the editor store currently holds a hydrated `site`.
 *
 * Bundle isolation: this module is only ever imported by the lazy SettingsModal
 * section components, so the editor-store import it carries stays inside the
 * settings chunk and never enters the eager graph of the light admin layouts.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { cmsAdapter } from '@core/persistence/cms'
import { SaveConflictError } from '@core/persistence/saveConflict'
import { DEFAULT_FRAMEWORK_PREFERENCES } from '@core/framework'
import type { SiteDocument, SiteSettings } from '@core/page-tree'
import type { FrameworkPreferencesSettings } from '@core/framework-schema'
import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { getErrorMessage } from '@core/utils/errorMessage'

const SITE_ID = 'default'

/**
 * Save only the site shell (name + settings) — leave pages / components /
 * layouts untouched. `saveSite` always writes the shell; empty changed and
 * deleted sets (with `all: false`) make the incremental save touch no rows
 * at all. See `CmsAdapter.saveSite`.
 */
const SHELL_ONLY_DIRTY = {
  all: false,
  pageIds: new Set<string>(),
  componentIds: new Set<string>(),
  layoutIds: new Set<string>(),
  deletedPageIds: new Set<string>(),
  deletedComponentIds: new Set<string>(),
  deletedLayoutIds: new Set<string>(),
} as const

interface SettingsDraftState {
  /** The persisted document loaded for standalone (non-editor) editing. */
  doc: SiteDocument | null
  /**
   * The shell seq this store last synchronized with — the conflict-detection
   * base its shell-only saves ship (and bump from each save response).
   */
  shellBaseSeq: number
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Load the document once (idempotent; shares a single in-flight fetch). */
  ensureLoaded: () => Promise<void>
  updateName: (name: string) => void
  updateSettings: (patch: Partial<SiteSettings>) => void
  updateFrameworkPreferences: (patch: Partial<FrameworkPreferencesSettings>) => void
}

let inFlightLoad: Promise<void> | null = null
// Serialise PUTs so two quick edits (e.g. toggle then blur) can't race to a
// last-writer-wins on the server out of order.
let saveChain: Promise<void> = Promise.resolve()

/**
 * Standalone draft store — used only when the editor store is NOT the source
 * of truth (any admin page other than the Site editor). Holds the full
 * SiteDocument so shell saves can reuse it without re-fetching.
 */
const useSettingsDraftStore = create<SettingsDraftState>((set, get) => {
  function persist(next: SiteDocument): void {
    set({ doc: next })
    saveChain = saveChain
      .then(() =>
        cmsAdapter.saveSite(next, {
          dirty: SHELL_ONLY_DIRTY,
          baseSeqs: {},
          shellBaseSeq: get().shellBaseSeq,
        }),
      )
      .then(({ seq }) => {
        // This save's seq is the new shell base for the next one.
        set({ shellBaseSeq: seq })
        // Refresh the toolbar brand + any other site-summary readers, and let
        // the editor store re-hydrate from disk next time it loads.
        useAdminUi.getState().setSiteSummary({
          name: next.name,
          faviconUrl: next.settings.faviconUrl ?? null,
        })
        requestCmsSiteReload()
      })
      .catch((err: unknown) => {
        console.error('[useSiteSettingsController] failed to save site settings:', err)
        if (err instanceof SaveConflictError) {
          // Another admin changed the shell since this modal loaded. The
          // stale doc must not be re-saved over their work — force a reload
          // on the next open instead of offering a per-row banner here.
          set({
            doc: null,
            status: 'idle',
            error: 'Site settings were changed by another admin — close and reopen Settings to load the latest.',
          })
          return
        }
        set({ error: getErrorMessage(err, 'Failed to save site settings') })
      })
  }

  return {
    doc: null,
    shellBaseSeq: 0,
    status: 'idle',
    error: null,

    ensureLoaded: async () => {
      if (get().status === 'ready' || get().status === 'loading') return
      if (inFlightLoad) return inFlightLoad
      set({ status: 'loading', error: null })
      inFlightLoad = (async () => {
        try {
          const result = await cmsAdapter.loadSite(SITE_ID)
          if (!result) {
            set({ status: 'error', error: 'No site found. Complete first-run setup first.' })
            return
          }
          set({ doc: result.site, shellBaseSeq: result.shellSeq, status: 'ready', error: null })
        } catch (err) {
          console.error('[useSiteSettingsController] failed to load site settings:', err)
          set({ status: 'error', error: getErrorMessage(err, 'Failed to load site settings') })
        } finally {
          inFlightLoad = null
        }
      })()
      return inFlightLoad
    },

    updateName: (name) => {
      const doc = get().doc
      const trimmed = name.trim()
      if (!doc || !trimmed || doc.name === trimmed) return
      persist({ ...doc, name: trimmed })
    },

    updateSettings: (patch) => {
      const doc = get().doc
      if (!doc) return
      const changed = Object.entries(patch).some(
        ([key, value]) => !Object.is(doc.settings[key as keyof SiteSettings], value),
      )
      if (!changed) return
      persist({ ...doc, settings: { ...doc.settings, ...patch } })
    },

    updateFrameworkPreferences: (patch) => {
      const doc = get().doc
      if (!doc) return
      const entries = Object.entries(patch)
      if (entries.length === 0) return
      const current = doc.settings.framework?.preferences ?? DEFAULT_FRAMEWORK_PREFERENCES
      const changed = entries.some(
        ([key, value]) => !Object.is(current[key as keyof typeof current], value),
      )
      if (!changed) return
      const framework = doc.settings.framework ?? { colors: { tokens: [] } }
      persist({
        ...doc,
        settings: {
          ...doc.settings,
          framework: { ...framework, preferences: { ...current, ...patch } },
        },
      })
    },
  }
})

/** Uniform view of the site-level settings consumed by the modal sections. */
export interface SiteSettingsController {
  /** `null` while loading or on error — sections render a skeleton / alert. */
  site: { name: string; settings: SiteSettings } | null
  error: string | null
  updateSiteName: (name: string) => void
  updateSiteSettings: (patch: Partial<SiteSettings>) => void
  updateFrameworkPreferences: (patch: Partial<FrameworkPreferencesSettings>) => void
}

export function useSiteSettingsController(): SiteSettingsController {
  // Editor-store source (Site editor). Subscribing here is harmless on other
  // pages — `site` is simply `null` and never hydrates.
  const editorSite = useEditorStore((s) => s.site)
  const editorUpdateName = useEditorStore((s) => s.updateSiteName)
  const editorUpdateSettings = useEditorStore((s) => s.updateSiteSettings)
  const editorUpdateFrameworkPreferences = useEditorStore((s) => s.updateFrameworkPreferences)

  // Standalone source (every other admin page).
  const draftDoc = useSettingsDraftStore((s) => s.doc)
  const draftError = useSettingsDraftStore((s) => s.error)
  const ensureLoaded = useSettingsDraftStore((s) => s.ensureLoaded)
  const standaloneUpdateName = useSettingsDraftStore((s) => s.updateName)
  const standaloneUpdateSettings = useSettingsDraftStore((s) => s.updateSettings)
  const standaloneUpdateFrameworkPreferences = useSettingsDraftStore(
    (s) => s.updateFrameworkPreferences,
  )

  const editorActive = editorSite !== null

  useEffect(() => {
    if (editorActive) return
    void ensureLoaded()
  }, [editorActive, ensureLoaded])

  if (editorActive) {
    return {
      site: { name: editorSite.name, settings: editorSite.settings },
      error: null,
      updateSiteName: editorUpdateName,
      updateSiteSettings: editorUpdateSettings,
      updateFrameworkPreferences: editorUpdateFrameworkPreferences,
    }
  }

  return {
    site: draftDoc ? { name: draftDoc.name, settings: draftDoc.settings } : null,
    error: draftError,
    updateSiteName: standaloneUpdateName,
    updateSiteSettings: standaloneUpdateSettings,
    updateFrameworkPreferences: standaloneUpdateFrameworkPreferences,
  }
}

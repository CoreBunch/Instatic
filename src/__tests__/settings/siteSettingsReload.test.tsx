/**
 * The standalone branch of useSiteSettingsController (every admin page except
 * the Site editor) caches the loaded site document. A site write made outside
 * the Settings modal — an import, a plugin install — announces itself with
 * `requestCmsSiteReload()`; the next Settings render must show that document,
 * not the one cached before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { useSiteSettingsController } from '@admin/modals/Settings/useSiteSettingsController'
import { GeneralSection } from '@admin/modals/Settings/sections/GeneralSection'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { cmsAdapter } from '@core/persistence/cms'
import type { SiteDocument } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { currentBranchId } from '@admin/state/activeBranch'
import { useBranchStore } from '@admin/state/branchStore'
import { makeSite } from '../fixtures'

/** Minimal Settings section: shows the site name and renames it on click. */
function SiteNameProbe() {
  const { site, updateSiteName } = useSiteSettingsController()
  if (!site) return <p>loading</p>
  return (
    <div>
      <p data-testid="site-name">{site.name}</p>
      <button type="button" onClick={() => updateSiteName(`${site.name}+`)}>
        Rename
      </button>
    </div>
  )
}

const before: SiteDocument = makeSite({ name: 'Before import' })
const after: SiteDocument = makeSite({ name: 'Imported site' })

let served: SiteDocument = before
let loads = 0
const originalLoad = cmsAdapter.loadSite.bind(cmsAdapter)
const originalSave = cmsAdapter.saveSite.bind(cmsAdapter)

beforeEach(() => {
  served = before
  loads = 0
  useEditorStore.setState({ site: null } as Parameters<typeof useEditorStore.setState>[0])
  cmsAdapter.loadSite = async () => {
    loads++
    return { site: served, rowSeqs: {}, shellSeq: loads }
  }
  cmsAdapter.saveSite = async () => ({ seq: 100 + loads })
  // The standalone store is a module singleton: start every test from a
  // stale cache so it loads `before`.
  requestCmsSiteReload()
})
afterEach(() => {
  cleanup()
  useBranchStore.getState().setActiveBranch('main')
  cmsAdapter.loadSite = originalLoad
  cmsAdapter.saveSite = originalSave
})

async function shownName(): Promise<string> {
  return (await screen.findByTestId('site-name')).textContent ?? ''
}

describe('Settings outside the Site editor after an out-of-modal site write', () => {
  it('shows the imported document, not the one cached before the import', async () => {
    const first = render(<SiteNameProbe />)
    expect(await shownName()).toBe('Before import')
    first.unmount()

    // Site import (Replace) finished on the Data page.
    served = after
    requestCmsSiteReload()

    render(<SiteNameProbe />)
    await waitFor(async () => expect(await shownName()).toBe('Imported site'))
  })

  it('reloads while the modal stays open', async () => {
    render(<SiteNameProbe />)
    expect(await shownName()).toBe('Before import')
    served = after
    requestCmsSiteReload()
    await waitFor(async () => expect(await shownName()).toBe('Imported site'))
  })

  it('does not refetch after its own save', async () => {
    render(<SiteNameProbe />)
    await shownName()
    const loadsBefore = loads
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(async () => expect(await shownName()).toBe('Before import+'))
    // Let the chained save settle (it dispatches the reload event itself).
    await new Promise((r) => setTimeout(r, 20))
    expect(loads).toBe(loadsBefore)
  })

  it('an import announced while the first load is in flight still reloads', async () => {
    // The beforeEach reload request ran before any render; start from a
    // load that is still pending when the next import lands.
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => { release = r })
    cmsAdapter.loadSite = async () => {
      loads++
      const site = served
      if (loads === 1) await gate
      return { site, rowSeqs: {}, shellSeq: loads }
    }
    render(<SiteNameProbe />)
    await waitFor(() => expect(loads).toBe(1))
    served = after
    requestCmsSiteReload()
    release?.()
    await waitFor(async () => expect(await shownName()).toBe('Imported site'))
  })

  it('a reload that started before a save never rolls the save back', async () => {
    render(<SiteNameProbe />)
    await shownName()
    // A reload starts; its response is held back and carries the old document.
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => { release = r })
    const old = served
    let serverSeq = 2
    cmsAdapter.loadSite = async () => {
      loads++
      // The held-back response carries the document and seq from before the save.
      const snapshot = loads === 2 ? { site: old, seq: 2 } : { site: served, seq: serverSeq }
      if (loads === 2) await gate
      return { site: snapshot.site, rowSeqs: {}, shellSeq: snapshot.seq }
    }
    const seqs: number[] = []
    cmsAdapter.saveSite = async (doc, opts) => {
      seqs.push(opts?.shellBaseSeq ?? -1)
      served = doc
      serverSeq = 500 + seqs.length
      return { seq: serverSeq }
    }
    requestCmsSiteReload()
    await waitFor(() => expect(loads).toBe(2))
    // Meanwhile the user renames the site; it saves (seq 501).
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(seqs.length).toBe(1))
    release?.()
    await new Promise((r) => setTimeout(r, 30))
    // The old response did not replace the saved document …
    await waitFor(async () => expect(await shownName()).toBe('Before import+'))
    // … nor rewind the conflict base: the next save builds on seq 500 or newer.
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(seqs.length).toBe(2))
    expect(seqs[1]).toBeGreaterThanOrEqual(500)
  })
})


it('refreshes the real General settings inputs after an outside write', async () => {
  render(<GeneralSection />)
  const siteName = await screen.findByLabelText('Site Name')
  await waitFor(() => expect((siteName as HTMLInputElement).value).toBe('Before import'))
  served = { ...after, settings: { ...after.settings, metaTitle: 'Imported title', metaDescription: 'Imported description', language: 'fr' } }
  requestCmsSiteReload()
  await waitFor(() => {
    expect((screen.getByLabelText('Site Name') as HTMLInputElement).value).toBe('Imported site')
    expect((screen.getByLabelText('Meta Title') as HTMLInputElement).value).toBe('Imported title')
    expect((screen.getByLabelText('Meta Description') as HTMLTextAreaElement).value).toBe('Imported description')
    expect((screen.getByLabelText('Language') as HTMLInputElement).value).toBe('fr')
  })
})

describe('Settings outside the Site editor after a branch switch', () => {
  const mainSite = makeSite({ name: 'Main site' })
  const branchSite = makeSite({ name: 'Branch site' })

  beforeEach(() => {
    cmsAdapter.loadSite = async () => {
      loads++
      return { site: currentBranchId() === 'main' ? mainSite : branchSite, rowSeqs: {}, shellSeq: loads }
    }
  })

  it('never saves the previous branch\'s cached document into the active branch', async () => {
    const saved: Array<{ branch: string; name: string }> = []
    cmsAdapter.saveSite = async (doc) => {
      saved.push({ branch: currentBranchId(), name: doc.name })
      return { seq: 100 }
    }
    const first = render(<SiteNameProbe />)
    expect(await shownName()).toBe('Main site')
    first.unmount()

    useBranchStore.getState().setActiveBranch('feature')
    render(<SiteNameProbe />)
    await waitFor(async () => expect(await shownName()).toBe('Branch site'))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(saved.length).toBe(1))
    expect(saved[0]).toEqual({ branch: 'feature', name: 'Branch site+' })
  })

  it('saves both queued edits to their original branch after a switch', async () => {
    render(<SiteNameProbe />)
    expect(await shownName()).toBe('Main site')
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => { release = r })
    const saved: Array<{ branch: string; name: string }> = []
    const bases: Array<number | undefined> = []
    cmsAdapter.saveSite = async (doc, opts) => {
      bases.push(opts?.shellBaseSeq)
      saved.push({ branch: opts?.branchId ?? currentBranchId(), name: doc.name })
      if (saved.length === 1) await gate
      return { seq: 100 }
    }
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(saved.length).toBe(1))
    useBranchStore.getState().setActiveBranch('feature')
    release?.()
    await waitFor(async () => expect(await shownName()).toBe('Branch site'))
    expect(bases[1]).toBe(100)
    expect(saved).toEqual([
      { branch: 'main', name: 'Main site+' },
      { branch: 'main', name: 'Main site++' },
    ])
  })
})

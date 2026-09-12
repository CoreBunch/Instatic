import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { RegistryPanel } from '@site/panels/DependenciesPanel/RegistryPanel'
import { isDependencyLockInSync } from '@core/site-dependencies/lockStatus'
import { versionRange } from '@site/panels/DependenciesPanel/useInstalledDependencies'
import { formatCount } from '@site/panels/DependenciesPanel/format'
import { useEditorStore } from '@site/store/store'
import { AdminSessionContext } from '@admin/sessionContext'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { CmsCurrentUser } from '@core/persistence'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { makeSite } from '../fixtures'

afterEach(cleanup)
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const MOTION_HIT = {
  name: 'motion',
  version: '12.0.0',
  description: 'Animation library',
  publisher: 'mattgperry',
  date: '2026-08-01T00:00:00.000Z',
  weeklyDownloads: 20_000_000,
  dependents: 1200,
  score: { quality: 1, popularity: 1, maintenance: 1 },
  insecure: false,
}

const DETAILS = {
  name: 'motion',
  description: 'Animation library',
  latest: '12.0.0',
  distTags: { latest: '12.0.0' },
  versions: [{
    version: '12.0.0',
    date: '2026-08-01T00:00:00.000Z',
    deprecated: null,
    license: 'MIT',
    dependencies: { 'framer-motion': '^12.0.0' },
    peerDependencies: {},
    unpackedSize: 1_000_000,
    fileCount: 30,
    esmEntry: { path: './dist/es/index.mjs', source: 'exports' },
    hasTypes: true,
  }],
  versionCount: 1,
  readme: '# Motion\n\nHello from the README',
  homepage: 'https://motion.dev',
  repository: 'https://github.com/motiondivision/motion',
  license: 'MIT',
  maintainers: ['mattgperry'],
  keywords: ['animation'],
  modified: '2026-08-01T00:00:00.000Z',
}

/** A package whose dist-tags list a prerelease before `latest`, as npm's JSON often does. */
const TAGGED_DETAILS = {
  ...DETAILS,
  name: 'tagged',
  latest: '5.0.0',
  distTags: { dev: '1.0.0-dev.1', latest: '5.0.0', next: '6.0.0-beta.2' },
  versions: [
    { ...DETAILS.versions[0], version: '5.0.0' },
    { ...DETAILS.versions[0], version: '1.0.0-dev.1' },
  ],
}

const LOCK_RESPONSE = {
  dependencyLock: {
    version: 1,
    packages: {
      'canvas-confetti': { name: 'canvas-confetti', requested: '^1.9.3', version: '1.9.3', resolvedAt: 123 },
    },
    updatedAt: 123,
  },
}

/** Button renders `aria-disabled` (not `disabled`) when it also carries a tooltip, so the reason stays hoverable. */
function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const MANY_TOTAL = 45
const PAGE_SIZE = 20

/** A paged result set for the query `many`: 45 packages named many-0 … many-44. */
function manyPage(from: number) {
  const hits = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, MANY_TOTAL - from)) }, (_, i) => ({
    ...MOTION_HIT,
    name: `many-${from + i}`,
    description: `Package number ${from + i}`,
  }))
  return { total: MANY_TOTAL, returned: hits.length, hits }
}

/**
 * Serve the registry proxy + resolve endpoints the panel talks to. Search
 * knows `motion` (one hit) and `many` (45 hits, paged); `ghost-pkg` is a
 * package the registry no longer answers for.
 */
function stubRegistryFetch(): string[] {
  const requested: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    requested.push(url.pathname + url.search)
    if (url.pathname.endsWith('/cms/registry')) {
      return registryProfileFails
        ? json({ error: 'Registry unavailable' }, 502)
        : json({ host: 'registry.npmjs.org', publicNpm: true })
    }
    if (url.pathname.endsWith('/registry/search')) {
      const text = url.searchParams.get('q') ?? ''
      if (text === 'many') return json(manyPage(Number(url.searchParams.get('from') ?? '0')))
      const hits = text.includes('motion') ? [MOTION_HIT] : []
      return json({ total: hits.length, returned: hits.length, hits })
    }
    if (url.pathname.endsWith('/latest')) return json({ version: '1.9.4' })
    if (url.pathname.endsWith('/downloads')) return json({ daily: [1, 2, 3, 4, 5, 6, 7, 8], weekly: 35 })
    if (url.pathname.endsWith('/advisories')) return json({ advisories: [] })
    if (url.pathname.includes('/registry/packages/')) {
      const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
      if (name === 'ghost-pkg') return json({ error: 'Package not found' }, 404)
      if (name === 'tagged') return json(TAGGED_DETAILS)
      return json({ ...DETAILS, name })
    }
    if (url.pathname.endsWith('/runtime/dependencies/resolve')) return json(LOCK_RESPONSE)
    return json({ error: 'not stubbed' }, 404)
  }) as typeof fetch
  return requested
}

let registryProfileFails = false

function resetStore() {
  const packageJson = {
    dependencies: { 'canvas-confetti': '^1.9.3' },
    devDependencies: {},
  }
  useEditorStore.setState({
    site: makeSite({
      packageJson,
      runtime: normalizeSiteRuntimeConfig(undefined),
      files: [{
        id: 'script-1',
        path: 'src/scripts/celebrate.ts',
        type: 'script',
        content: `import confetti from 'canvas-confetti'\nimport { animate } from 'motion'`,
        createdAt: 1,
        updatedAt: 1,
      }],
    }),
    packageJson,
    siteRuntime: normalizeSiteRuntimeConfig(undefined),
    activePageId: 'page-1',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
    dependencyResolveStatus: 'idle',
    dependencyResolveLockedCount: 0,
    dependencyResolveError: null,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function lockCanvasConfetti(): void {
  const lockedRuntime = normalizeSiteRuntimeConfig({
    dependencyLock: {
      version: 1,
      packages: {
        'canvas-confetti': { name: 'canvas-confetti', requested: '^1.9.3', version: '1.9.4', resolvedAt: 1 },
      },
      updatedAt: 1,
    },
  })
  useEditorStore.setState({
    site: { ...useEditorStore.getState().site!, runtime: lockedRuntime },
    siteRuntime: lockedRuntime,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  registryProfileFails = false
  resetStore()
  stubRegistryFetch()
})

describe('Dependencies panel: installed packages and runtime issues', () => {
  it('marks packages imported by site scripts as in use', () => {
    render(<RegistryPanel />)
    const row = screen.getByTestId('dep-row-canvas-confetti')
    expect(within(row).getByText('in use')).toBeDefined()
  })

  it('surfaces missing runtime imports and can add them as dependencies', () => {
    render(<RegistryPanel />)
    const issues = screen.getByLabelText('Runtime dependency issues')
    expect(within(issues).getByText('motion')).toBeDefined()
    expect(within(issues).getByText('missing from dependencies')).toBeDefined()

    fireEvent.click(within(issues).getByRole('button', { name: 'Add' }))

    expect(useEditorStore.getState().packageJson.dependencies.motion).toBe('*')
    expect(useEditorStore.getState().site?.packageJson?.dependencies.motion).toBe('*')
  })

  it('shows the locked version on the installed row once the lock is resolved', () => {
    lockCanvasConfetti()
    render(<RegistryPanel />)
    const row = screen.getByTestId('dep-row-canvas-confetti')
    expect(within(row).getByTestId('dep-locked-canvas-confetti').textContent).toBe('1.9.4')
    expect(screen.queryByRole('button', { name: 'Re-resolve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry resolve' })).toBeNull()
  })

  it('exposes a manual Re-resolve button when the lock is out of sync', () => {
    lockCanvasConfetti()
    const packageJson = { dependencies: { 'canvas-confetti': '^1.9.3', motion: '*' }, devDependencies: {} }
    useEditorStore.setState({
      site: { ...useEditorStore.getState().site!, packageJson },
      packageJson,
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<RegistryPanel />)
    expect(screen.getByRole('button', { name: 'Re-resolve' })).toBeDefined()
  })

  it('resolves runtime dependencies into the lock via the manual button', async () => {
    render(<RegistryPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Re-resolve' }))
    expect(await screen.findByText('1 locked')).toBeDefined()
    expect(useEditorStore.getState().siteRuntime.dependencyLock.packages['canvas-confetti']?.version).toBe('1.9.3')
  })

  it('lists dev dependencies in their own group', () => {
    const packageJson = { dependencies: { 'canvas-confetti': '^1.9.3' }, devDependencies: { typescript: '^5' } }
    useEditorStore.setState({
      site: { ...useEditorStore.getState().site!, packageJson },
      packageJson,
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<RegistryPanel />)
    expect(screen.getByText('Dev dependencies')).toBeDefined()
    expect(screen.getByTestId('dep-row-typescript')).toBeDefined()
  })
})

describe('Dependencies panel: registry browsing', () => {
  it('searches the registry, opens a package page, and installs the picked version', async () => {
    render(<RegistryPanel />)
    fireEvent.change(screen.getByTestId('registry-search'), { target: { value: 'motion' } })

    const result = await screen.findByTestId('registry-result-motion', {}, { timeout: 3000 })
    expect(within(result).getByText('Animation library')).toBeDefined()
    fireEvent.click(result)

    const detail = await screen.findByTestId('package-detail-motion')
    expect(await within(detail).findByText('Hello from the README')).toBeDefined()
    expect(within(detail).getByText('ESM')).toBeDefined()
    expect(within(detail).getByText('TS')).toBeDefined()

    fireEvent.click(await within(detail).findByTestId('dependency-install-motion'))

    expect(useEditorStore.getState().packageJson.dependencies.motion).toBe('^12.0.0')
    expect(await within(detail).findByTestId('dependency-installed-motion')).toBeDefined()
  })

  it('offers to open a typed package by exact name when the index does not list it', async () => {
    render(<RegistryPanel />)
    fireEvent.change(screen.getByTestId('registry-search'), { target: { value: 'left-pad' } })

    const open = await screen.findByTestId('registry-open-left-pad', {}, { timeout: 3000 })
    fireEvent.click(open)
    const detail = await screen.findByTestId('package-detail-left-pad')
    expect(await within(detail).findByTestId('dependency-install-left-pad')).toBeDefined()
  })

  it('opens the typed name on Enter instead of whatever the previous query listed', async () => {
    render(<RegistryPanel />)
    const search = screen.getByTestId('registry-search')
    fireEvent.change(search, { target: { value: 'motion' } })
    await screen.findByTestId('registry-result-motion', {}, { timeout: 3000 })

    fireEvent.change(search, { target: { value: 'three' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(await screen.findByTestId('package-detail-three')).toBeDefined()
    expect(screen.queryByTestId('package-detail-motion')).toBeNull()
  })

  it('opens an installed package from its row and always confirms before removing one that is in use', async () => {
    render(
      <ConfirmDeleteProvider>
        <RegistryPanel />
      </ConfirmDeleteProvider>,
    )
    fireEvent.click(screen.getByTestId('dep-row-canvas-confetti'))
    const detail = await screen.findByTestId('package-detail-canvas-confetti')

    fireEvent.click(await within(detail).findByTestId('dependency-remove-canvas-confetti'))
    const dialog = screen.getByRole('alertdialog', { name: 'Remove canvas-confetti?' })
    expect(dialog.textContent).toContain('Used by scripts: celebrate.ts')
    expect(useEditorStore.getState().packageJson.dependencies['canvas-confetti']).toBe('^1.9.3')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()

    fireEvent.click(within(detail).getByTestId('dependency-remove-canvas-confetti'))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(useEditorStore.getState().packageJson.dependencies['canvas-confetti']).toBeUndefined()
  })

  it('still lets an installed package be removed when the registry no longer answers for it', async () => {
    useEditorStore.setState({
      packageJson: { dependencies: { 'canvas-confetti': '^1.9.3', 'ghost-pkg': '*' }, devDependencies: {} },
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<RegistryPanel />)
    fireEvent.click(screen.getByTestId('dep-row-ghost-pkg'))
    const detail = await screen.findByTestId('package-detail-ghost-pkg')

    expect((await within(detail).findByRole('alert')).textContent).toContain('Package not found')
    fireEvent.click(within(detail).getByTestId('dependency-remove-ghost-pkg'))
    expect(useEditorStore.getState().packageJson.dependencies['ghost-pkg']).toBeUndefined()
  })

  it('starts a query on its first page again after paging it and searching for something else', async () => {
    render(<RegistryPanel />)
    const search = screen.getByTestId('registry-search')
    fireEvent.change(search, { target: { value: 'many' } })
    await screen.findByTestId('registry-result-many-0', {}, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: 'Show more results' }))
    await screen.findByTestId('registry-result-many-20', {}, { timeout: 3000 })

    fireEvent.change(search, { target: { value: 'motion' } })
    await screen.findByTestId('registry-result-motion', {}, { timeout: 3000 })

    fireEvent.change(search, { target: { value: 'many' } })
    await screen.findByTestId('registry-result-many-0', {}, { timeout: 3000 })
    expect(screen.getByTestId('registry-result-many-19')).toBeDefined()
    expect(screen.queryByTestId('registry-result-many-20')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show more results' })).toBeDefined()
  })

  it('preselects the latest version, not whichever dist-tag the registry lists first', async () => {
    render(<RegistryPanel />)
    fireEvent.change(screen.getByTestId('registry-search'), { target: { value: 'tagged' } })
    fireEvent.click(await screen.findByTestId('registry-open-tagged', {}, { timeout: 3000 }))
    const detail = await screen.findByTestId('package-detail-tagged')

    const picker = within(detail).getByLabelText<HTMLSelectElement>('Version to install')
    expect(picker.value).toBe('5.0.0')
    fireEvent.click(within(detail).getByTestId('dependency-install-tagged'))
    expect(useEditorStore.getState().packageJson.dependencies.tagged).toBe('^5.0.0')
  })

  it('can still declare a package when the registry cannot describe it', async () => {
    render(<RegistryPanel />)
    fireEvent.change(screen.getByTestId('registry-search'), { target: { value: 'ghost-pkg' } })
    fireEvent.click(await screen.findByTestId('registry-open-ghost-pkg', {}, { timeout: 3000 }))
    const detail = await screen.findByTestId('package-detail-ghost-pkg')

    expect((await within(detail).findByRole('alert')).textContent).toContain('Package not found')
    fireEvent.click(within(detail).getByTestId('dependency-install-ghost-pkg'))
    expect(useEditorStore.getState().packageJson.dependencies['ghost-pkg']).toBe('*')
  })

  it('keeps npm-only sections hidden but says so when the registry profile fails to load', async () => {
    registryProfileFails = true
    render(<RegistryPanel />)
    expect((await screen.findByRole('alert')).textContent).toContain('Registry unavailable')
    expect(screen.queryByText('Popular for sites')).toBeNull()
  })

  it('does not mistake prototype properties for installed packages', async () => {
    render(<RegistryPanel />)
    fireEvent.change(screen.getByTestId('registry-search'), { target: { value: 'constructor' } })
    fireEvent.click(await screen.findByTestId('registry-open-constructor', {}, { timeout: 3000 }))
    const detail = await screen.findByTestId('package-detail-constructor')
    expect(await within(detail).findByTestId('dependency-install-constructor')).toBeDefined()
    expect(within(detail).queryByTestId('dependency-installed-constructor')).toBeNull()
  })

  it('shows a failed resolve with a retry on the package page where the install happened', async () => {
    useEditorStore.setState({
      dependencyResolveStatus: 'error',
      dependencyResolveError: 'Registry responded with 503',
    } as Parameters<typeof useEditorStore.setState>[0])
    render(<RegistryPanel />)
    fireEvent.click(screen.getByTestId('dep-row-canvas-confetti'))
    const detail = await screen.findByTestId('package-detail-canvas-confetti')

    const installed = await within(detail).findByTestId('dependency-installed-canvas-confetti')
    expect(within(installed).getByRole('alert').textContent).toContain('Registry responded with 503')
    expect(within(installed).getByTestId('dependency-retry-canvas-confetti')).toBeDefined()
  })

  it('keeps install and remove disabled without the runtime.dependencies capability', async () => {
    const viewer = { id: 'u1', capabilities: ['site.read'] } as unknown as CmsCurrentUser
    render(
      <AdminSessionContext.Provider value={{ user: viewer, setUser: () => {} }}>
        <RegistryPanel />
      </AdminSessionContext.Provider>,
    )
    const issues = screen.getByLabelText('Runtime dependency issues')
    expect(isDisabled(within(issues).getByRole('button', { name: 'Add' }))).toBe(true)

    fireEvent.click(screen.getByTestId('dep-row-canvas-confetti'))
    const detail = await screen.findByTestId('package-detail-canvas-confetti')
    expect(isDisabled(await within(detail).findByTestId('dependency-remove-canvas-confetti'))).toBe(true)
  })
})

describe('formatting helpers', () => {
  it('pins exact picks with a caret and keeps latest open', () => {
    expect(versionRange('12.0.0')).toBe('^12.0.0')
    expect(versionRange('latest')).toBe('*')
    expect(versionRange('')).toBe('*')
  })

  it('formats counts compactly', () => {
    expect(formatCount(15_193_062)).toBe('15.2M')
    expect(formatCount(4_300)).toBe('4.3K')
    expect(formatCount(120_300)).toBe('120K')
    expect(formatCount(0)).toBe('0')
  })
})

describe('isDependencyLockInSync', () => {
  const locked = { 'canvas-confetti': { name: 'canvas-confetti', requested: '^1.9.3', version: '1.9.4', resolvedAt: 1 } }

  it('is in sync with nothing requested, even when the lock still lists packages', () => {
    expect(isDependencyLockInSync({ dependencies: {}, devDependencies: {} }, {})).toBe(true)
    expect(isDependencyLockInSync({ dependencies: {}, devDependencies: {} }, locked)).toBe(true)
  })

  it('is out of sync while a requested package has no lock entry', () => {
    expect(isDependencyLockInSync({ dependencies: { 'canvas-confetti': '*' }, devDependencies: {} }, {})).toBe(false)
    expect(isDependencyLockInSync({ dependencies: { 'canvas-confetti': '^1.9.3', motion: '*' }, devDependencies: {} }, locked)).toBe(false)
  })

  it('is out of sync when a locked request changed or a lock entry lost its request', () => {
    expect(isDependencyLockInSync({ dependencies: { 'canvas-confetti': '^2.0.0' }, devDependencies: {} }, locked)).toBe(false)
    expect(isDependencyLockInSync({ dependencies: { motion: '*' }, devDependencies: {} }, {
      ...locked,
      motion: { name: 'motion', requested: '*', version: '12.0.0', resolvedAt: 1 },
    })).toBe(false)
  })

  it('is in sync when every requested package is locked at the same range', () => {
    expect(isDependencyLockInSync({ dependencies: { 'canvas-confetti': '^1.9.3' }, devDependencies: {} }, locked)).toBe(true)
  })
})

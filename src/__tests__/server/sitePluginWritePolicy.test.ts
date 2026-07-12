/**
 * plugins.edit write policy — `validateSiteWriteDiff`'s `plugins` change
 * category. Plugin-source files (`type: 'plugin'`) are their own trust
 * domain: every change to them requires `plugins.edit`, never a site
 * capability — and site capabilities alone never authorize one. Shared by
 * both write transports (HTTP save + collab update guard), so this pure
 * policy test covers the socket path too.
 */
import { describe, expect, test } from 'bun:test'
import type { CoreCapability } from '@core/capabilities'
import type { SiteFile } from '@core/files/schemas'
import type { SiteShell } from '@core/page-tree'
import {
  ForbiddenSiteChangeError,
  validateSiteWriteDiff,
} from '../../../server/writePolicy/siteDiff'

const ALL_SITE_CAPS: CoreCapability[] = [
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
]

function shell(files: SiteFile[]): SiteShell {
  return {
    id: 'project_1',
    name: 'CMS Site',
    files,
    visualComponents: [],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} },
    styleRules: {},
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} },
    createdAt: 1000,
    updatedAt: 2000,
  }
}

function pluginFile(overrides: Partial<SiteFile> = {}): SiteFile {
  return {
    id: 'f1',
    path: 'plugins/newsletter/server/index.ts',
    type: 'plugin',
    content: 'export {}',
    updatedAt: 0,
    ...overrides,
  }
}

function expectForbiddenPluginChange(fn: () => void): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(ForbiddenSiteChangeError)
  expect((caught as ForbiddenSiteChangeError).kind).toBe('plugins')
}

describe('validateSiteWriteDiff — plugins category', () => {
  test('a full site writer WITHOUT plugins.edit cannot add a plugin file', () => {
    expectForbiddenPluginChange(() =>
      validateSiteWriteDiff(shell([]), shell([pluginFile()]), ALL_SITE_CAPS),
    )
  })

  test('a full site writer WITHOUT plugins.edit cannot edit plugin content', () => {
    expectForbiddenPluginChange(() =>
      validateSiteWriteDiff(
        shell([pluginFile()]),
        shell([pluginFile({ content: 'export const x = 1' })]),
        ALL_SITE_CAPS,
      ),
    )
  })

  test('a full site writer WITHOUT plugins.edit cannot delete or rename plugin files', () => {
    expectForbiddenPluginChange(() =>
      validateSiteWriteDiff(shell([pluginFile()]), shell([]), ALL_SITE_CAPS),
    )
    expectForbiddenPluginChange(() =>
      validateSiteWriteDiff(
        shell([pluginFile()]),
        shell([pluginFile({ path: 'plugins/newsletter/server/renamed.ts' })]),
        ALL_SITE_CAPS,
      ),
    )
  })

  test('retyping across the plugin boundary requires plugins.edit from either side', () => {
    // plugin → script: the file leaves the plugin domain.
    expectForbiddenPluginChange(() =>
      validateSiteWriteDiff(
        shell([pluginFile()]),
        shell([pluginFile({ type: 'script', path: 'src/scripts/escaped.ts' })]),
        ALL_SITE_CAPS,
      ),
    )
    // script → plugin: the file enters the plugin domain.
    expectForbiddenPluginChange(() =>
      validateSiteWriteDiff(
        shell([pluginFile({ type: 'script', path: 'src/scripts/escaped.ts' })]),
        shell([pluginFile()]),
        ALL_SITE_CAPS,
      ),
    )
  })

  test('plugins.edit alone authorizes plugin-file changes and nothing else', () => {
    const caps: CoreCapability[] = ['plugins.edit']
    // Full plugin-file lifecycle passes.
    validateSiteWriteDiff(shell([]), shell([pluginFile()]), caps)
    validateSiteWriteDiff(
      shell([pluginFile()]),
      shell([pluginFile({ content: 'export const x = 1' })]),
      caps,
    )
    validateSiteWriteDiff(shell([pluginFile()]), shell([]), caps)

    // A style-file content edit is still rejected — plugins.edit grants no
    // site rights.
    const styleFile: SiteFile = {
      id: 'f2',
      path: 'src/styles/site.css',
      type: 'style',
      content: 'body {}',
      updatedAt: 0,
    }
    expect(() =>
      validateSiteWriteDiff(
        shell([styleFile]),
        shell([{ ...styleFile, content: 'body { margin: 0 }' }]),
        caps,
      ),
    ).toThrow(ForbiddenSiteChangeError)
  })

  test('the full-writer fast path requires plugins.edit too', () => {
    // With all four capabilities the diff is skipped entirely — any change
    // passes, including plugin files.
    validateSiteWriteDiff(
      shell([]),
      shell([pluginFile()]),
      [...ALL_SITE_CAPS, 'plugins.edit'],
    )
  })
})

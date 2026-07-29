/**
 * The projection must return OWNED data, not live references into the Y doc.
 *
 * `projectSiteDoc` reads plain values straight out of the shell Y.Maps. If it
 * hands those references out, the editor store and the CRDT end up sharing the
 * same mutable objects, and two things go wrong:
 *
 *  1. `validateSite` normalizes in place (`normalizeFrameworkColors` assigns
 *     `colors.tokens`), so validating a projection silently REWRITES state
 *     held inside the Y doc, outside any transaction.
 *  2. The editor store is created with Mutative `enableAutoFreeze: true`, so
 *     the moment a projected shell lands in the store, everything reachable
 *     from it is deep-frozen — including the objects the Y doc still holds.
 *     The NEXT projection then throws
 *     `TypeError: Cannot assign to read only property 'tokens'`, the
 *     projection is skipped, and the editor never renders.
 *
 * Both are reproduced below with the real seed → project → validate → freeze
 * cycle the editor performs on every remote update.
 */
import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import { projectSiteDoc, seedSiteDoc, shellMap } from '@core/collab'
import { validateSite } from '@core/persistence/validate'
import { makeSite } from '../fixtures'

/**
 * What Mutative's `enableAutoFreeze` does to state that lands in the store.
 *
 * Applied ONLY to the fixture's own `framework` object below — never to a whole
 * validated shell. `parseSiteSettings`/`parseSiteDocument` hand back shared
 * module singletons (`DEFAULT_SITE_SETTINGS`, `DEFAULT_PACKAGE_JSON`) by
 * reference on their fallback paths, and `bun test` runs every file in ONE
 * process, so freezing a validated shell wholesale would freeze those
 * singletons for the entire run and break unrelated suites downstream.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner)
  return value
}

function siteWithFrameworkColors() {
  const site = makeSite({})
  return {
    ...site,
    settings: {
      ...site.settings,
      framework: {
        colors: {
          tokens: [
            {
              id: 'tok1',
              category: '',
              slug: 'Brand Primary',
              lightValue: '#ffffff',
              darkValue: '',
              darkModeEnabled: false,
              generateUtilities: { text: true, background: true, border: true, fill: false },
              generateTransparent: true,
              generateShades: { enabled: false, count: 4 },
              generateTints: { enabled: false, count: 4 },
              order: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        },
      },
    },
  } as typeof site
}

function projectShell(doc: Y.Doc) {
  const projected = projectSiteDoc(doc)
  return validateSite({ ...projected.shell, id: 'default', updatedAt: 0 })
}

describe('site projection ownership', () => {
  it('survives a second projection after the first landed in a frozen store', () => {
    const doc = new Y.Doc()
    seedSiteDoc(doc, siteWithFrameworkColors())

    // First projection → validated → store. Freezing what the projection
    // handed out is what the store's auto-freeze does; if that reaches the
    // doc's own objects, the doc is poisoned.
    const first = projectSiteDoc(doc)
    validateSite({ ...first.shell, id: 'default', updatedAt: 0 })
    deepFreeze((first.shell.settings as Record<string, unknown>).framework)

    // Second projection — a peer edit, an undo, any remote update at all.
    expect(() => projectShell(doc)).not.toThrow()
  })

  it('does not let validation write normalized values back into the Y doc', () => {
    const doc = new Y.Doc()
    seedSiteDoc(doc, siteWithFrameworkColors())

    const validated = projectShell(doc)
    // Validation normalizes the slug and fills the dark value...
    expect(validated.settings.framework?.colors?.tokens[0]?.slug).toBe('brand-primary')
    expect(validated.settings.framework?.colors?.tokens[0]?.darkValue).not.toBe('')

    // ...but the doc must still hold exactly what was seeded.
    const settings = shellMap(doc).get('settings') as Y.Map<unknown>
    const framework = settings.get('framework') as {
      colors: { tokens: Array<{ slug: string; darkValue: string }> }
    }
    expect(framework.colors.tokens[0].slug).toBe('Brand Primary')
    expect(framework.colors.tokens[0].darkValue).toBe('')
  })

  it('hands out a fresh object graph on every projection', () => {
    const doc = new Y.Doc()
    seedSiteDoc(doc, siteWithFrameworkColors())

    const settings = shellMap(doc).get('settings') as Y.Map<unknown>
    const stored = settings.get('framework')

    expect(projectSiteDoc(doc).shell.settings).not.toBe(settings)
    expect((projectSiteDoc(doc).shell.settings as Record<string, unknown>).framework).not.toBe(stored)
  })
})

/**
 * Installing a palette must be ONE mutation, and a refused write must be
 * reported as a failure.
 *
 * `site_set_color_tokens` used to loop one `createFrameworkColorToken` per
 * token. Each of those is its own site mutation, and any mutation that ensures
 * a not-yet-bound collab doc registers a write gate at `synced: false` — so
 * every remaining write in the same synchronous tick was refused with
 * `syncing`. The action still returned a token object regardless, so the tool
 * answered "14 tokens created" for a palette of which only a prefix reached
 * the relay and the database. Colours the CSS then referenced simply did not
 * exist, and nothing in the authoring flow said so.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  connectCollabProvider,
  disconnectCollabProvider,
} from '@site/store/slices/site/collabBinding'
import type {
  BoundCollabDoc,
  CollabProvider,
  CollabResetListener,
} from '@site/collab/collabProvider'
import { clearCollabBlockNotice } from '@site/store/slices/site/collabNotices'
import { useEditorStore } from '@site/store/store'
import { runSetColorTokens } from '@site/agent/tokenRunners'
import '@modules/base/index'

/** Provider whose docs stay unsynced until the test releases them. */
function deferredProvider(): CollabProvider & { releaseAll: () => void } {
  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  const bound = new Map<string, BoundCollabDoc>()
  const releases: Array<() => void> = []
  const resetListeners = new Set<CollabResetListener>()
  return {
    bind: (docId) => {
      let entry = bound.get(docId)
      if (!entry) {
        let release = (): void => {}
        const whenSynced = new Promise<void>((resolve) => {
          release = () => resolve()
        })
        entry = { doc: new Y.Doc(), synced: false, whenSynced }
        releases.push(() => {
          entry!.synced = true
          release()
        })
        bound.set(docId, entry)
      }
      return entry
    },
    unbind: (docId) => {
      bound.get(docId)?.doc.destroy()
      bound.delete(docId)
    },
    awareness,
    status: () => 'connected',
    canSend: () => true,
    reconnectNow: () => {},
    onStatus: () => () => {},
    onReset: (listener) => {
      resetListeners.add(listener)
      return () => resetListeners.delete(listener)
    },
    releaseAll: () => {
      for (const release of releases) release()
    },
    destroy: () => {
      awareness.destroy()
      presenceDoc.destroy()
    },
  }
}

const PALETTE = Array.from({ length: 8 }, (_, i) => ({
  slug: `hue-${i + 1}`,
  lightValue: `hsla(${i * 40}, 60%, 50%, 1)`,
}))

function storedSlugs(): string[] {
  return (useEditorStore.getState().site?.settings.framework?.colors.tokens ?? []).map(
    (token) => token.slug,
  )
}

afterEach(() => {
  disconnectCollabProvider()
  // These tests load a site into the shared editor store; leaving it behind
  // leaks into every later suite that reads the same singleton.
  useEditorStore.getState().clearSite()
  // A refused write latches the "one toast per outage" flag in module scope.
  // Left set, the next suite's first outage is silently swallowed.
  clearCollabBlockNotice()
})

describe('installing a colour palette in one call', () => {
  it('writes every token in a single mutation once docs are synced', async () => {
    useEditorStore.getState().createSite('Palette Site')
    const provider = deferredProvider()
    connectCollabProvider(provider)
    provider.releaseAll()
    // Let the whenSynced promises settle so the gates are open.
    await new Promise((resolve) => setTimeout(resolve, 10))

    const result = useEditorStore.getState().upsertFrameworkColorTokens(PALETTE)

    expect(result.accepted).toBe(true)
    expect(result.tokens).toHaveLength(8)
    expect(storedSlugs()).toEqual(PALETTE.map((t) => t.slug))
  })

  it('keeps slugs unique against tokens created earlier in the same batch', async () => {
    useEditorStore.getState().createSite('Dedup Site')
    const provider = deferredProvider()
    connectCollabProvider(provider)
    provider.releaseAll()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Two DIFFERENT entries normalizing to the same slug must not collapse:
    // the second is a distinct token and gets a suffixed slug, exactly as a
    // sequence of single-token calls would have produced.
    useEditorStore.getState().upsertFrameworkColorTokens([
      { slug: 'brand', lightValue: 'hsla(0, 0%, 0%, 1)' },
      { slug: 'Brand Two', lightValue: 'hsla(0, 0%, 50%, 1)' },
    ])

    expect(storedSlugs()).toEqual(['brand', 'brand-two'])
  })

  it('re-running the same palette updates in place instead of suffixing', async () => {
    useEditorStore.getState().createSite('Rerun Site')
    const provider = deferredProvider()
    connectCollabProvider(provider)
    provider.releaseAll()
    await new Promise((resolve) => setTimeout(resolve, 10))

    useEditorStore.getState().upsertFrameworkColorTokens(PALETTE)
    const second = useEditorStore.getState().upsertFrameworkColorTokens(PALETTE)

    expect(second.tokens.every((t) => t.action === 'updated')).toBe(true)
    expect(storedSlugs()).toEqual(PALETTE.map((t) => t.slug))
  })

  it('reports a refused batch as an error instead of a list of created tokens', () => {
    useEditorStore.getState().createSite('Blocked Site')
    // Never released: every doc stays unsynced, so the write path refuses.
    connectCollabProvider(deferredProvider())

    const output = runSetColorTokens({ tokens: PALETTE })

    expect(output.ok).toBe(false)
    expect(String(output.error)).toContain('not saved')
    expect(storedSlugs()).toEqual([])
  })
})

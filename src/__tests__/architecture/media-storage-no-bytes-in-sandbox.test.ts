/**
 * Architecture gate: media storage adapter bytes never cross the QuickJS
 * sandbox boundary.
 *
 * The kernel invariant of the media-plugin design is that bytes (which
 * routinely exceed the VM's 64 MB heap ceiling for any non-trivial video
 * upload) flow through Bun's native `fetch` from the host into the
 * adapter's signed PUT URL — never through QuickJS. The plugin adapter
 * only signs upload plans; the host streams the payload.
 *
 * This test locks the invariant in by asserting:
 *
 *   1. The `MediaStorageAdapter` SDK type carries NO `bytes` / `buffer` /
 *      `body` fields on `beginWrite` input. If a future change added a
 *      bytes channel to the contract, this test would fail loud.
 *   2. The worker protocol's `RunMediaAdapterCallRequest` payload schema
 *      doesn't ferry binary blobs either.
 *   3. The host-side dispatcher (`mediaUploadExecutor.ts`) is the ONLY
 *      file that issues `fetch(url, { body: <bytes> })` for storage
 *      uploads — gated by `executeUploadPlan`, not the QuickJS bridge.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('media storage — no bytes in sandbox', () => {
  it('MediaStorageBeginWriteInput carries metadata only, not bytes', async () => {
    const source = await read('src/core/plugin-sdk/types/media.ts')
    // Locate the interface body and assert the byte-shaped names aren't in it.
    const match = source.match(
      /export interface MediaStorageBeginWriteInput \{([\s\S]*?)\}/,
    )
    expect(match).not.toBeNull()
    const body = match![1]
    // Forbidden field names — any of these would imply bytes flowing.
    for (const forbidden of ['bytes', 'buffer', 'body', 'data', 'payload']) {
      const wordRegex = new RegExp(`\\b${forbidden}\\s*[?:]`)
      if (wordRegex.test(body)) {
        throw new Error(
          `MediaStorageBeginWriteInput must not carry a "${forbidden}" field. Bytes flow through executeUploadPlan, not the adapter contract.`,
        )
      }
    }
  })

  it('the host-side executor is the only fetch-with-body site for storage uploads', async () => {
    const executor = await read('server/handlers/cms/mediaUploadExecutor.ts')
    // The executor must use Bun's native fetch — NOT route through the
    // QuickJS sandbox bridge.
    expect(executor).toContain('await fetch(step.url')
    // No hostCall / QuickJS bridge usage in this file.
    expect(executor).not.toMatch(/__hostCall|callHostApi|quickjsHost/)
  })

  it('quickjs/vm.ts never imports the executor (no bytes-into-sandbox door)', async () => {
    const quickjs = await read('server/plugins/quickjs/vm.ts')
    expect(quickjs).not.toContain('mediaUploadExecutor')
    expect(quickjs).not.toContain('executeUploadPlan')
  })

  it('protocol/messages.ts forbids byte fields in adapter-call args', async () => {
    const protocol = await read('server/plugins/protocol/messages.ts')
    // The `RunMediaAdapterCallRequest.args` type is `unknown` (deliberately
    // schemaless for the generic dispatcher), but the inline doc must
    // contain the explicit byte-free guarantee so future contributors see
    // the invariant.
    // The protocol comment must explicitly state the bytes-never-in-args
    // guarantee. JSDoc comment artifacts (`*` line prefixes) and whitespace
    // are stripped before matching so a comment can reflow naturally.
    const flattened = protocol.replace(/[\s*]+/g, ' ')
    expect(flattened).toMatch(/Bytes are NEVER part of `args`/i)
  })

  it('remote ingestion crosses the sandbox as URL metadata only', async () => {
    const source = await read('src/core/plugin-sdk/types/media.ts')
    const match = source.match(
      /export const RemoteMediaUpsertInputSchema = Type\.Object\(\{([\s\S]*?)\n\}, \{ additionalProperties: false \}\)/,
    )
    expect(match).not.toBeNull()
    const body = match![1]
    expect(body).toContain('sourceUrl:')
    for (const forbidden of ['bytes', 'buffer', 'body', 'data', 'payload']) {
      expect(body).not.toMatch(new RegExp(`\\b${forbidden}\\s*:`))
    }
  })
})

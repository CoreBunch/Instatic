import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Request-owned snapshots outside public uploads; filenames never come from users. */
export class PrivateArchiveFiles {
  private directory: string | undefined
  private count = 0

  async add(bytes: Uint8Array): Promise<string> {
    this.directory ??= await mkdtemp(join(tmpdir(), 'instatic-private-export-'))
    const path = join(this.directory, String(this.count++))
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    return path
  }

  async cleanup(): Promise<void> {
    if (!this.directory) return
    try {
      await rm(this.directory, { recursive: true, force: true })
    } catch (err) {
      console.error('[privateArchiveFiles] Failed to remove export snapshots:', err)
    }
  }

  /** Keep snapshots alive until the download finishes, fails, or is cancelled. */
  stream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = source.getReader()
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const next = await reader.read()
          if (next.done) {
            await this.cleanup()
            controller.close()
          } else {
            controller.enqueue(next.value)
          }
        } catch (err) {
          await this.cleanup()
          controller.error(err)
        }
      },
      cancel: async (reason) => {
        try {
          await reader.cancel(reason)
        } finally {
          await this.cleanup()
        }
      },
    })
  }
}

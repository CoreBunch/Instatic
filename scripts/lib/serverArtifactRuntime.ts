/**
 * Code that runs inside the compiled server binary before the server boots.
 * Kept out of the generated compile entry so the artifact and its test share
 * one implementation.
 *
 * Two native pieces cannot be used straight from the binary's embedded files:
 * the Windows loader resolves libvips DLLs by name, and esbuild spawns its Go
 * binary as a child process. Both need a real file on disk. Extraction goes
 * to a per-version directory under the OS temp dir, is idempotent across
 * restarts, and tolerates a running sibling server that already holds the
 * same file (rewriting a mapped DLL is a sharing violation on Windows).
 */
import { chmodSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function extractEmbeddedFile(dir: string, name: string, embedded: string, mode?: number): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  const source = Bun.file(embedded)
  const existing = Bun.file(target)
  if ((await existing.exists()) && existing.size === source.size) return target
  const tmp = `${target}.${process.pid}.tmp`
  try {
    await Bun.write(tmp, source)
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    // A sibling process holds the same version of this file; it is identical
    // on disk, so use it as is.
    if (!(await existing.exists())) throw err
  }
  return target
}

/**
 * esbuild locates its Go binary relative to `__dirname` unless
 * `ESBUILD_BINARY_PATH` names one. Inside the compiled server `__dirname` is
 * the build machine's path, so the binary is embedded at compile time and
 * extracted here. Must run before anything imports `esbuild`: the package
 * reads the variable at module load.
 */
export async function installEsbuildBinary(embedded: string, version: string, fileName: string): Promise<void> {
  const dir = join(tmpdir(), 'instatic-native', `esbuild-${version}`)
  const mode = fileName.endsWith('.exe') ? undefined : 0o755
  process.env.ESBUILD_BINARY_PATH = await extractEmbeddedFile(dir, fileName, embedded, mode)
}

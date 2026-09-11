import { afterAll, describe, expect, it } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { serverArtifactPlugins } from './serverArtifactPlugins'

const ROOT = resolve(import.meta.dir, '../..')
// Under `.tmp/` like the real compile entry, so `@core/*` paths resolve the same way.
const WORK_DIR = join(ROOT, '.tmp', 'server-artifact-plugins-test')

// Boots the production sanitizer the way `server/index.ts` does, with one addition:
// reading any `node_modules` path throws. Inside a compiled binary such a read can only
// mean a build-machine path was baked in, and on the build machine that read would
// otherwise succeed and hide the defect, which is how v0.0.19 shipped unbootable.
const ENTRY = `
import fs from 'node:fs'
const readFileSync = fs.readFileSync
fs.readFileSync = ((path, ...rest) => {
  if (String(path).includes('node_modules')) throw new Error('compiled binary read a build-machine path: ' + path)
  return readFileSync(path, ...rest)
}) as typeof fs.readFileSync
await import('../../server/richtextSanitizer')
const { sanitizeRichtext } = await import('../../src/core/sanitize')
console.log(JSON.stringify(sanitizeRichtext('<p>kept</p><img src=x onerror=alert(1)><script>alert(1)</script>')))
`

describe('serverArtifactPlugins', () => {
  afterAll(() => rm(WORK_DIR, { recursive: true, force: true }))

  it("compiles a server binary that boots the jsdom sanitizer without the build machine's files", async () => {
    await mkdir(WORK_DIR, { recursive: true })
    const entry = join(WORK_DIR, 'entry.ts')
    const outfile = join(WORK_DIR, 'sanitizer-binary')
    await writeFile(entry, ENTRY, 'utf-8')

    const build = await Bun.build({
      entrypoints: [entry],
      compile: { outfile, target: `bun-${process.platform}-${process.arch}` },
      plugins: serverArtifactPlugins(ROOT),
    })
    expect(build.logs.map(String)).toEqual([])
    expect(build.success).toBe(true)

    // Structural check first: no absolute path into the build machine's
    // `node_modules` may survive into the binary. `require.resolve` bake-ins
    // bypass `fs`, so the boot below passes them on the build machine, where
    // the path exists; this catches them anywhere.
    // The real location: bake-ins carry resolved paths, and a worktree's
    // `node_modules` is a symlink into the main checkout.
    const buildNodeModules = Buffer.from(realpathSync(join(ROOT, 'node_modules')) + sep)
    const binary = Buffer.from(await Bun.file(outfile).arrayBuffer())
    const bakedAt = binary.indexOf(buildNodeModules)
    if (bakedAt !== -1) {
      throw new Error(`build-machine path baked into the binary: ${binary.subarray(Math.max(0, bakedAt - 80), bakedAt + 160).toString()}`)
    }

    // Run from an unrelated cwd: the binary must carry everything it needs.
    const run = Bun.spawnSync({ cmd: [outfile], cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' })
    const stderr = run.stderr.toString()
    if (run.exitCode !== 0) throw new Error(`compiled sanitizer exited ${run.exitCode}:\n${stderr}`)

    const sanitized = JSON.parse(run.stdout.toString().trim()) as string
    expect(sanitized).toContain('<p>kept</p>')
    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('onerror')
  }, 60_000)
})

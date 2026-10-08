import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('Circular dependencies', () => {
  it('keeps the tsconfig-aware source graph cycle-free', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        'x',
        '--bun',
        'madge',
        '--circular',
        '--ts-config',
        'tsconfig.json',
        '--extensions',
        'ts,tsx',
        'src',
        'server',
      ],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const output = `${decode(result.stdout)}${decode(result.stderr)}`
    if (result.exitCode !== 0) {
      throw new Error(
        `Circular dependencies found. Run the same command locally for the full graph:\n` +
          `bun x --bun madge --circular --ts-config tsconfig.json --extensions ts,tsx src server\n\n` +
          output,
      )
    }

    expect(output).toContain('No circular dependency found')
  }, 15000)
})

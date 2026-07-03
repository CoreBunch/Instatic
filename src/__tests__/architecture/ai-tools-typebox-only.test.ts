/**
 * Architecture gate — every file under `server/ai/tools/**` defines
 * schemas with TypeBox (not Zod).
 *
 * The tool registry is the canonical source of truth for tool input
 * shapes. Drivers pass those TypeBox schemas through as JSON Schema
 * parameters in direct REST requests. Allowing Zod into the tool files would
 * create two competing sources of truth.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const TOOLS_ROOT = join(REPO_ROOT, 'server/ai/tools')

function collectFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectFiles(full))
    } else if (extname(entry) === '.ts') {
      out.push(full)
    }
  }
  return out
}

describe('ai-tools-typebox-only gate', () => {
  it('no file under server/ai/tools/** imports zod', () => {
    const files = collectFiles(TOOLS_ROOT)
    expect(files.length).toBeGreaterThan(0)

    const violations = files.filter((file) => {
      const src = readFileSync(file, 'utf8')
      return /from\s+['"]zod['"]|require\s*\(\s*['"]zod['"]\s*\)/.test(src)
    })

    if (violations.length > 0) {
      throw new Error(
        `[ai-tools-typebox-only] tools import zod (must use TypeBox):\n` +
        violations.map((v) => `  ${relative(REPO_ROOT, v).replaceAll('\\', '/')}`).join('\n'),
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('every tool module that defines tools sources its schemas from TypeBox', () => {
    const files = collectFiles(TOOLS_ROOT)
    // Files that DEFINE tools — i.e. construct objects matching the AiTool
    // shape — must reach for TypeBox. Heuristic: file mentions `inputSchema:`
    // (the AiTool field) at least once.
    const toolFiles = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /\binputSchema:\s*/.test(src)
    })
    expect(toolFiles.length).toBeGreaterThan(0)

    // A tool file satisfies the gate either by building schemas with TypeBox
    // directly, OR by importing the shared TypeBox input schemas from the
    // `@core/ai` leaf (`src/core/ai/toolSchemas.ts`) — the single source of
    // truth that both the server tools and the browser executor consume. The
    // leaf is itself TypeBox-only, and zod stays banned by the test above.
    const missingTypeBox = toolFiles.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return !/from\s+['"]@core\/utils\/typeboxHelpers['"]|from\s+['"]@sinclair\/typebox['"]|from\s+['"]@core\/ai['"]/.test(src)
    })
    if (missingTypeBox.length > 0) {
      throw new Error(
        `[ai-tools-typebox-only] tool files declare \`inputSchema:\` but don't import TypeBox:\n` +
        missingTypeBox.map((v) => `  ${relative(REPO_ROOT, v).replaceAll('\\', '/')}`).join('\n'),
      )
    }
    expect(missingTypeBox).toHaveLength(0)
  })
})

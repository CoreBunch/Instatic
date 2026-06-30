/**
 * Zustand selector stability regression tests.
 *
 * The real invariant is small: store selectors and partial panel setters must
 * not create fresh object/array references for no-op reads or writes. Keep the
 * suite at that level instead of locking exact helper names in source files.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname } from 'path'
import { useEditorStore } from '@site/store/store'

const SRC_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '')

function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git' || entry === '__tests__') continue
      files.push(...collectSourceFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      files.push(full)
    }
  }
  return files
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

function relPath(filePath: string): string {
  return filePath.replace(`${SRC_ROOT}/`, '')
}

function resetPanels() {
  useEditorStore.setState({
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetPanels)

describe('Zustand selector stability', () => {
  it('useEditorStore selectors do not use inline unstable fallback references', () => {
    const violations: string[] = []
    const unstableFallbackRe = /\?\?\s*(?:\[|\{|new\s+\w)/

    for (const filePath of collectSourceFiles(SRC_ROOT)) {
      const raw = readFileSync(filePath, 'utf-8')
      if (!raw.includes('useEditorStore')) continue

      const lines = stripComments(raw).split('\n')
      lines.forEach((line, index) => {
        if (!unstableFallbackRe.test(line)) return

        const context = lines.slice(Math.max(0, index - 5), index + 1).join('\n')
        if (context.includes('useEditorStore')) {
          violations.push(`${relPath(filePath)}:${index + 1}: ${line.trim()}`)
        }
      })
    }

    expect(violations).toEqual([])
  })

  it('panel partial setters keep object identity on no-op updates', () => {
    const beforeProperties = useEditorStore.getState().propertiesPanel
    useEditorStore.getState().setPropertiesPanel({ collapsed: beforeProperties.collapsed })
    expect(useEditorStore.getState().propertiesPanel).toBe(beforeProperties)
  })

  it('panel partial setters replace object identity when values actually change', () => {
    const beforeProperties = useEditorStore.getState().propertiesPanel
    useEditorStore.getState().setPropertiesPanel({ collapsed: !beforeProperties.collapsed })
    expect(useEditorStore.getState().propertiesPanel).not.toBe(beforeProperties)
  })
})

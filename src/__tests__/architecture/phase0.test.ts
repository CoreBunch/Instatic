/**
 * Architecture Gate Tests — Phase 0: Project Scaffold
 *
 * Pre-registered gate tests for Phase 0 — Project Scaffold (Task #173).
 * Uses the adaptive-skip pattern — tests activate automatically when
 * `settingsSlice.ts` is created (the last of the four canonical Phase 0 slices),
 * indicating the Phase 0 scaffold is in place per the spec in Contribution #457.
 *
 * ENFORCED CONSTRAINTS (from Contribution #457 / Guideline #193 / Guideline #337):
 *
 * 1. No runtime `react` imports in `src/core/**` (excluding `react-publisher/`).
 *    The core layer — module-engine, publisher, persistence — must be framework-
 *    agnostic. React belongs in `src/editor/` and `src/core/react-publisher/`.
 *    Type-only imports (`import type`) are allowed (zero runtime cost).
 *    (Constraints #179, #190 — "No React in core engine")
 *
 * 2. The six canonical Phase 0 slices must exist in `src/core/editor-store/slices/`.
 *    Required: `projectSlice.ts`, `canvasSlice.ts`, `classSlice.ts`, `settingsSlice.ts`,
 *    `selectionSlice.ts`, `uiSlice.ts`.
 *    `selectionSlice.ts` and `uiSlice.ts` were pre-approved by Guideline #341 (posted
 *    after the original Guideline #193 spec). A seventh slice — `domTreeSlice.ts` —
 *    is pre-approved for Phase 3 (Guideline #337, Guideline #321) and must NOT be
 *    included in the Phase 0 scaffold.
 *    (Guideline #193 + Guideline #341 — Six Zustand slices)
 *
 * PATH NOTE (Guideline #337 Correction 1):
 * The canonical store path is `src/core/editor-store/` — NOT `src/editor-store/`.
 * Any reference to the old path in code or tests is a bug; see Guideline #337.
 *
 * @see Contribution #457 — Phase 0 Project Scaffold: Architectural Specification (Architect)
 * @see Guideline #193    — Original Zustand slices specification (4 slices)
 * @see Guideline #341    — Zustand Store Slice Set Addendum (adds selectionSlice + uiSlice → 6 slices)
 * @see Guideline #337    — Phase 0 Scaffold Addendum (store path correction + domTreeSlice pre-approval)
 * @see Constraints #179, #190 — No React in core engine
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, extname } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const CORE_DIR = join(SRC_ROOT, 'core')
const SLICES_DIR = join(SRC_ROOT, 'core/editor-store/slices')

// ---------------------------------------------------------------------------
// Phase 0 activation check
//
// The canonical four Phase 0 slices are: projectSlice, canvasSlice, classSlice,
// settingsSlice. We treat settingsSlice.ts as the "Phase 0 complete" signal
// because it is the most likely to be absent until a canonical scaffold is applied
// (the other three accumulate from earlier development iterations).
// ---------------------------------------------------------------------------

const SETTINGS_SLICE_PATH = join(SLICES_DIR, 'settingsSlice.ts')
const PHASE0_IMPLEMENTED = existsSync(SETTINGS_SLICE_PATH)

// ---------------------------------------------------------------------------
// File walker — collects .ts/.tsx files recursively
// ---------------------------------------------------------------------------

function collectTs(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectTs(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Gate 1 — No runtime React imports in src/core/ (excluding react-publisher/)
//
// Context: Constraints #179 / #190 — "No React in core engine".
// The core layer is framework-agnostic: module-engine, publisher (HTML/CSS path),
// persistence, and editor-store must not couple to React at runtime.
// Coupling core to React makes it impossible to use the engine in non-React
// contexts (Astro SSR, unit tests without jsdom, future Vue adapter, etc.).
//
// Allowed:
//   - `import type { ... } from 'react'` — zero runtime cost, type-only
//   - Any import in `src/core/react-publisher/` — that IS the React layer
//
// Blocked:
//   - `import React from 'react'`
//   - `import { useState, ... } from 'react'`  (runtime React hooks/APIs in core)
//   - `from 'react'` on a non-type-only import line
//
// NOTE: `src/core/persistence/usePersistence.ts` is a React hook currently
// residing in `src/core/`. If this gate activates and catches it, the hook
// should be moved to `src/editor/hooks/usePersistence.ts` per Constraint #179.
// ---------------------------------------------------------------------------

describe('Phase 0 Gate 1 — No runtime React imports in src/core/ (Constraints #179 / #190)', () => {
  it('[pre-registered] src/core/ files must not contain runtime react imports (type-only is OK)', () => {
    if (!PHASE0_IMPLEMENTED) {
      console.log(
        '[Phase0 gate] settingsSlice.ts not yet created — ' +
        'no-react-in-core gate pre-registered (Constraints #179 / #190 / Contribution #457)'
      )
      expect(true).toBe(true)
      return
    }

    // Exclude react-publisher/ — that directory IS the React layer by design.
    const REACT_PUBLISHER_DIR = join(CORE_DIR, 'react-publisher')

    const violations: string[] = []

    for (const file of collectTs(CORE_DIR)) {
      // Skip the React publisher — it is intentionally React-coupled
      if (file.startsWith(REACT_PUBLISHER_DIR + '/') || file === REACT_PUBLISHER_DIR) {
        continue
      }

      let src: string
      try { src = readFileSync(file, 'utf8') } catch { continue }

      if (!src.includes('react')) continue

      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip blank lines and comments
        if (!line.trim() || /^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue
        // Allow type-only imports: `import type { ... } from 'react'`
        if (/^\s*import\s+type\b/.test(line)) continue
        // Flag any remaining `from 'react'` or `from "react"` on non-type import lines
        if (/from\s+['"]react['"]/.test(line) || /^import\s+React\b/.test(line.trim())) {
          const rel = relative(SRC_ROOT, file)
          violations.push(
            `src/${rel}:${i + 1} — runtime React import in core layer (use import type or move to src/editor/)`
          )
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        '[Phase 0 / Constraints #179 + #190] Runtime React imports found in src/core/ files.\n' +
        'The core layer must be framework-agnostic. React belongs in src/editor/ and\n' +
        'src/core/react-publisher/ (the explicit React integration layer).\n' +
        'Type-only imports (`import type { ... } from "react"`) are allowed — zero runtime cost.\n' +
        'If src/core/persistence/usePersistence.ts is flagged, move it to src/editor/hooks/.\n' +
        'See Contribution #457 (Phase 0 spec) and Constraints #179, #190.\n' +
        'Violations:\n' +
        violations.map((v) => `  ${v}`).join('\n')
      )
    }

    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — Six canonical Phase 0 slices exist in src/core/editor-store/slices/
//
// Context: Guideline #193 (original 4 slices) + Guideline #341 (addendum — 2 more).
// Contribution #457 specifies the canonical split:
//   projectSlice / canvasSlice / classSlice / settingsSlice
// Guideline #341 (posted after the original gate was written) pre-approved two more:
//   selectionSlice / uiSlice
//
// Phase 0 scaffold must include exactly these six slices. Additional slices
// added before their respective phases indicate premature implementation that
// may conflict with later architectural decisions.
//
// Pre-approved Phase 3 addition: `domTreeSlice.ts` (Guideline #337 / Guideline #321).
// This gate is written so that domTreeSlice is explicitly excluded from the
// "unexpected slice" check — Phase 3 adding it will not fail this gate.
//
// Canonical path: `src/core/editor-store/slices/` (Guideline #337 Correction 1).
// ---------------------------------------------------------------------------

const CANONICAL_PHASE0_SLICES = [
  'projectSlice.ts',
  'canvasSlice.ts',
  'classSlice.ts',
  'settingsSlice.ts',
  'selectionSlice.ts',  // Pre-approved by Guideline #341
  'uiSlice.ts',         // Pre-approved by Guideline #341
]

// Slices approved for phases after Phase 0 — not a violation when present
const PRE_APPROVED_FUTURE_SLICES = new Set([
  'domTreeSlice.ts',          // Phase 3 (Guideline #337 / Guideline #321)
  'projectPanelSlice.ts',     // Phase E+ (Task #364 / Guideline #341 addendum / Architect message #1558)
  'settingsModalSlice.ts',    // Phase 6 (Task #183 — Settings Modal; open state may live in uiSlice but a dedicated slice is also permitted)
  'filesSlice.ts',            // File system data layer (Contribution #595 §6 / msg #1844 — CRUD actions for project.files[])
  'visualComponentsSlice.ts', // Visual Components data layer (Contribution #619 §10 / Task #436 — CRUD actions for project.visualComponents[])
  'dataModelSlice.ts',        // Data model layer for managed Convex tables and resource workspaces
])

describe('Phase 0 Gate 2 — Canonical six slices in src/core/editor-store/slices/ (Guideline #193 + #341)', () => {
  it('[pre-registered] all six canonical Phase 0 slices must exist', () => {
    if (!PHASE0_IMPLEMENTED) {
      console.log(
        '[Phase0 gate] settingsSlice.ts not yet created — ' +
        'canonical slices gate pre-registered (Guideline #193 + #341 / Contribution #457)'
      )
      expect(true).toBe(true)
      return
    }

    const missingSlices: string[] = []

    for (const slice of CANONICAL_PHASE0_SLICES) {
      const slicePath = join(SLICES_DIR, slice)
      if (!existsSync(slicePath)) {
        missingSlices.push(slice)
      }
    }

    if (missingSlices.length > 0) {
      throw new Error(
        '[Phase 0 / Guideline #193 + #341] Missing canonical Phase 0 slices.\n' +
        'The Phase 0 scaffold must include all six Zustand slices:\n' +
        '  projectSlice.ts, canvasSlice.ts, classSlice.ts, settingsSlice.ts,\n' +
        '  selectionSlice.ts (Guideline #341), uiSlice.ts (Guideline #341)\n' +
        'See Contribution #457 (Phase 0 spec), Guideline #193, and Guideline #341.\n' +
        'Missing:\n' +
        missingSlices.map((s) => `  src/core/editor-store/slices/${s}`).join('\n')
      )
    }

    expect(missingSlices).toHaveLength(0)
  })

  it('[pre-registered] no unexpected slices should exist at Phase 0 (Guideline #193)', () => {
    if (!PHASE0_IMPLEMENTED) {
      expect(true).toBe(true)
      return
    }

    // Collect all .ts files in the slices directory
    const existingSlices = readdirSync(SLICES_DIR)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))

    const canonicalSet = new Set(CANONICAL_PHASE0_SLICES)
    const unexpected: string[] = []

    for (const slice of existingSlices) {
      if (!canonicalSet.has(slice) && !PRE_APPROVED_FUTURE_SLICES.has(slice)) {
        unexpected.push(slice)
      }
    }

    if (unexpected.length > 0) {
      throw new Error(
        '[Phase 0 / Guideline #193 + #341] Unexpected slice files found in src/core/editor-store/slices/.\n' +
        'Phase 0 canonical slices: projectSlice, canvasSlice, classSlice, settingsSlice,\n' +
        '  selectionSlice (Guideline #341), uiSlice (Guideline #341).\n' +
        'Phase 3 pre-approved addition: domTreeSlice (Guideline #337 / Guideline #321).\n' +
        'Any slice outside these sets should be reviewed against the architecture spec before adding.\n' +
        'Unexpected files:\n' +
        unexpected.map((s) => `  src/core/editor-store/slices/${s}`).join('\n')
      )
    }

    expect(unexpected).toHaveLength(0)
  })
})

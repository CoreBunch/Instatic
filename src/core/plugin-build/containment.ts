import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { BunPlugin } from 'bun'

/**
 * Import attributes a workspace file may carry.
 *
 * Bun evaluates `import x from './m.ts' with { type: 'macro' }` AT BUILD
 * TIME, inside the host process, with full Node/Bun access — a macro module
 * can read or write anything the server can. Path containment cannot stop
 * it (the macro module resolves inside the workspace), and the sandbox
 * literal scan runs on the OUTPUT, after the macro has already executed.
 * Bun's own `Transpiler.scan` runs macros too, so the only safe check is a
 * textual one on the raw source before Bun parses it.
 *
 * Policy is fail-closed: every `with { … }` / `assert { … }` clause (and the
 * dynamic-import `{ with: { … } }` option form) must be exactly one of the
 * inert loaders below. Anything else — `macro`, a comment inside the clause,
 * an escaped key, a trailing field — fails the build. False positives on
 * prose that happens to contain `with {` are acceptable; a false negative
 * is host code execution.
 */
const INERT_IMPORT_ATTRIBUTE =
  /^\s*(?:type|"type"|'type')\s*:\s*(?:"(?:json|text|file|toml)"|'(?:json|text|file|toml)')\s*,?\s*$/
// `with` / `assert`, optional comments, optional `:` (dynamic-import option
// object), optional comments, then the brace clause.
const TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`
const IMPORT_ATTRIBUTE_CLAUSE = new RegExp(
  String.raw`\b(?:with|assert)${TRIVIA}:?${TRIVIA}\{([^}]*)\}`,
  'g',
)
const GUARDED_SOURCE = /\.(?:[cm]?[jt]sx?)$/

/**
 * Throw when `source` carries an import attribute clause that is not one
 * of the inert loaders. Exported for the containment gate test.
 */
export function assertNoBuildTimeMacros(source: string, filePath: string): void {
  for (const match of source.matchAll(IMPORT_ATTRIBUTE_CLAUSE)) {
    const clause = match[1] ?? ''
    if (INERT_IMPORT_ATTRIBUTE.test(clause)) continue
    throw new Error(
      `${filePath}: import attribute clause "{${clause.trim()}}" is not allowed in a site plugin. ` +
        `Only { type: 'json' | 'text' | 'file' | 'toml' } may be used — build-time macros ` +
        `(type: 'macro') would run on the host during the build.`,
    )
  }
}

/**
 * Import-containment seam. Absent on a bundle = default resolution (CLI
 * behavior). The site plugin frontend supplies a policy that fails any
 * resolution escaping the materialized workspace.
 */
export interface ImportResolverPolicy {
  /** Absolute dir that workspace-originating imports must stay inside. */
  workspaceRoot: string
  /** Exact bare-specifier → absolute-path overrides (e.g. '@instatic/plugin-sdk'). */
  bareSpecifiers: Record<string, string>
  /**
   * Bare specifiers allowed to stay external (resolved by a runtime import
   * map, never bundled). Populated automatically by `bundleEntrypoint` from
   * the bundle's own external list when not set explicitly.
   */
  allowedExternals?: string[]
}

/**
 * Roots a workspace may legitimately appear under: as given, fully
 * resolved, and realpath'd. The bundler reports importer paths through the
 * OS realpath (`/var` → `/private/var` on macOS), so comparing against the
 * un-realpath'd root alone would silently disable containment on any
 * symlinked temp directory.
 */
function workspaceRoots(root: string): string[] {
  const roots = new Set([resolve(root)])
  try {
    roots.add(realpathSync(root))
  } catch {
    // Root may not exist yet at plugin-construction time — the resolved
    // form still guards correctly.
  }
  return [...roots]
}

function isInsideOne(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

function isInsideAny(roots: readonly string[], candidate: string): boolean {
  const normalized = resolve(candidate)
  if (roots.some((root) => isInsideOne(root, normalized))) return true
  try {
    const real = realpathSync(normalized)
    return roots.some((root) => isInsideOne(root, real))
  } catch {
    return false
  }
}

/**
 * Fail-closed import containment for site plugin builds.
 *
 * Imports originating inside `workspaceRoot` must resolve inside it. Bare
 * specifiers are rejected unless explicitly mapped in `bareSpecifiers`
 * (v1 maps exactly `@instatic/plugin-sdk` to the host's SDK entry so pure
 * data builders — `defineModule`, `control`, `html`, … — inline into
 * sandbox bundles) or listed in `allowedExternals` (host-runtime externals
 * on editor/admin bundles, resolved by the import map at runtime, never
 * bundled). Absolute paths and upward-relative escapes throw — without
 * this, draft code could embed host files (env files, DB files) into a
 * bundle via `import x from '../../.env' with { type: 'text' }` and
 * exfiltrate them through the plugin's own routes. The sandbox literal
 * scan does NOT cover this class — it catches `node:`/`bun:` references,
 * not embedded file contents.
 *
 * Imports whose importer lives OUTSIDE the workspace (the mapped SDK's own
 * relative imports) fall through to default resolution: that subtree is
 * host-owned code the draft cannot influence.
 */
export function containmentPlugin(policy: ImportResolverPolicy): BunPlugin {
  const allowedExternals = new Set(policy.allowedExternals ?? [])
  const externalPrefixes = [...allowedExternals].map((name) => `${name}/`)
  const roots = workspaceRoots(policy.workspaceRoot)
  return {
    name: 'instatic-plugin-workspace-containment',
    setup(build) {
      // Runs BEFORE Bun parses a workspace file — the only moment a macro
      // import can still be refused. Host-owned files (the mapped SDK) are
      // not draft-controlled and skip the scan. Returning undefined hands
      // the unchanged file to the default loader.
      build.onLoad({ filter: GUARDED_SOURCE }, (args) => {
        if (!isInsideAny(roots, args.path)) return undefined
        assertNoBuildTimeMacros(readFileSync(args.path, 'utf8'), args.path)
        return undefined
      })

      build.onResolve({ filter: /.*/ }, (args) => {
        const specifier = args.path

        const mapped = policy.bareSpecifiers[specifier]
        if (mapped) return { path: mapped }

        // Host-owned dependency internals (e.g. the mapped SDK's own
        // relative imports) — the draft cannot influence them.
        const importer = args.importer
        if (importer && !isInsideAny(roots, importer)) {
          return undefined
        }

        const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
        if (!isRelative && !isAbsolute(specifier)) {
          if (
            allowedExternals.has(specifier) ||
            externalPrefixes.some((prefix) => specifier.startsWith(prefix))
          ) {
            return undefined // stays external; the runtime import map resolves it
          }
          throw new Error(
            `"${specifier}" is not an allowed dependency of a site plugin. ` +
              `Imports must stay inside the plugin folder.`,
          )
        }

        const importerDir = importer ? dirname(importer) : policy.workspaceRoot
        const target = isAbsolute(specifier) ? specifier : resolve(importerDir, specifier)
        if (!isInsideAny(roots, target)) {
          throw new Error(
            `Import "${specifier}" resolves outside the plugin workspace. ` +
              `Site plugin imports are confined to the plugin folder.`,
          )
        }
        // Target dir proven inside the workspace — defer extension
        // resolution (.ts/.tsx/index) to the default resolver.
        return undefined
      })
    },
  }
}

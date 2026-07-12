import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { BunPlugin } from 'bun'

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

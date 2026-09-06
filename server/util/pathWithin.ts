import { isAbsolute, relative, sep } from 'node:path'

/**
 * Filesystem path containment — the one rule, in two ergonomics.
 *
 * Schema-level patterns may exclude `..` segments and absolute paths, but
 * filesystem sinks recompose paths via `path.join` / `path.resolve` — so
 * re-assert the resolved `child` stays strictly under `rootDir` after
 * composition. The root itself does not count as "within".
 *
 * Containment is decided by `relative()`, never by a string prefix. A prefix
 * test has to hard-code a separator, which is wrong twice over: it says `/` on
 * Windows (where `relative` and `resolve` produce `\`, so every legitimate path
 * is rejected — GHSA-hwp9), and without a separator it accepts a sibling whose
 * name merely starts with the root (`/srv/site-evil` under `/srv/site`).
 * `relative()` is platform-aware and handles both.
 *
 * Used by every untrusted-path sink: plugin asset extraction
 * (`server/plugins/runtime.ts`, `pack.ts`), the plugin admin upload route,
 * site-bundle media import, the runtime package server, and the site-script
 * workspace.
 */
export function isPathWithin(rootDir: string, child: string): boolean {
  const rel = relative(rootDir, child)
  // '' means child IS the root; an absolute result means different roots
  // entirely (separate drives on Windows).
  if (rel === '' || isAbsolute(rel)) return false
  // Compare against a full segment, so a child legitimately named `..foo`
  // is not mistaken for an escape.
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Throwing form of {@link isPathWithin}, for sinks that treat an escape as fatal. */
export function assertPathWithin(rootDir: string, child: string): void {
  if (!isPathWithin(rootDir, child)) {
    throw new Error(`Path "${child}" escapes root "${rootDir}"`)
  }
}

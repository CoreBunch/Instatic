/**
 * Static analysis scan for sandbox-incompatible literals.
 *
 * Plugin server entrypoints and module packs run inside a QuickJS-WASM
 * sandbox that has NO access to Node/Bun runtime APIs. If a bundle ships
 * with `import 'node:fs'`, `Bun.spawn`, `require()`, etc., the sandbox
 * fails at activation time with a low-level loader error.
 *
 * This scan runs at two points:
 *  - Build time, inside `instatic-plugin build` — catches author mistakes early
 *    with an actionable error message.
 *  - Install time, inside `readPluginPackage` — defense-in-depth against
 *    bundles produced outside our CLI (raw zip uploads, packages signed
 *    elsewhere).
 *
 * The check is purely textual. False positives are possible (a plugin that
 * happens to ship the literal string `'node:fs'` inside a constant), but
 * are rare; the error message lists the offender so authors can rename.
 */

const FORBIDDEN_SANDBOX_LITERALS = [
  "'node:",
  '"node:',
  "'bun:",
  '"bun:',
  'require(',
  'process.binding',
  'globalThis.process.env',
] as const

interface SandboxScanFinding {
  literal: string
}

/** Scan a single bundle's text for forbidden literals. */
export function findSandboxLiterals(source: string): SandboxScanFinding[] {
  const findings: SandboxScanFinding[] = []
  for (const literal of FORBIDDEN_SANDBOX_LITERALS) {
    if (source.includes(literal)) findings.push({ literal })
  }
  return findings
}

/**
 * Throw a descriptive error if any forbidden literal is found. Used by the
 * SDK CLI's `bundleEntrypoint` and by the install-time package validator.
 */
export function assertSandboxSafe(source: string, sourceLabel: string): void {
  const findings = findSandboxLiterals(source)
  if (findings.length === 0) return
  const offenders = findings.map((f) => f.literal).join(', ')
  throw new Error(
    `Plugin sandbox: bundle for "${sourceLabel}" references forbidden literals: ${offenders}.\n` +
    `Plugins run inside a QuickJS-WASM sandbox with no access to Node/Bun runtime APIs. Use the SDK ` +
    `(api.cms.storage.*, api.cms.hooks.*, api.cms.routes.*) for I/O instead.`,
  )
}

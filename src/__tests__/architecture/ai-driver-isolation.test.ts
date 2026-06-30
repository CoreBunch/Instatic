/**
 * Architecture gate — AI driver SDK isolation.
 *
 * The drivers talk DIRECTLY to each provider's REST API over HTTP/SSE — there
 * are no provider SDKs left in the tree. This gate is therefore inverted from
 * its original form: it asserts that NO provider SDK and NO `zod` is imported
 * ANYWHERE under `src/` or `server/` (a strictly stronger boundary than the
 * old "only the driver file may import it" exemption).
 *
 * This replaces the legacy `no-anthropic-sdk.test.ts` gate, which only
 * scanned `src/` and predates the `server/ai/` module. The legacy gate
 * remains in place for the editor (the browser must never import any AI
 * SDK); this gate covers the server side too.
 *
 * Banned repo-wide (no allowed callers):
 *   - `@anthropic-ai/claude-agent-sdk` — replaced by direct POST /v1/messages
 *   - `@openai/agents`                  — replaced by direct POST /v1/responses
 *   - `@openrouter/agent`               — replaced by direct POST /v1/responses
 *   - `zod`                             — drivers pass TypeBox schemas through
 *                                         as JSON Schema; no Zod bridge
 *   - `@anthropic-ai/sdk`               — the plain SDK, always banned
 *
 * Scoped (allowed under one prefix only):
 *   - `@modelcontextprotocol/sdk`       — allowed ONLY under `server/ai/mcp/`,
 *                                         where Instatic implements an MCP
 *                                         *server* (a real wire protocol — a
 *                                         legitimate SDK use). Still banned in
 *                                         the drivers and the browser, which
 *                                         must never speak MCP.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const SCAN_DIRS = ['src', 'server']

interface PackageRule {
  /** Display name in error messages. */
  label: string
  /** Regex matched against the file's content. */
  importRe: RegExp
  /**
   * Repo-relative file paths (forward slashes) that may import this
   * package. Anything outside this list violates the gate.
   */
  allowed: string[]
  /**
   * Repo-relative path prefixes (forward slashes) under which this package
   * may be imported by any file. Used for module-scoped allowances (e.g. the
   * MCP server lives under `server/ai/mcp/` and owns the MCP SDK).
   */
  allowedPrefixes?: string[]
}

const RULES: PackageRule[] = [
  {
    label: '@anthropic-ai/claude-agent-sdk',
    importRe: /from\s+['"]@anthropic-ai\/claude-agent-sdk['"]|require\s*\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/,
    // No allowed callers — replaced by the direct /v1/messages HTTP driver.
    allowed: [],
  },
  {
    label: '@openai/agents',
    importRe: /from\s+['"]@openai\/agents['"]|require\s*\(\s*['"]@openai\/agents['"]\s*\)/,
    // No allowed callers — replaced by the direct /v1/responses HTTP driver.
    allowed: [],
  },
  {
    label: '@openrouter/agent',
    importRe: /from\s+['"]@openrouter\/agent['"]|require\s*\(\s*['"]@openrouter\/agent['"]\s*\)/,
    // No allowed callers — replaced by the direct /v1/responses HTTP driver.
    allowed: [],
  },
  {
    label: '@modelcontextprotocol/sdk',
    importRe: /from\s+['"]@modelcontextprotocol\/sdk['"]|require\s*\(\s*['"]@modelcontextprotocol\/sdk['"]\s*\)|from\s+['"]@modelcontextprotocol\/sdk\/|require\s*\(\s*['"]@modelcontextprotocol\/sdk\//,
    // Allowed only inside the MCP server module — banned everywhere else.
    allowed: [],
    allowedPrefixes: ['server/ai/mcp/'],
  },
  {
    label: 'zod',
    importRe: /from\s+['"]zod['"]|require\s*\(\s*['"]zod['"]\s*\)/,
    // No allowed callers — drivers pass TypeBox schemas through as JSON Schema.
    allowed: [],
  },
  {
    label: '@anthropic-ai/sdk',
    importRe: /from\s+['"]@anthropic-ai\/sdk['"]|require\s*\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/,
    // No allowed callers — the plain Anthropic SDK is banned repo-wide.
    allowed: [],
  },
]

function collectFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    // Don't scan node_modules or build output.
    if (entry === 'node_modules' || entry === '.tmp' || entry === 'dist') continue
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectFiles(full))
    } else if (['.ts', '.tsx', '.js', '.mts', '.mjs'].includes(extname(entry))) {
      // Skip every architecture-gate test file — gates routinely embed the
      // forbidden literals in their own scan regex.
      if (full.includes('/__tests__/architecture/')) continue
      out.push(full)
    }
  }
  return out
}

function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/')
}

describe('ai-driver-isolation gate', () => {
  const allFiles = SCAN_DIRS.flatMap((d) => collectFiles(join(REPO_ROOT, d)))

  for (const rule of RULES) {
    it(`${rule.label}: only allowed files import it`, () => {
      const violations: string[] = []
      for (const file of allFiles) {
        const rel = repoRelative(file)
        if (rule.allowed.includes(rel)) continue
        if (rule.allowedPrefixes?.some((p) => rel.startsWith(p))) continue
        let content: string
        try { content = readFileSync(file, 'utf8') } catch { continue }
        if (rule.importRe.test(content)) {
          violations.push(rel)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `[ai-driver-isolation] ${rule.label} imported from disallowed locations:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nAllowed: ${rule.allowed.length === 0 ? '<none — package is banned repo-wide>' : rule.allowed.join(', ')}`,
        )
      }
      expect(violations).toHaveLength(0)
    })
  }
})

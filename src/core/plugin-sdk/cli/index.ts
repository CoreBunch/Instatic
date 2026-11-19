/**
 * `instatic-plugin` CLI entry.
 *
 * Usage:
 *   instatic-plugin init <name>
 *   instatic-plugin build [<plugin-dir>]
 *   instatic-plugin dev   [<plugin-dir>] [--uploads <path>]
 *
 * Run via Bun:
 *   bun run instatic-plugin <cmd>     inside the Instatic checkout
 *   bunx instatic-plugin <cmd>        from the `@instatic/plugin-sdk` package
 *
 * The CLI lives inside the SDK so plugin authors get the same code that
 * powers the host's `bun run instatic-plugin` script; the package build
 * (`scripts/lib/pluginSdkPackage.ts`) bundles this file as the package's
 * bin. No HTTP, no auth, no env gate — the dev command writes built files
 * directly into the host's `uploads/plugins/<id>/<version>/` directory.
 */
import { resolve } from 'node:path'
import { buildPlugin } from './build'
import { runPluginDev } from './dev'
import { runPluginInit } from './init'
import { lintPlugin } from './lint'

interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

function printHelp(): void {
  console.log(`instatic-plugin — Instatic plugin CLI

Commands:
  init <name>             Scaffold a new plugin in <name>/
  lint  [<plugin-dir>]    Validate manifest, sources, and bundles
  build [<plugin-dir>]    Build the plugin → dist/ + .plugin.zip
  dev   [<plugin-dir>]    Watch sources, rebuild, and sync into the host CMS

Options for \`init\`:
  --kind <type>           Template to scaffold. One of:
                            module          (default) one canvas module
                            content-editor  reads + writes CMS entries via
                                            api.cms.content.* with a typical
                                            content.entry.updated subscriber

Options for \`dev\`:
  --uploads <path>        Override the host's uploads directory.
                          Falls back to INSTATIC_UPLOADS_DIR env var, then to
                          auto-detection (walks up from the plugin folder
                          looking for an uploads/plugins/ directory).

Examples:
  instatic-plugin init acme.confetti
  instatic-plugin init acme.seo --kind content-editor
  instatic-plugin lint acme.confetti
  instatic-plugin build acme.confetti
  instatic-plugin dev acme.confetti
  instatic-plugin dev --uploads ../instatic/uploads
`)
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2))

  if (command === 'help' || command === '--help' || command === '-h' || flags.help) {
    printHelp()
    return
  }

  if (command === 'init') {
    const name = positional[0]
    if (!name) {
      console.error('Usage: instatic-plugin init <name> [--kind=module|content-editor]')
      process.exit(1)
    }
    const kindFlag = flags.kind
    if (kindFlag !== undefined && kindFlag !== true) {
      if (kindFlag !== 'module' && kindFlag !== 'content-editor') {
        console.error(`Unknown --kind value: "${kindFlag}". Use --kind=module or --kind=content-editor.`)
        process.exit(1)
      }
    }
    const kind: 'module' | 'content-editor' = kindFlag === 'content-editor' ? 'content-editor' : 'module'
    const created = await runPluginInit(name, { kind })
    console.log(`✓ Created plugin at ${created}`)
    console.log(`  cd ${created.split('/').pop()} && instatic-plugin dev`)
    return
  }

  if (command === 'build') {
    const sourceDir = resolve(positional[0] ?? process.cwd())
    const result = await buildPlugin(sourceDir)
    console.log(`✓ Built ${result.pluginId}`)
    console.log(`  dist: ${result.outputDir}`)
    if (result.zipPath) console.log(`  zip:  ${result.zipPath}`)
    return
  }

  if (command === 'lint') {
    const sourceDir = resolve(positional[0] ?? process.cwd())
    const result = await lintPlugin(sourceDir)
    const errors = result.findings.filter((f) => f.severity === 'error')
    const warnings = result.findings.filter((f) => f.severity === 'warning')
    for (const finding of result.findings) {
      const tag = finding.severity === 'error' ? '✗' : '!'
      const fileSuffix = finding.file ? ` (${finding.file})` : ''
      console.log(`${tag} [${finding.scope}] ${finding.message}${fileSuffix}`)
    }
    if (errors.length === 0 && warnings.length === 0) {
      console.log(`✓ ${result.pluginId}: no issues found`)
      return
    }
    console.log(
      `\n${errors.length} error${errors.length === 1 ? '' : 's'}, ` +
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'} for ${result.pluginId}`,
    )
    if (errors.length > 0) process.exit(1)
    return
  }

  if (command === 'dev') {
    const sourceDir = resolve(positional[0] ?? process.cwd())
    await runPluginDev({
      pluginDir: sourceDir,
      uploadsDirFlag: typeof flags.uploads === 'string' ? flags.uploads : undefined,
    })
    return
  }

  console.error(`Unknown command: ${command}`)
  printHelp()
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}

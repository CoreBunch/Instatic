export interface RequiredDevDependency {
  name: string
  specifier: string
}

export interface DevDependencyCheck {
  ok: boolean
  missing: RequiredDevDependency[]
}

type PackageResolver = (specifier: string) => string

const requiredDevDependencies: RequiredDevDependency[] = [
  { name: '@sinclair/typebox', specifier: '@sinclair/typebox/package.json' },
  { name: 'vite', specifier: 'vite/package.json' },
  { name: 'tinyglobby', specifier: 'tinyglobby/package.json' },
]

function resolvePackage(specifier: string): string {
  return Bun.resolveSync(specifier, process.cwd())
}

export function checkDevDependencies(resolver: PackageResolver = resolvePackage): DevDependencyCheck {
  const missing: RequiredDevDependency[] = []
  for (const dependency of requiredDevDependencies) {
    try {
      resolver(dependency.specifier)
    } catch {
      missing.push(dependency)
    }
  }
  return { ok: missing.length === 0, missing }
}

export function formatDevDependencyError(
  check: DevDependencyCheck,
  platform: NodeJS.Platform = process.platform,
): string {
  const missing = check.missing.map((dependency) => `  - ${dependency.name}`).join('\n')
  const removeNodeModules = platform === 'win32'
    ? 'Remove-Item -Recurse -Force node_modules'
    : 'rm -rf node_modules'

  return [
    'Local dependencies are incomplete; bun install likely stopped before it finished.',
    'Missing packages:',
    missing,
    '',
    'Run this from the repository root, and make sure it reaches the final "packages installed" summary:',
    '  bun install --frozen-lockfile',
    '',
    'If the same packages are still missing, remove the partial install and retry:',
    `  ${removeNodeModules}`,
    '  bun install --frozen-lockfile',
  ].join('\n')
}

export function formatCommandForLog(command: string[]): string {
  return command.map((arg) => {
    if (arg === '') return '""'
    if (!/[\s"']/.test(arg)) return arg
    return JSON.stringify(arg)
  }).join(' ')
}

export function formatProcessExit(name: string, code: number | null, command: string[]): string {
  return `${name} exited with code ${code ?? 'unknown'}. Command: ${formatCommandForLog(command)}`
}

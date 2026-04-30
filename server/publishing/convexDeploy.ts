import { join } from 'node:path'
import type { PublishFile } from '../../src/core/publishing/types'
import { createTempWorkspace, readTextIfExists, removeTempWorkspace, runCommand, writePublishFiles } from './workspace'

function previewName(projectId: string): string {
  return `pb-${projectId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48)
}

const CONVEX_URL_ENV_VAR = 'PAGE_BUILDER_CONVEX_URL'

export async function deployConvexBackend(args: {
  projectId: string
  files: PublishFile[]
  deployKey: string
  configuredConvexUrl?: string
  previewDeployments: boolean
  log: (line: string) => void
}): Promise<{ convexUrl: string }> {
  const workspace = await createTempWorkspace('page-builder-convex')
  try {
    await writePublishFiles(workspace, args.files)
    const captureCommand = `node -e "require('node:fs').writeFileSync('convex-url.txt', process.env.${CONVEX_URL_ENV_VAR} || '')"`
    const convexArgs = ['convex', 'deploy', '--cmd', captureCommand, '--cmd-url-env-var-name', CONVEX_URL_ENV_VAR]
    if (args.previewDeployments) {
      convexArgs.push(`--preview-create=${previewName(args.projectId)}`)
    }
    args.log(`Running bunx ${convexArgs.join(' ')}`)
    const result = await runCommand('bunx', convexArgs, {
      cwd: workspace,
      env: {
        CONVEX_DEPLOY_KEY: args.deployKey,
      },
    })
    if (result.stdout.trim()) args.log(result.stdout.trim())
    if (result.stderr.trim()) args.log(result.stderr.trim())
    const capturedUrl = (await readTextIfExists(join(workspace, 'convex-url.txt')))?.trim()
    const convexUrl = args.configuredConvexUrl || capturedUrl
    if (!convexUrl) {
      throw new Error('Convex deployed, but no CONVEX_URL was available. Set CONVEX_URL or use a deploy key that exposes CONVEX_URL during deploy.')
    }
    return { convexUrl }
  } finally {
    await removeTempWorkspace(workspace)
  }
}

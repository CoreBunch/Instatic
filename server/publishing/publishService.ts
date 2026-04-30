import { nanoid } from 'nanoid'
import { validateProject } from '../../src/core/persistence/validate'
import type { Project } from '../../src/core/page-tree/types'
import { registry } from '../../src/core/module-engine/registry'
import '../../src/modules/base'
import { classifyProjectForPublish } from '../../src/core/publishing/classifyProject'
import { compileReactSite } from '../../src/core/publishing/compileReactSite'
import { compileConvexBackend } from '../../src/core/publishing/compileConvexBackend'
import type { PublishJob, PublishMode, PublishStatus } from '../../src/core/publishing/types'
import { readPublishingEnv } from './env'
import { deployConvexBackend } from './convexDeploy'
import { deployToVercel } from './vercelClient'

const jobs = new Map<string, PublishJob>()
const projectVersions = new Map<string, number>()

function updateJob(id: string, patch: Partial<PublishJob>) {
  const current = jobs.get(id)
  if (!current) return
  jobs.set(id, {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  })
}

function appendLog(id: string, line: string) {
  const current = jobs.get(id)
  if (!current) return
  updateJob(id, { logs: [...current.logs, line].slice(-100) })
}

function status(id: string, nextStatus: PublishStatus) {
  updateJob(id, { status: nextStatus })
  appendLog(id, nextStatus)
}

function projectDeploymentName(project: Project): string {
  return `${project.name}-${project.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

export function getPublishJob(jobId: string): PublishJob | null {
  return jobs.get(jobId) ?? null
}

export function startPublish(rawProject: unknown, requestedMode?: PublishMode): PublishJob {
  const project = validateProject(rawProject)
  const classification = classifyProjectForPublish(project)
  const mode = requestedMode ?? classification.mode
  const version = (projectVersions.get(project.id) ?? 0) + 1
  projectVersions.set(project.id, version)

  const job: PublishJob = {
    id: nanoid(),
    projectId: project.id,
    mode,
    status: 'queued',
    diagnostics: classification.diagnostics,
    logs: ['queued'],
    version,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  jobs.set(job.id, job)
  void runPublish(job.id, project, mode)
  return job
}

async function runPublish(jobId: string, project: Project, mode: PublishMode) {
  try {
    status(jobId, 'validating')
    const env = readPublishingEnv()
    if (mode === 'managed-convex' && !env.convexDeployKey) {
      throw new Error('CONVEX_DEPLOY_KEY is required for managed Convex publishing.')
    }

    status(jobId, 'compiling')
    const bundle = compileReactSite(project, registry, mode)
    let convexUrl: string | undefined

    if (mode === 'managed-convex') {
      status(jobId, 'deploying_convex')
      const convexFiles = compileConvexBackend(project.data)
      const deployed = await deployConvexBackend({
        projectId: project.id,
        files: convexFiles,
        deployKey: env.convexDeployKey!,
        configuredConvexUrl: env.convexUrl,
        previewDeployments: env.convexPreviewDeployments,
        log: (line) => appendLog(jobId, line),
      })
      convexUrl = deployed.convexUrl
      bundle.files.push({ path: '.env.production', data: `VITE_CONVEX_URL=${convexUrl}\n`, encoding: 'utf8' })
      updateJob(jobId, { convexUrl })
    }

    status(jobId, 'deploying_vercel')
    const deployment = await deployToVercel({
      token: env.vercelToken,
      teamId: env.vercelTeamId,
      projectName: projectDeploymentName(project),
      bundle,
    })

    updateJob(jobId, {
      status: 'ready',
      url: deployment.url,
      logs: [...(jobs.get(jobId)?.logs ?? []), `ready ${deployment.url}`],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publish failed'
    updateJob(jobId, {
      status: 'failed',
      error: message,
      logs: [...(jobs.get(jobId)?.logs ?? []), message],
    })
  }
}

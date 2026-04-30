import type { PublishBundle } from '../../src/core/publishing/types'

export interface VercelDeployOptions {
  token: string
  teamId?: string
  projectName: string
  bundle: PublishBundle
}

function safeProjectName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/^-|-$/g, '')
  return safe || 'page-builder-app'
}

function teamQuery(teamId?: string): string {
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''
}

async function vercelFetch<T>(
  path: string,
  options: { token: string; teamId?: string; method: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`https://api.vercel.com${path}${teamQuery(options.teamId)}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) as T & { error?: { message?: string; code?: string } } : {} as T
  if (!response.ok) {
    const code = data.error?.code
    if (response.status === 409 || code === 'conflict') return data as T
    throw new Error(data.error?.message ?? `Vercel API ${path} failed with ${response.status}`)
  }
  return data as T
}

export async function deployToVercel(options: VercelDeployOptions): Promise<{ deploymentId: string; url: string; projectName: string }> {
  const projectName = safeProjectName(options.projectName)
  await vercelFetch('/v11/projects', {
    token: options.token,
    teamId: options.teamId,
    method: 'POST',
    body: {
      name: projectName,
      framework: 'vite',
    },
  })

  const files = options.bundle.files.map((file) => ({
    file: file.path,
    data: file.data,
    encoding: file.encoding === 'utf8' ? 'utf-8' : 'base64',
  }))

  const body = {
    name: projectName,
    project: projectName,
    target: 'production',
    files,
    projectSettings: {
      framework: 'vite',
      buildCommand: options.bundle.buildCommand,
      outputDirectory: options.bundle.outputDirectory,
      installCommand: 'npm install',
    },
  }

  const deployment = await vercelFetch<{ id: string; url: string }>('/v13/deployments', {
    token: options.token,
    teamId: options.teamId,
    method: 'POST',
    body,
  })

  return {
    deploymentId: deployment.id,
    url: deployment.url.startsWith('http') ? deployment.url : `https://${deployment.url}`,
    projectName,
  }
}

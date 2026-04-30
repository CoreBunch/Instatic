import type { PublishMode } from '../src/core/publishing/types'
import { getPublishJob, startPublish } from './publishing/publishService'

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

export async function handlePublishRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'POST' && url.pathname === '/api/publish') {
    const body = await req.json() as { project?: unknown; mode?: PublishMode }
    if (!body.project) return json({ error: 'project is required' }, { status: 400 })
    try {
      const job = startPublish(body.project, body.mode)
      return json({ job })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to start publish'
      return json({ error: message }, { status: 400 })
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/publish/')) {
    const jobId = url.pathname.split('/').pop()
    const job = jobId ? getPublishJob(jobId) : null
    if (!job) return json({ error: 'Publish job not found' }, { status: 404 })
    return json({ job })
  }

  return json({ error: 'Not found' }, { status: 404 })
}


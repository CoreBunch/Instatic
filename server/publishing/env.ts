export interface PublishingEnv {
  vercelToken: string
  vercelTeamId?: string
  convexDeployKey?: string
  convexUrl?: string
  convexPreviewDeployments: boolean
}

export function readPublishingEnv(env: Record<string, string | undefined> = process.env): PublishingEnv {
  const vercelToken = env.VERCEL_TOKEN
  if (!vercelToken) {
    throw new Error('VERCEL_TOKEN is required for publishing.')
  }

  return {
    vercelToken,
    vercelTeamId: env.VERCEL_TEAM_ID || env.VERCEL_TEAM_SLUG,
    convexDeployKey: env.CONVEX_DEPLOY_KEY,
    convexUrl: env.CONVEX_URL,
    convexPreviewDeployments: env.CONVEX_PREVIEW_DEPLOYMENTS === 'true',
  }
}


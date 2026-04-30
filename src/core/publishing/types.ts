export type PublishMode = 'static' | 'managed-convex'

export type PublishStatus =
  | 'queued'
  | 'validating'
  | 'compiling'
  | 'deploying_convex'
  | 'deploying_vercel'
  | 'ready'
  | 'failed'

export interface PublishFile {
  path: string
  data: string
  encoding: 'utf8' | 'base64'
}

export interface PublishBundle {
  mode: PublishMode
  files: PublishFile[]
  buildCommand: string
  outputDirectory: string
  requiredEnv: string[]
}

export interface PublishDiagnostic {
  level: 'error' | 'warning'
  code: string
  message: string
  path?: string
}

export type PublishCompileResult =
  | { ok: true; bundle: PublishBundle; diagnostics: PublishDiagnostic[] }
  | { ok: false; diagnostics: PublishDiagnostic[] }

export interface PublishJob {
  id: string
  projectId: string
  mode: PublishMode
  status: PublishStatus
  diagnostics: PublishDiagnostic[]
  logs: string[]
  version: number
  url?: string
  convexUrl?: string
  error?: string
  createdAt: number
  updatedAt: number
}


import type { Project } from '../page-tree/types'
import type { PublishDiagnostic, PublishMode } from './types'

export interface ProjectPublishClassification {
  mode: PublishMode
  diagnostics: PublishDiagnostic[]
}

export function classifyProjectForPublish(project: Project): ProjectPublishClassification {
  const diagnostics: PublishDiagnostic[] = []
  const hasTables = project.data.tables.length > 0

  if (project.files.some((file) => file.type === 'script' || file.type === 'config')) {
    diagnostics.push({
      level: 'warning',
      code: 'USER_CODE_NOT_EXECUTED',
      message: 'Managed publishing ignores project scripts and config files for safety.',
      path: 'project.files',
    })
  }

  return {
    mode: hasTables ? 'managed-convex' : 'static',
    diagnostics,
  }
}


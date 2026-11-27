import type { CoreCapability } from '@core/capabilities'
import type { TSchema } from '@core/utils/typeboxHelpers'

export interface Operation {
  method: string
  path: string
  summary: string
  /** Every group must match at least one grant. Empty means any paired account. */
  permissions: readonly (readonly CoreCapability[])[]
  bodySchema?: TSchema
  querySchema?: TSchema
  example?: unknown
  multipart?: Record<string, string>
  raw?: string
  pluginInput?: string
  outputFile?: string
}

export type OperationInputs = Pick<Operation, 'bodySchema' | 'querySchema' | 'example' | 'multipart' | 'raw' | 'outputFile' | 'pluginInput'>
type GrantGroups = Operation['permissions']
type Grants = CoreCapability | readonly CoreCapability[] | GrantGroups

function isGrouped(grants: Exclude<Grants, string>): grants is GrantGroups {
  return grants.length === 0 || Array.isArray(grants[0])
}

function permissionGroups(grants: Grants): Operation['permissions'] {
  if (typeof grants === 'string') return [[grants]]
  return isGrouped(grants) ? grants : [grants]
}

export function operation(method: string, path: string, grants: Grants, summary: string, inputs: OperationInputs = {}): Operation {
  return { method, path, permissions: permissionGroups(grants), summary, ...inputs }
}

export function canDiscover(operation: Operation, grants: readonly CoreCapability[]): boolean {
  return operation.permissions.every(group => group.some(capability => grants.includes(capability)))
}

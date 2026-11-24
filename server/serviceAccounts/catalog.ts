import type { CoreCapability } from '@core/capabilities'
import { adminOperations } from './catalog/admin'
import { aiOperations } from './catalog/ai'
import { dataOperations } from './catalog/data'
import { mediaOperations } from './catalog/media'
import { canDiscover, type Operation } from './catalog/operation'
import { pluginOperations, registeredPluginOperations } from './catalog/plugins'
import { siteOperations } from './catalog/site'

export const cmsOperations = [...siteOperations, ...adminOperations, ...mediaOperations, ...dataOperations, ...pluginOperations, ...aiOperations]

export function availableOperations(capabilities: readonly CoreCapability[]) {
  const available = [...cmsOperations, ...registeredPluginOperations()].filter(op => canDiscover(op, capabilities))
  // The HTTP router normalizes HEAD to GET before dispatch for every route.
  return available.flatMap(op => op.method === 'GET'
    ? [op, { ...op, method: 'HEAD', summary: 'Read response headers. ' + op.summary, outputFile: undefined }]
    : [op])
}

export function describeOperation(op: Operation) {
  const { method, path, summary, permissions, querySchema, bodySchema, multipart, example, raw, pluginInput, outputFile } = op
  const pathParameters = path.split('/').filter(part => part.startsWith(':')).map(part => part.slice(1))
  const body = bodySchema ? 'json' : multipart ? 'multipart/form-data' : raw ? 'binary' : pluginInput ? 'plugin-defined' : 'none'
  const requiredQuery: string[] = querySchema?.required ?? []
  const query = requiredQuery.map(key => key + '=' + key.toUpperCase()).join('&')
  const target = query ? path + '?' + query : path
  const args = ['instatic', 'api', method, /^[a-z0-9/:_.%-]+$/i.test(target) ? target : "'" + target.replaceAll("'", "'\\''") + "'"]
  if (path === 'site-document' || path.startsWith('canvas/')) args.push('--branch', 'BRANCH_ID')
  if (bodySchema) args.push('--file', 'request.json')
  if (multipart) {
    args.push('--upload', 'FILE')
    if (multipart.grantedPermissions) args.push('--field', "'grantedPermissions=[]'")
  }
  if (raw) args.push('--raw', raw)
  if (outputFile) args.push('--out', outputFile)
  return { method, path, summary, permissions, pathParameters, querySchema, body, bodySchema, multipart, pluginInput, example, command: args.join(' ') }
}

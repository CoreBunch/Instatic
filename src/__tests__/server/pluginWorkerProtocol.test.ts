import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  ApiCallValidationError,
  parseApiCall,
} from '../../../server/plugins/protocol/parser'

describe('plugin worker IPC protocol', () => {
  it('rejects malformed storage create payloads before host dispatch', () => {
    expect(() =>
      parseApiCall({
        kind: 'api-call',
        correlationId: 'req_1',
        pluginId: 'acme.workflow',
        target: 'cms.storage.create',
        args: ['events', 'not-an-object'],
      }),
    ).toThrow(ApiCallValidationError)
  })

  it('rejects route registrations with inconsistent route keys', () => {
    expect(() =>
      parseApiCall({
        kind: 'api-call',
        correlationId: 'req_2',
        pluginId: 'acme.workflow',
        target: 'cms.routes.register',
        args: [{
          method: 'POST',
          path: '/status',
          access: { kind: 'capability', capability: 'plugins.read' },
          routeKey: 'GET:/status',
        }],
      }),
    ).toThrow(/routeKey/)
  })

  it('rejects malformed loop filter controls before registration', () => {
    expect(() =>
      parseApiCall({
        kind: 'api-call',
        correlationId: 'req_3',
        pluginId: 'acme.workflow',
        target: 'cms.loops.registerSource',
        args: [{
          id: 'acme.workflow.posts',
          label: 'Workflow Posts',
          filterSchema: {
            status: { type: 'unsupported', label: 'Status' },
          },
          orderByOptions: [{ id: 'newest', label: 'Newest' }],
          fields: [{ id: 'title', label: 'Title', format: 'plain' }],
        }],
      }),
    ).toThrow(ApiCallValidationError)
  })

  it('accepts valid settings replacement payloads', () => {
    const parsed = parseApiCall({
      kind: 'api-call',
      correlationId: 'req_4',
      pluginId: 'acme.workflow',
      target: 'cms.settings.replace',
      args: [{ enabled: true, label: 'Workflow' }],
    })

    expect(parsed.target).toBe('cms.settings.replace')
    expect(parsed.args[0]).toEqual({ enabled: true, label: 'Workflow' })
  })

  it('rejects malformed tree mutation nodes before host dispatch', () => {
    expect(() =>
      parseApiCall({
        kind: 'api-call',
        correlationId: 'req_5',
        pluginId: 'acme.workflow',
        target: 'cms.content.tree.mutate',
        args: [
          'entry-1',
          'body',
          [{
            kind: 'insertNode',
            parentId: 'root',
            index: 0,
            node: { id: 'broken-node' },
          }],
        ],
      }),
    ).toThrow(ApiCallValidationError)
  })

  it('rejects malformed tree replacements before host dispatch', () => {
    expect(() =>
      parseApiCall({
        kind: 'api-call',
        correlationId: 'req_6',
        pluginId: 'acme.workflow',
        target: 'cms.content.tree.replace',
        args: [
          'entry-1',
          'body',
          {
            rootNodeId: 'root',
            nodes: {
              root: { id: 'root' },
            },
          },
        ],
      }),
    ).toThrow(ApiCallValidationError)
  })

  it('keeps host dispatch behind the protocol parser', async () => {
    const source = await readFile(
      new URL('../../../server/plugins/host/workerPool.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('parseApiCall(')
    expect(source).not.toContain('msg.args as')
  })

  it('reuses the canonical module-engine property schema for loop filters', async () => {
    const source = await readFile(
      new URL('../../core/loops/descriptorSchema.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('@core/module-engine')
    expect(source).toContain('PropertySchemaSchema')
    expect(source).not.toContain('const PropertyControlSchema = Type.Recursive')
    expect(source).not.toContain('const PropertyConditionSchema = Type.Recursive')
  })
})

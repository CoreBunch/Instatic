/**
 * Architecture gate — Visual Component tool surface parity.
 *
 * `src/core/ai/toolSchemas.ts` is a dependency-free leaf that `server/` loads,
 * so it cannot import the VC engine. That forces it to RESTATE the param type
 * union (`ComponentParamTypeSchema`) that `@core/visualComponents` owns
 * (`VCParamTypeSchema`). Two hand-maintained copies of one list drift, and the
 * failure is quiet: the model is told a type exists that the store then falls
 * back to 'string' for, or a real type stays permanently unreachable over MCP.
 * This gate is the thing that makes the duplication safe.
 *
 * It also asserts the four component tools stay wired end to end — advertised
 * by the server registry AND dispatched by the browser executor. A tool that
 * is advertised but not dispatched fails at call time with "Unknown instatic
 * tool", which reads to a caller like the feature is broken rather than
 * missing a case.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { siteWriteTools } from '../../../server/ai/tools/site/writeTools'
import { ComponentParamTypeSchema } from '@core/ai'

const PROJECT_ROOT = join(import.meta.dir, '../../../')

const COMPONENT_TOOLS = [
  'site_create_component',
  'site_insert_component',
  'site_set_component_params',
  'site_bind_component_prop',
  'site_bind_component_variant',
] as const

/** Literal values of a TypeBox union of string literals. */
function literalValues(schema: { anyOf?: { const?: unknown }[] }): string[] {
  return (schema.anyOf ?? [])
    .map((member) => member.const)
    .filter((value): value is string => typeof value === 'string')
    .sort()
}

describe('Visual Component tool parity', () => {
  it('the MCP param type list matches the VC engine list exactly', () => {
    // Read the engine's list from source rather than importing it: the engine
    // exports the derived TYPE but keeps VCParamTypeSchema module-private.
    const enginePath = join(PROJECT_ROOT, 'src/core/visualComponents/schemas.ts')
    const source = readFileSync(enginePath, 'utf8')
    const block = source.slice(
      source.indexOf('const VCParamTypeSchema'),
      source.indexOf('export type VCParamType'),
    )
    expect(block.length, 'VCParamTypeSchema declaration not found — did it move?').toBeGreaterThan(0)

    const engineTypes = [...block.matchAll(/Type\.Literal\('([^']+)'\)/g)]
      .map((m) => m[1] as string)
      .sort()
    expect(engineTypes.length).toBeGreaterThan(0)

    expect(
      literalValues(ComponentParamTypeSchema as { anyOf?: { const?: unknown }[] }),
      'ComponentParamTypeSchema (@core/ai) drifted from VCParamTypeSchema (@core/visualComponents). ' +
        'Update both — the MCP schema restates the list because the leaf cannot import the engine.',
    ).toEqual(engineTypes)
  })

  it('every component tool is advertised by the server registry', () => {
    const names = siteWriteTools.map((tool) => tool.name)
    for (const tool of COMPONENT_TOOLS) {
      expect(names, `${tool} is not registered in siteWriteTools`).toContain(tool)
    }
  })

  it('every advertised component tool has an executor dispatch case', () => {
    const executor = readFileSync(
      join(PROJECT_ROOT, 'src/admin/pages/site/agent/executor.ts'),
      'utf8',
    )
    for (const tool of COMPONENT_TOOLS) {
      expect(
        executor.includes(`case '${tool}'`),
        `${tool} is advertised to models but has no case in executor.ts — calling it would ` +
          `return "Unknown instatic tool".`,
      ).toBe(true)
    }
  })

  it('every component tool waits for collab sync before mutating', () => {
    const classification = readFileSync(
      join(PROJECT_ROOT, 'src/admin/pages/site/agent/toolClassification.ts'),
      'utf8',
    )
    const mutationBlock = classification.slice(classification.indexOf('SITE_MUTATION_TOOLS'))
    for (const tool of COMPONENT_TOOLS) {
      expect(
        mutationBlock.includes(`'${tool}'`),
        `${tool} mutates the site document but is missing from SITE_MUTATION_TOOLS, so it can ` +
          `run before the collab relay has synced and be silently dropped.`,
      ).toBe(true)
    }
  })
})

import { describe, expect, test } from 'bun:test'
import {
  extractSourceFunctions,
  parseLcov,
  toIstanbul,
} from './lcov-to-istanbul'

describe('lcov-to-istanbul', () => {
  test('preserves native LCOV function records when the producer provides them', async () => {
    const records = parseLcov([
      'SF:src/example.ts',
      'FN:4,kept',
      'FNDA:7,kept',
      'DA:4,7',
      'end_of_record',
    ].join('\n'))
    let sourceRead = false

    const coverage = await toIstanbul(records, async () => {
      sourceRead = true
      return ''
    })
    const file = Object.values(coverage)[0]

    expect(sourceRead).toBe(false)
    expect(file?.fnMap['0']).toMatchObject({
      name: 'kept',
      line: 4,
    })
    expect(file?.f['0']).toBe(7)
  })

  test('derives runtime function ranges and hits from source when Bun omits FN records', async () => {
    const source = [
      'export function called() {',
      '  return true',
      '}',
      '',
      'export const uncalled = () => {',
      '  return false',
      '}',
      '',
      'export const object = {',
      '  method() {',
      '    return true',
      '  },',
      '}',
      '',
      'declare function signatureOnly(): void',
    ].join('\n')
    const lineHits = new Map([
      [1, 3],
      [2, 3],
      [5, 0],
      [6, 0],
      [10, 2],
      [11, 2],
    ])

    const functions = extractSourceFunctions(source, 'src/example.ts', lineHits)

    expect(functions.map(({ name, line, endLine, hits }) => ({
      name,
      line,
      endLine,
      hits,
    }))).toEqual([
      { name: 'called', line: 1, endLine: 3, hits: 3 },
      { name: '<arrow>', line: 5, endLine: 7, hits: 0 },
      { name: 'method', line: 10, endLine: 12, hits: 2 },
    ])
  })

  test('emits inferred functions in Istanbul fnMap and f fields', async () => {
    const records = parseLcov([
      'SF:src/example.ts',
      'FNF:1',
      'FNH:1',
      'DA:1,5',
      'DA:2,5',
      'end_of_record',
    ].join('\n'))
    const coverage = await toIstanbul(
      records,
      async () => 'export function example() {\n  return true\n}\n',
    )
    const file = Object.values(coverage)[0]

    expect(file?.fnMap['0']).toMatchObject({
      name: 'example',
      line: 1,
      decl: {
        start: { line: 1, column: 0 },
        end: { line: 3, column: 1 },
      },
    })
    expect(file?.f['0']).toBe(5)
    expect(file?.s).toEqual({ '0': 5, '1': 5 })
  })
})

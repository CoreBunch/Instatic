/**
 * scripts/lcov-to-istanbul.ts
 *
 * Convert Bun's LCOV coverage output (`.coverage/lcov.info`) into the Istanbul
 * `coverage-final.json` format that `fallow health --coverage <path>` expects.
 *
 * Bun emits LCOV via `bun test --coverage --coverage-reporter=lcov`, but
 * fallow's CRAP scorer wants Istanbul JSON. Bun's LCOV currently includes
 * aggregate `FNF` / `FNH` function totals but omits the per-function `FN` /
 * `FNDA` records Istanbul needs. This converter therefore combines the LCOV
 * line hits with TypeScript's source AST:
 *   - `f` / `fnMap` from native `FN` / `FNDA` records when present, otherwise
 *     from source function ranges with Bun's declaration-line hit count.
 *   - `s` / `statementMap` from LCOV's `DA` records — used as a fallback
 *     line-coverage signal.
 *   - `b` / `branchMap` left empty: LCOV's `BRDA` data uses block IDs that
 *     don't translate to Istanbul's branch shape without source-map context.
 *     CRAP is dominated by function coverage in practice, so this is fine.
 *
 * Run with `bun run scripts/lcov-to-istanbul.ts [in.lcov] [out.json]`.
 * Defaults to `.coverage/lcov.info` → `.coverage/coverage-final.json`.
 *
 * The `wired:coverage` script in package.json composes
 *   `bun test --coverage` → this converter → `npx fallow health --coverage`.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface IstanbulRange {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

interface IstanbulFunction {
  name: string
  decl: IstanbulRange
  loc: IstanbulRange
  line: number
}

interface IstanbulFileCoverage {
  path: string
  statementMap: Record<string, IstanbulRange>
  fnMap: Record<string, IstanbulFunction>
  branchMap: Record<string, never>
  s: Record<string, number>
  f: Record<string, number>
  b: Record<string, never>
}

type IstanbulCoverage = Record<string, IstanbulFileCoverage>

interface LcovFunction {
  line: number
  endLine: number
  name: string
  hits: number
  range?: IstanbulRange
}

interface LcovFileRecord {
  path: string
  functions: LcovFunction[]
  /** line number → hit count */
  lineHits: Map<number, number>
}

type ReadSource = (path: string) => Promise<string>

/**
 * Parse an LCOV file into a list of per-file records.
 *
 * LCOV is line-oriented; the records we care about:
 *   SF:<path>                — file path (start of a record)
 *   FN:<line>,<name>         — function declaration at <line>
 *   FNDA:<hits>,<name>       — function hit count
 *   DA:<line>,<hits>         — line hit count
 *   end_of_record            — terminator
 */
export function parseLcov(lcov: string): LcovFileRecord[] {
  const records: LcovFileRecord[] = []
  let current: LcovFileRecord | null = null
  // FN comes before FNDA — buffer FNs by name so FNDA can backfill the hit count.
  const fnByName = new Map<string, LcovFunction>()

  for (const rawLine of lcov.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('SF:')) {
      current = { path: line.slice(3), functions: [], lineHits: new Map() }
      fnByName.clear()
      continue
    }
    if (!current) continue

    if (line.startsWith('FN:')) {
      const [lineNumber, ...nameParts] = line.slice(3).split(',')
      const name = nameParts.join(',')
      const fnLine = Number(lineNumber)
      const fn: LcovFunction = {
        line: fnLine,
        endLine: fnLine,
        name,
        hits: 0,
      }
      current.functions.push(fn)
      fnByName.set(name, fn)
      continue
    }

    if (line.startsWith('FNDA:')) {
      const [hits, ...nameParts] = line.slice(5).split(',')
      const name = nameParts.join(',')
      const fn = fnByName.get(name)
      if (fn) fn.hits = Number(hits)
      continue
    }

    if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',')
      current.lineHits.set(Number(lineNumber), Number(hits))
      continue
    }

    if (line === 'end_of_record') {
      records.push(current)
      current = null
      fnByName.clear()
    }
  }

  if (current) records.push(current)
  return records
}

/** Build a single-line range — fallow only needs the line number for CRAP. */
function lineRange(line: number): IstanbulRange {
  return {
    start: { line, column: 0 },
    end: { line, column: 0 },
  }
}

function sourceRange(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): IstanbulRange {
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end)
  return {
    start: {
      line: startPosition.line + 1,
      column: startPosition.character,
    },
    end: {
      line: endPosition.line + 1,
      column: endPosition.character,
    },
  }
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isPrivateIdentifier(name)) return name.text
  return null
}

function sourceFunctionName(node: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return node.name?.text ?? '<function>'
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return propertyNameText(node.name) ?? '<function>'
  }
  return '<arrow>'
}

function isRuntimeFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) && node.body !== undefined
}

/**
 * Build the function inventory Bun leaves out of LCOV. Declaration lines match
 * fallow's source function index; full ranges keep the output valid Istanbul.
 */
export function extractSourceFunctions(
  sourceText: string,
  path: string,
  lineHits: ReadonlyMap<number, number>,
): LcovFunction[] {
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  )
  const functions: LcovFunction[] = []

  function visit(node: ts.Node): void {
    if (isRuntimeFunction(node)) {
      const range = sourceRange(sourceFile, node.getStart(sourceFile), node.end)
      let hits = lineHits.get(range.start.line)
      if (hits === undefined) {
        for (let line = range.start.line + 1; line <= range.end.line; line++) {
          const lineHitCount = lineHits.get(line)
          if (lineHitCount !== undefined) {
            hits = lineHitCount
            break
          }
        }
      }
      functions.push({
        line: range.start.line,
        endLine: range.end.line,
        name: sourceFunctionName(node),
        hits: hits ?? 0,
        range,
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return functions
}

export async function toIstanbul(
  records: LcovFileRecord[],
  readSource: ReadSource = (path) => readFile(path, 'utf-8'),
): Promise<IstanbulCoverage> {
  const out: IstanbulCoverage = {}
  for (const record of records) {
    const absolutePath = isAbsolute(record.path)
      ? record.path
      : resolve(PROJECT_ROOT, record.path)

    let functions = record.functions
    if (functions.length === 0) {
      try {
        const sourceText = await readSource(absolutePath)
        functions = extractSourceFunctions(sourceText, absolutePath, record.lineHits)
      } catch (err) {
        const code = err instanceof Error && 'code' in err ? err.code : undefined
        if (code !== 'ENOENT') throw err
      }
    }

    const fnMap: Record<string, IstanbulFunction> = {}
    const f: Record<string, number> = {}
    functions.forEach((fn, idx) => {
      const id = String(idx)
      const range = fn.range ?? lineRange(fn.line)
      fnMap[id] = {
        name: fn.name,
        decl: range,
        loc: range,
        line: fn.line,
      }
      f[id] = fn.hits
    })

    const statementMap: Record<string, IstanbulRange> = {}
    const s: Record<string, number> = {}
    let stmtIdx = 0
    for (const [line, hits] of record.lineHits) {
      const id = String(stmtIdx++)
      statementMap[id] = lineRange(line)
      s[id] = hits
    }

    out[absolutePath] = {
      path: absolutePath,
      statementMap,
      fnMap,
      branchMap: {},
      s,
      f,
      b: {},
    }
  }
  return out
}

async function main() {
  const [inputArg, outputArg] = process.argv.slice(2)
  const inputPath = resolve(PROJECT_ROOT, inputArg ?? '.coverage/lcov.info')
  const outputPath = resolve(PROJECT_ROOT, outputArg ?? '.coverage/coverage-final.json')

  const lcov = await readFile(inputPath, 'utf-8')
  const records = parseLcov(lcov)
  const istanbul = await toIstanbul(records)

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(istanbul), 'utf-8')

  const fileCount = Object.keys(istanbul).length
  const fnCount = Object.values(istanbul).reduce(
    (sum, file) => sum + Object.keys(file.f).length,
    0,
  )
  console.log(
    `[lcov-to-istanbul] ${inputPath} → ${outputPath}\n` +
      `  ${fileCount} files, ${fnCount} functions`,
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[lcov-to-istanbul]', err)
    process.exit(1)
  })
}

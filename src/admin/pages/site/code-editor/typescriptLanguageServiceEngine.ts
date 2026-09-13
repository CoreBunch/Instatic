import * as ts from 'typescript'
import type {
  TypeScriptCompletionResult,
  TypeScriptEditorDiagnostic,
  TypeScriptHoverResult,
  TypeScriptProjectFile,
} from './typescriptProtocol'

const DEFAULT_LIBRARY = '/lib.es2020.full.d.ts'
const MAX_COMPLETIONS = 750

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.ReactJSX,
  lib: ['lib.es2020.full.d.ts'],
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2020,
}

interface VirtualFile {
  content: string
  version: number
}

function virtualPath(path: string): string {
  return `/${path.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

function libraryPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return `/${name}`
}

function isTypeScriptPath(path: string): boolean {
  return /\.(?:[cm]?ts|tsx)$/.test(path)
}

function diagnosticSeverity(category: ts.DiagnosticCategory): TypeScriptEditorDiagnostic['severity'] {
  if (category === ts.DiagnosticCategory.Error) return 'error'
  if (category === ts.DiagnosticCategory.Warning) return 'warning'
  return 'info'
}

function isBareModuleResolutionDiagnostic(diagnostic: ts.Diagnostic): boolean {
  if (diagnostic.code !== 2307 && diagnostic.code !== 2792) return false
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  const match = message.match(/Cannot find module ['"]([^'"]+)['"]/)
  if (!match) return false
  return !match[1]!.startsWith('.') && !match[1]!.startsWith('/')
}

function completionType(kind: ts.ScriptElementKind): string | undefined {
  switch (kind) {
    case ts.ScriptElementKind.classElement:
      return 'class'
    case ts.ScriptElementKind.interfaceElement:
    case ts.ScriptElementKind.typeElement:
      return 'type'
    case ts.ScriptElementKind.enumElement:
      return 'enum'
    case ts.ScriptElementKind.functionElement:
    case ts.ScriptElementKind.localFunctionElement:
    case ts.ScriptElementKind.memberFunctionElement:
      return 'function'
    case ts.ScriptElementKind.constElement:
    case ts.ScriptElementKind.letElement:
    case ts.ScriptElementKind.variableElement:
    case ts.ScriptElementKind.localVariableElement:
      return 'variable'
    case ts.ScriptElementKind.memberVariableElement:
    case ts.ScriptElementKind.memberGetAccessorElement:
    case ts.ScriptElementKind.memberSetAccessorElement:
      return 'property'
    case ts.ScriptElementKind.moduleElement:
    case ts.ScriptElementKind.externalModuleName:
      return 'namespace'
    case ts.ScriptElementKind.keyword:
      return 'keyword'
    case ts.ScriptElementKind.string:
      return 'text'
    default:
      return undefined
  }
}

function directoriesFor(files: Iterable<string>, rootPath: string): string[] {
  const root = virtualPath(rootPath).replace(/\/$/, '')
  const directories = new Set<string>()
  for (const file of files) {
    if (!file.startsWith(`${root}/`)) continue
    const relative = file.slice(root.length + 1)
    const directory = relative.split('/')[0]
    if (directory && relative.includes('/')) directories.add(directory)
  }
  return [...directories]
}

/**
 * One in-memory TypeScript project owned by the browser worker. The worker
 * keeps the compiler and DOM libraries off the UI thread; this class keeps
 * the language-service host deterministic and unit-testable.
 */
export class TypeScriptLanguageServiceEngine {
  private readonly files = new Map<string, VirtualFile>()
  private readonly libraries = new Map<string, string>()
  private projectVersion = 0
  private readonly languageService: ts.LanguageService

  constructor(libraries: Record<string, string>) {
    for (const [path, content] of Object.entries(libraries)) {
      this.libraries.set(libraryPath(path), content)
    }

    const host: ts.LanguageServiceHost = {
      directoryExists: (path) => {
        const prefix = `${virtualPath(path).replace(/\/$/, '')}/`
        return prefix === '//' || [...this.files.keys(), ...this.libraries.keys()]
          .some((file) => file.startsWith(prefix))
      },
      fileExists: (path) => this.hasFile(path),
      getCompilationSettings: () => COMPILER_OPTIONS,
      getCurrentDirectory: () => '/',
      getDefaultLibFileName: () => DEFAULT_LIBRARY,
      getDirectories: (path) => directoriesFor(
        [...this.files.keys(), ...this.libraries.keys()],
        path,
      ),
      getNewLine: () => '\n',
      getProjectVersion: () => String(this.projectVersion),
      getScriptFileNames: () => [DEFAULT_LIBRARY, ...this.files.keys()],
      getScriptKind: (path) => path.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
      getScriptSnapshot: (path) => {
        const content = this.readFile(path)
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
      },
      getScriptVersion: (path) => String(this.files.get(virtualPath(path))?.version ?? 0),
      readFile: (path) => this.readFile(path),
      readDirectory: (rootDir, extensions) => {
        const root = virtualPath(rootDir).replace(/\/$/, '')
        return [...this.files.keys()].filter((file) => (
          file.startsWith(`${root}/`) &&
          (!extensions || extensions.some((extension) => file.endsWith(extension)))
        ))
      },
      useCaseSensitiveFileNames: () => true,
    }

    this.languageService = ts.createLanguageService(
      host,
      ts.createDocumentRegistry(true, '/'),
    )
  }

  sync(files: TypeScriptProjectFile[]): void {
    const incoming = new Map(
      files
        .filter((file) => isTypeScriptPath(file.path))
        .map((file) => [virtualPath(file.path), file.content]),
    )

    let changed = false
    for (const path of this.files.keys()) {
      if (incoming.has(path)) continue
      this.files.delete(path)
      changed = true
    }
    for (const [path, content] of incoming) {
      const current = this.files.get(path)
      if (current?.content === content) continue
      this.files.set(path, { content, version: (current?.version ?? 0) + 1 })
      changed = true
    }
    if (changed) this.projectVersion += 1
  }

  update(path: string, content: string): void {
    const normalized = virtualPath(path)
    if (!isTypeScriptPath(normalized)) return
    const current = this.files.get(normalized)
    if (current?.content === content) return
    this.files.set(normalized, { content, version: (current?.version ?? 0) + 1 })
    this.projectVersion += 1
  }

  diagnostics(path: string): TypeScriptEditorDiagnostic[] {
    const fileName = virtualPath(path)
    const sourceFile = this.languageService.getProgram()?.getSourceFile(fileName)
    if (!sourceFile) return []

    const diagnostics = [
      ...this.languageService.getSyntacticDiagnostics(fileName),
      ...this.languageService.getSemanticDiagnostics(fileName),
    ]
    const seen = new Set<string>()

    return diagnostics.flatMap((diagnostic) => {
      if (isBareModuleResolutionDiagnostic(diagnostic)) return []
      const from = Math.max(0, diagnostic.start ?? 0)
      const to = Math.max(from + 1, from + (diagnostic.length ?? 1))
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      const key = `${diagnostic.code}:${from}:${to}:${message}`
      if (seen.has(key)) return []
      seen.add(key)
      const location = sourceFile.getLineAndCharacterOfPosition(
        Math.min(from, sourceFile.getFullText().length),
      )
      return [{
        code: diagnostic.code,
        severity: diagnosticSeverity(diagnostic.category),
        message,
        from,
        to,
        line: location.line + 1,
        column: location.character,
      }]
    })
  }

  completions(path: string, position: number): TypeScriptCompletionResult | undefined {
    const fileName = virtualPath(path)
    const info = this.languageService.getCompletionsAtPosition(fileName, position, {
      includeCompletionsForImportStatements: true,
      includeCompletionsForModuleExports: true,
      includeCompletionsWithInsertText: true,
    })
    if (!info) return undefined

    const span = info.optionalReplacementSpan
    return {
      from: span?.start ?? position,
      to: span ? span.start + span.length : position,
      options: info.entries.slice(0, MAX_COMPLETIONS).map((entry) => ({
        label: entry.name,
        ...(completionType(entry.kind) ? { type: completionType(entry.kind) } : {}),
        ...(entry.kindModifiers ? { detail: entry.kindModifiers } : {}),
        ...(
          entry.insertText && !entry.isSnippet
            ? { apply: entry.insertText }
            : {}
        ),
      })),
    }
  }

  hover(path: string, position: number): TypeScriptHoverResult | undefined {
    const info = this.languageService.getQuickInfoAtPosition(virtualPath(path), position)
    if (!info) return undefined
    return {
      from: info.textSpan.start,
      to: info.textSpan.start + info.textSpan.length,
      signature: ts.displayPartsToString(info.displayParts),
      documentation: ts.displayPartsToString(info.documentation),
    }
  }

  dispose(): void {
    this.languageService.dispose()
  }

  private hasFile(path: string): boolean {
    const normalized = virtualPath(path)
    return this.files.has(normalized) || this.libraries.has(libraryPath(path))
  }

  private readFile(path: string): string | undefined {
    const normalized = virtualPath(path)
    return this.files.get(normalized)?.content ?? this.libraries.get(libraryPath(path))
  }
}

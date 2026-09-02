import MagicString from 'magic-string'
import { decodeHTMLStrict } from 'entities'
import * as ts from 'typescript'
import type { Plugin } from 'vite'

export interface AdminLiteralCatalog {
  readonly [englishMessage: string]: string
}

export interface AdminMessageOccurrence {
  filePath: string
  line: number
  message: string
  kind: 'jsx-text' | 'jsx-attribute' | 'jsx-expression' | 'object-property' | 'call-argument' | 'default-value'
}

const LOCALIZE_IMPORT =
  "import { localizeAdminLiteral as __instaticAdminLocalize, formatAdminLiteral as __instaticAdminFormat } from '@admin/i18n/runtime'\n"

const USER_FACING_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'ariaLabel',
  'caption',
  'content',
  'description',
  'emptyLabel',
  'emptyMessage',
  'errorMessage',
  'eyebrow',
  'fallbackError',
  'helperText',
  'hint',
  'label',
  'meta',
  'placeholder',
  'subtitle',
  'sub',
  'successMessage',
  'title',
  'tooltip',
])

const USER_FACING_PROPERTIES = new Set([
  'aria-description',
  'aria-label',
  'actionLabel',
  'ariaLabel',
  'body',
  'cancelLabel',
  'caption',
  'cta',
  'desc',
  'confirmLabel',
  'description',
  'detail',
  'emptyLabel',
  'emptyMessage',
  'errorMessage',
  'fallbackError',
  'heading',
  'helperText',
  'hint',
  'label',
  'message',
  'placeholder',
  'submitLabel',
  'subtitle',
  'successMessage',
  'summary',
  'title',
  'tooltip',
  'valueLabel',
])

function isUserFacingAttribute(name: string): boolean {
  return USER_FACING_ATTRIBUTES.has(name) || /(?:Label|Title|Description|Tooltip|Placeholder|Message|Hint)$/.test(name)
}

function isUserFacingProperty(name: string): boolean {
  return USER_FACING_PROPERTIES.has(name) || /(?:Label|Title|Description|Tooltip|Placeholder|Message|Hint)$/.test(name)
}

const USER_MESSAGE_CALLS = new Set([
  'getErrorMessage',
  'setError',
  'setErrorMessage',
  'setMessage',
  'setStatus',
  'setStatusMessage',
])

const USER_FACING_NAME =
  /greeting|(?:ariaLabel|caption|cta|desc|description|label|message|placeholder|relative|status|text|title|tooltip|verb)$/i

interface LiteralMessage {
  message: string
  english: string
  expressions: string[]
}

interface Replacement {
  start: number
  end: number
  text: string
}

function scriptKind(filePath: string): ts.ScriptKind {
  return filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text
  }
  return null
}

function callName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

function declarationName(node: ts.BindingName | undefined): string | null {
  return node && ts.isIdentifier(node) ? node.text : null
}

function isUserFacingDeclaration(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node)) return USER_FACING_NAME.test(declarationName(node.name) ?? '')
  if (ts.isBindingElement(node) || ts.isParameter(node)) return isUserFacingAttribute(declarationName(node.name) ?? '')
  return ts.isFunctionDeclaration(node) && USER_FACING_NAME.test(node.name?.text ?? '')
}

function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/)
  let lastNonEmptyLine = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (/[^ \t]/.test(lines[index] ?? '')) lastNonEmptyLine = index
  }

  let result = ''
  for (let index = 0; index < lines.length; index += 1) {
    let line = (lines[index] ?? '').replace(/\t/g, ' ')
    if (index !== 0) line = line.replace(/^ +/, '')
    if (index !== lines.length - 1) line = line.replace(/ +$/, '')
    if (!line) continue
    if (index !== lastNonEmptyLine) line += ' '
    result += line
  }
  return decodeHTMLStrict(result)
}

function isCandidateMessage(message: string): boolean {
  const normalized = message.trim()
  if (!normalized || !/[A-Za-z]/.test(normalized)) return false
  if (/^(https?:|data:|\/|\.\/|\.\.\/|--|#[0-9a-f]{3,8}$)/i.test(normalized)) return false
  if (/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/.test(normalized)) return false
  return true
}

function literalMessage(
  node: ts.StringLiteralLike | ts.TemplateExpression,
  source: string,
): LiteralMessage | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    // JSX entities are decoded by the JSX compiler. A replacement JS string
    // must carry that decoded value; ordinary TS strings stay byte-for-byte.
    const english = ts.isJsxAttribute(node.parent) ? decodeHTMLStrict(node.text) : node.text
    if (!isCandidateMessage(english)) return null
    return { message: english.trim(), english, expressions: [] }
  }

  if (!ts.isTemplateExpression(node)) return null

  let message = node.head.text
  const expressions: string[] = []
  for (let index = 0; index < node.templateSpans.length; index += 1) {
    const span = node.templateSpans[index]
    if (!span) continue
    message += `{${index}}${span.literal.text}`
    expressions.push(source.slice(span.expression.getStart(), span.expression.end))
  }
  if (!isCandidateMessage(message)) return null
  return { message: message.trim(), english: message, expressions }
}

function translatedCall(literal: LiteralMessage, chinese: string): string {
  if (literal.expressions.length === 0) {
    return `__instaticAdminLocalize(${JSON.stringify(literal.english)}, ${JSON.stringify(chinese)})`
  }
  return `__instaticAdminFormat(${JSON.stringify(literal.english)}, ${JSON.stringify(chinese)}, [${literal.expressions.join(', ')}])`
}

function collectValueLiterals(
  node: ts.Node,
  source: string,
  catalog: AdminLiteralCatalog,
): Replacement[] {
  const replacements: Replacement[] = []

  function visit(current: ts.Node): void {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isTemplateExpression(current)
    ) {
      const literal = literalMessage(current, source)
      const chinese = literal && literal.message in catalog ? catalog[literal.message] : undefined
      if (literal && chinese !== undefined) {
        replacements.push({
          start: current.getStart(),
          end: current.end,
          text: translatedCall(literal, chinese),
        })
      }
      return
    }

    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      visit(current.expression)
      return
    }
    if (ts.isConditionalExpression(current)) {
      visit(current.whenTrue)
      visit(current.whenFalse)
      return
    }
    if (ts.isBinaryExpression(current)) {
      const token = current.operatorToken.kind
      if (
        token === ts.SyntaxKind.PlusToken ||
        token === ts.SyntaxKind.BarBarToken ||
        token === ts.SyntaxKind.QuestionQuestionToken ||
        token === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        visit(current.left)
        visit(current.right)
      }
      return
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) visit(element)
    }
  }

  visit(node)
  return replacements
}

function collectRenderableOccurrences(
  node: ts.Node,
  source: string,
  sourceFile: ts.SourceFile,
  filePath: string,
  kind: AdminMessageOccurrence['kind'],
  output: AdminMessageOccurrence[],
): void {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  ) {
    const literal = literalMessage(node, source)
    if (literal) output.push(occurrence(sourceFile, filePath, node, literal.message, kind))
    return
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    collectRenderableOccurrences(node.expression, source, sourceFile, filePath, kind, output)
    return
  }
  if (ts.isConditionalExpression(node)) {
    collectRenderableOccurrences(node.whenTrue, source, sourceFile, filePath, kind, output)
    collectRenderableOccurrences(node.whenFalse, source, sourceFile, filePath, kind, output)
    return
  }
  if (ts.isBinaryExpression(node)) {
    const token = node.operatorToken.kind
    if (
      token === ts.SyntaxKind.PlusToken ||
      token === ts.SyntaxKind.BarBarToken ||
      token === ts.SyntaxKind.QuestionQuestionToken ||
      token === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      collectRenderableOccurrences(node.left, source, sourceFile, filePath, kind, output)
      collectRenderableOccurrences(node.right, source, sourceFile, filePath, kind, output)
    }
    return
  }
}

function collectReturnOccurrences(
  body: ts.ConciseBody,
  source: string,
  sourceFile: ts.SourceFile,
  filePath: string,
  output: AdminMessageOccurrence[],
): void {
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression) {
      collectRenderableOccurrences(
        node.expression,
        source,
        sourceFile,
        filePath,
        'call-argument',
        output,
      )
      return
    }
    if (node !== body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return
    ts.forEachChild(node, visit)
  }

  if (ts.isBlock(body)) visit(body)
  else collectRenderableOccurrences(body, source, sourceFile, filePath, 'call-argument', output)
}

function collectReturnReplacements(
  body: ts.ConciseBody,
  source: string,
  catalog: AdminLiteralCatalog,
): Replacement[] {
  const replacements: Replacement[] = []
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node) && node.expression) {
      replacements.push(...collectValueLiterals(node.expression, source, catalog))
      return
    }
    if (node !== body && (ts.isFunctionLike(node) || ts.isClassLike(node))) return
    ts.forEachChild(node, visit)
  }

  if (ts.isBlock(body)) visit(body)
  else replacements.push(...collectValueLiterals(body, source, catalog))
  return replacements
}

function applyRelativeReplacements(
  source: string,
  start: number,
  end: number,
  replacements: readonly Replacement[],
): string {
  let output = source.slice(start, end)
  const descending = [...replacements].sort((left, right) => right.start - left.start)
  for (const replacement of descending) {
    const relativeStart = replacement.start - start
    const relativeEnd = replacement.end - start
    output = output.slice(0, relativeStart) + replacement.text + output.slice(relativeEnd)
  }
  return output
}

function occurrence(
  sourceFile: ts.SourceFile,
  filePath: string,
  node: ts.Node,
  message: string,
  kind: AdminMessageOccurrence['kind'],
): AdminMessageOccurrence {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { filePath, line: position.line + 1, message, kind }
}

export function extractAdminMessages(source: string, filePath: string): AdminMessageOccurrence[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  )
  const occurrences: AdminMessageOccurrence[] = []

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const message = cleanJsxText(node.getFullText(sourceFile)).trim()
      if (isCandidateMessage(message)) {
        occurrences.push(occurrence(sourceFile, filePath, node, message, 'jsx-text'))
      }
      return
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile)
      if (isUserFacingAttribute(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          const literal = literalMessage(node.initializer, source)
          if (literal) {
            occurrences.push(occurrence(sourceFile, filePath, node.initializer, literal.message, 'jsx-attribute'))
          }
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          collectRenderableOccurrences(
            node.initializer.expression,
            source,
            sourceFile,
            filePath,
            'jsx-attribute',
            occurrences,
          )
        }
      }
      if (node.initializer) visitNestedUiNodes(node.initializer)
      return
    }

    if (ts.isJsxExpression(node) && node.expression) {
      collectRenderableOccurrences(
        node.expression,
        source,
        sourceFile,
        filePath,
        'jsx-expression',
        occurrences,
      )
      visitNestedUiNodes(node.expression)
      return
    }

    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text
      if (name && USER_FACING_NAME.test(name) && node.body) {
        collectReturnOccurrences(node.body, source, sourceFile, filePath, occurrences)
        visitNestedUiNodes(node.body)
        return
      }
    }

    if (ts.isVariableDeclaration(node)) {
      const name = declarationName(node.name)
      if (name && USER_FACING_NAME.test(name) && node.initializer) {
        if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
          collectReturnOccurrences(
            node.initializer.body,
            source,
            sourceFile,
            filePath,
            occurrences,
          )
        } else {
          collectRenderableOccurrences(
            node.initializer,
            source,
            sourceFile,
            filePath,
            'call-argument',
            occurrences,
          )
        }
        visitNestedUiNodes(node.initializer)
        return
      }
    }

    if (ts.isBindingElement(node) || ts.isParameter(node)) {
      const name = declarationName(node.name)
      if (name && isUserFacingAttribute(name) && node.initializer) {
        collectRenderableOccurrences(node.initializer, source, sourceFile, filePath, 'default-value', occurrences)
        visitNestedUiNodes(node.initializer)
        return
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name && isUserFacingProperty(name)) {
        collectRenderableOccurrences(
          node.initializer,
          source,
          sourceFile,
          filePath,
          'object-property',
          occurrences,
        )
        return
      }
    }

    if (ts.isCallExpression(node)) {
      const name = callName(node.expression)
      if (name && USER_MESSAGE_CALLS.has(name)) {
        for (const argument of node.arguments) {
          collectRenderableOccurrences(
            argument,
            source,
            sourceFile,
            filePath,
            'call-argument',
            occurrences,
          )
        }
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  function visitNestedUiNodes(node: ts.Node): void {
    if (
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node) ||
      isUserFacingDeclaration(node) ||
      (ts.isPropertyAssignment(node) && isUserFacingProperty(propertyName(node.name) ?? ''))
    ) {
      visit(node)
      return
    }
    ts.forEachChild(node, visitNestedUiNodes)
  }

  visit(sourceFile)
  return occurrences
}

export function transformAdminMessages(
  source: string,
  filePath: string,
  catalog: AdminLiteralCatalog,
): { code: string; map: ReturnType<MagicString['generateMap']> } | null {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  )
  const output = new MagicString(source)
  let replacementCount = 0

  function replace(start: number, end: number, text: string): void {
    output.overwrite(start, end, text)
    replacementCount += 1
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      const english = cleanJsxText(node.getFullText(sourceFile))
      const message = english.trim()
      const chinese = message in catalog ? catalog[message] : undefined
      if (chinese !== undefined) replace(node.getFullStart(), node.end, `{${translatedCall({ message, english, expressions: [] }, chinese)}}`)
      return
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile)
      if (isUserFacingAttribute(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          const literal = literalMessage(node.initializer, source)
          const chinese = literal && literal.message in catalog ? catalog[literal.message] : undefined
          if (literal && chinese !== undefined) {
            replace(node.initializer.getStart(), node.initializer.end, `{${translatedCall(literal, chinese)}}`)
          }
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const replacements = collectValueLiterals(node.initializer.expression, source, catalog)
          for (const replacement of replacements) {
            replace(replacement.start, replacement.end, replacement.text)
          }
        }
      }
      if (node.initializer) visitNestedUiNodes(node.initializer)
      return
    }

    if (ts.isJsxExpression(node) && node.expression) {
      const replacements = collectValueLiterals(node.expression, source, catalog)
      for (const replacement of replacements) {
        replace(replacement.start, replacement.end, replacement.text)
      }
      visitNestedUiNodes(node.expression)
      return
    }

    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text
      if (name && USER_FACING_NAME.test(name) && node.body) {
        for (const replacement of collectReturnReplacements(node.body, source, catalog)) {
          replace(replacement.start, replacement.end, replacement.text)
        }
        visitNestedUiNodes(node.body)
        return
      }
    }

    if (ts.isVariableDeclaration(node)) {
      const name = declarationName(node.name)
      if (name && USER_FACING_NAME.test(name) && node.initializer) {
        const replacements =
          ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)
            ? collectReturnReplacements(node.initializer.body, source, catalog)
            : collectValueLiterals(node.initializer, source, catalog)
        for (const replacement of replacements) {
          replace(replacement.start, replacement.end, replacement.text)
        }
        visitNestedUiNodes(node.initializer)
        return
      }
    }

    if (ts.isBindingElement(node) || ts.isParameter(node)) {
      const name = declarationName(node.name)
      if (name && isUserFacingAttribute(name) && node.initializer) {
        for (const replacement of collectValueLiterals(node.initializer, source, catalog)) {
          replace(replacement.start, replacement.end, replacement.text)
        }
        visitNestedUiNodes(node.initializer)
        return
      }
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name && isUserFacingProperty(name)) {
        const replacements = collectValueLiterals(node.initializer, source, catalog)
        if (replacements.length > 0) {
          const initializer = applyRelativeReplacements(
            source,
            node.initializer.getStart(),
            node.initializer.end,
            replacements,
          )
          const propertySource = source.slice(node.name.getStart(), node.name.end)
          replace(node.getStart(), node.end, `get ${propertySource}() { return ${initializer} }`)
        }
        return
      }
    }

    if (ts.isCallExpression(node)) {
      const name = callName(node.expression)
      if (name && USER_MESSAGE_CALLS.has(name)) {
        for (const argument of node.arguments) {
          const replacements = collectValueLiterals(argument, source, catalog)
          for (const replacement of replacements) {
            replace(replacement.start, replacement.end, replacement.text)
          }
        }
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  function visitNestedUiNodes(node: ts.Node): void {
    if (
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node) ||
      isUserFacingDeclaration(node) ||
      (ts.isPropertyAssignment(node) && isUserFacingProperty(propertyName(node.name) ?? ''))
    ) {
      visit(node)
      return
    }
    ts.forEachChild(node, visitNestedUiNodes)
  }

  visit(sourceFile)
  if (replacementCount === 0) return null

  output.prepend(LOCALIZE_IMPORT)
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: filePath, includeContent: true }),
  }
}

function isAdminSource(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return (
    normalized.includes('/src/admin/') &&
    (normalized.endsWith('.ts') || normalized.endsWith('.tsx')) &&
    !normalized.includes('/src/admin/i18n/') &&
    !normalized.includes('/__tests__/')
  )
}

export function adminI18nPlugin(catalog: AdminLiteralCatalog): Plugin {
  return {
    name: 'instatic-admin-i18n',
    enforce: 'pre',
    transform(source, rawId) {
      const filePath = rawId.split('?')[0] ?? rawId
      if (!isAdminSource(filePath)) return null
      return transformAdminMessages(source, filePath, catalog)
    },
  }
}

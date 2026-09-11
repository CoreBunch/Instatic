import { Type, type Static } from '@sinclair/typebox'

export const TypeScriptProjectFileSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
})

export type TypeScriptProjectFile = Static<typeof TypeScriptProjectFileSchema>

const TypeScriptDiagnosticSeveritySchema = Type.Union([
  Type.Literal('error'),
  Type.Literal('warning'),
  Type.Literal('info'),
])

export const TypeScriptEditorDiagnosticSchema = Type.Object({
  code: Type.Number(),
  severity: TypeScriptDiagnosticSeveritySchema,
  message: Type.String(),
  from: Type.Number(),
  to: Type.Number(),
  line: Type.Number(),
  column: Type.Number(),
})

export type TypeScriptEditorDiagnostic = Static<typeof TypeScriptEditorDiagnosticSchema>

const TypeScriptCompletionOptionSchema = Type.Object({
  label: Type.String(),
  type: Type.Optional(Type.String()),
  detail: Type.Optional(Type.String()),
  apply: Type.Optional(Type.String()),
})

const TypeScriptCompletionResultSchema = Type.Object({
  from: Type.Number(),
  to: Type.Number(),
  options: Type.Array(TypeScriptCompletionOptionSchema),
})

export type TypeScriptCompletionResult = Static<typeof TypeScriptCompletionResultSchema>

const TypeScriptHoverResultSchema = Type.Object({
  from: Type.Number(),
  to: Type.Number(),
  signature: Type.String(),
  documentation: Type.String(),
})

export type TypeScriptHoverResult = Static<typeof TypeScriptHoverResultSchema>

export const TypeScriptWorkerRequestSchema = Type.Union([
  Type.Object({
    type: Type.Literal('sync'),
    files: Type.Array(TypeScriptProjectFileSchema),
  }),
  Type.Object({
    type: Type.Literal('update'),
    path: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('diagnostics'),
    requestId: Type.String(),
    path: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('completions'),
    requestId: Type.String(),
    path: Type.String(),
    position: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('hover'),
    requestId: Type.String(),
    path: Type.String(),
    position: Type.Number(),
  }),
])

export type TypeScriptWorkerRequest = Static<typeof TypeScriptWorkerRequestSchema>

export const TypeScriptWorkerResponseSchema = Type.Union([
  Type.Object({
    type: Type.Literal('diagnostics'),
    requestId: Type.String(),
    diagnostics: Type.Array(TypeScriptEditorDiagnosticSchema),
  }),
  Type.Object({
    type: Type.Literal('completions'),
    requestId: Type.String(),
    result: Type.Optional(TypeScriptCompletionResultSchema),
  }),
  Type.Object({
    type: Type.Literal('hover'),
    requestId: Type.String(),
    result: Type.Optional(TypeScriptHoverResultSchema),
  }),
  Type.Object({
    type: Type.Literal('error'),
    requestId: Type.String(),
    message: Type.String(),
  }),
])

export type TypeScriptWorkerResponse = Static<typeof TypeScriptWorkerResponseSchema>

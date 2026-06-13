/**
 * Tool registry types — small helpers on top of the canonical `AiTool` type
 * from `runtime/types.ts`. Defined here so per-scope tool modules can import
 * a single concise type without reaching into the runtime layer.
 */

export type { AiTool,   ToolScope } from '../runtime/types'

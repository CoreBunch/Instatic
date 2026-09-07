import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool } from './types'

/** Scope-wide language precondition, stripped before the browser's per-tool parser. */
export function withBrowserLocaleContext(tool: AiTool): AiTool {
  if (tool.execution !== 'browser') return tool
  return {
    ...tool,
    description: `${tool.description} Operates in the workspace's selected language. Pass localeId to guard against editing another language; use ${tool.scope}_select_locale to switch.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        localeId: Type.Optional(Type.String({ minLength: 1, description: 'Expected active locale id. A mismatch refuses the operation.' })),
      },
    },
  }
}

export function selectLocaleTool(scope: 'site' | 'content'): AiTool {
  return {
    name: `${scope}_select_locale`, scope, execution: 'browser', mutates: false,
    requiredCapabilities: scope === 'site' ? ['site.read'] : ['content.manage', 'content.create', 'content.edit.own', 'content.edit.any'],
    description: 'Switch the open workspace to a configured language before reading or editing its content. Does not publish anything.',
    inputSchema: Type.Object({ localeId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  }
}

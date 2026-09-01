export const PLUGIN_CSP_DIRECTIVE_VALUES = [
  'script-src',
  'connect-src',
  'img-src',
  'frame-src',
] as const

export type PluginCspDirective = typeof PLUGIN_CSP_DIRECTIVE_VALUES[number]

/** Host-owned declaration: records in this resource add site-wide CSP sources. */
export interface PluginPublisherDeclarations {
  csp: {
    resource: string
  }
}

/** Validated record shape consumed by the publisher pipeline. */
export interface PluginCspContribution {
  directive: PluginCspDirective
  origin: string
  enabled: boolean
  description?: string
}

export type ProviderId =
  | 'anthropic'
  | 'claude-code'
  | 'openai'
  | 'openrouter'
  | 'ollama'
  | 'openai-compatible'
export type ProviderAuthMode = 'apiKey' | 'baseUrl'

export interface ProviderSpec {
  id: ProviderId
  label: string
  shortLabel: string
  description: string
  authMode: ProviderAuthMode
  endpointLabel: string
  /**
   * The provider authenticates by some means outside Instatic, so the connect
   * form collects no secret at all. The credential row still exists (a
   * conversation must reference one) but carries only the inert sentinel below.
   */
  credentialLess?: boolean
  /**
   * Shown in place of the credential fields when `credentialLess` — it has to
   * explain where the auth actually comes from, since the form asks for nothing.
   */
  credentialLessHint?: string
  /**
   * Stored as the credential's `baseUrl` when `credentialLess`. Never dialed —
   * it exists only so the row satisfies the API's auth-shape check.
   */
  sentinelBaseUrl?: string
}

export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    shortLabel: 'Claude models',
    description: 'Claude models with strong tool use and long-context reasoning.',
    authMode: 'apiKey',
    endpointLabel: 'api.anthropic.com',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    shortLabel: 'Your Claude subscription',
    description:
      'Run the agent on this server’s Claude subscription instead of metered API credits.',
    authMode: 'baseUrl',
    endpointLabel: 'Local Claude Code CLI',
    credentialLess: true,
    credentialLessHint:
      'Claude Code runs on the Claude subscription this server is signed in to — no API key, '
      + 'and no metered API credits. Make sure the `claude` CLI is installed and signed in on the server.',
    sentinelBaseUrl: 'claude-code://local',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    shortLabel: 'GPT models',
    description: 'General-purpose language and multimodal models from OpenAI.',
    authMode: 'apiKey',
    endpointLabel: 'api.openai.com',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    shortLabel: 'Multi-provider models',
    description: 'Route requests to models from multiple providers through one API.',
    authMode: 'apiKey',
    endpointLabel: 'openrouter.ai',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    shortLabel: 'Local models',
    description: 'Run local models on infrastructure you control.',
    authMode: 'baseUrl',
    endpointLabel: 'Local endpoint',
  },
  {
    id: 'openai-compatible',
    label: 'Custom endpoint',
    shortLabel: 'OpenAI-compatible API',
    description: 'Connect any OpenAI-compatible API endpoint.',
    authMode: 'baseUrl',
    endpointLabel: 'Custom endpoint',
  },
]

export function getProviderSpec(providerId: ProviderId): ProviderSpec {
  const spec = PROVIDER_SPECS.find((provider) => provider.id === providerId)
  if (!spec) throw new Error(`Unknown AI provider: ${providerId}`)
  return spec
}

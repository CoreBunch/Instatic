export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'openai-compatible'
export type ProviderAuthMode = 'apiKey' | 'baseUrl'

export interface ProviderSpec {
  id: ProviderId
  label: string
  shortLabel: string
  description: string
  authMode: ProviderAuthMode
  endpointLabel: string
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

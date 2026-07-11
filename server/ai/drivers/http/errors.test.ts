import { describe, expect, it } from 'bun:test'
import { classifyHttpError, classifyHttpFailure } from './errors'

describe('classifyHttpError', () => {
  it('turns provider request limits into a recoverable conversation action', () => {
    expect(classifyHttpError('Anthropic', 413, '')).toBe(
      "Anthropic could not accept this conversation because it exceeds the provider's request or context limit. Your history is still saved; start a new conversation or choose a model with a larger context window.",
    )
    expect(classifyHttpError(
      'OpenRouter',
      400,
      JSON.stringify({ error: { message: 'maximum context length exceeded' } }),
    )).toContain('Your history is still saved; start a new conversation')
    expect(classifyHttpFailure(
      'OpenRouter',
      400,
      JSON.stringify({ error: { code: 'too_many_images', message: 'Bad request' } }),
    ).kind).toBe('replayOverflow')
  })

  it('does not relabel unrelated bad requests as context exhaustion', () => {
    expect(classifyHttpError(
      'OpenAI',
      400,
      JSON.stringify({ error: { message: 'Invalid tool schema' } }),
    )).toBe('OpenAI error (400): Invalid tool schema.')
  })
})

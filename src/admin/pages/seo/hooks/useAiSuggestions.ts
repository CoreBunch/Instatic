/**
 * useAiSuggestions — state machine behind the ✨ metadata suggestions:
 * generate / more (exclude-aware regenerate) / pick / reject against
 * `POST /admin/api/cms/seo/generate`. Picking fills the input through the
 * normal dirty/save flow — nothing auto-saves.
 *
 * Rendered by the `AiSuggestionSparkle` trigger (label cell) and
 * `AiSuggestionResults` (error + bubbles under the input) in
 * `components/AiSuggestionBubbles.tsx`.
 */
import { useState } from 'react'
import { getErrorMessage } from '@core/utils/errorMessage'
import { generateSeoSuggestions, type SeoTarget } from '../lib/seoApi'
import type { SeoDraftField } from './useSeoDraft'

export interface AiSuggestions {
  field: SeoDraftField
  suggestions: string[] | null
  loading: boolean
  error: string | null
  generate: () => void
  more: () => void
  pick: (suggestion: string) => void
  reject: () => void
}

export function useAiSuggestions(
  target: SeoTarget,
  field: SeoDraftField,
  onPick: (suggestion: string) => void,
): AiSuggestions {
  const [suggestions, setSuggestions] = useState<string[] | null>(null)
  const [seen, setSeen] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate(exclude: string[]): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const next = await generateSeoSuggestions(target.kind, target.id, field, exclude)
      setSuggestions(next)
      setSeen([...exclude, ...next])
    } catch (err) {
      console.error('[seo-page] suggestion generation failed:', err)
      setError(getErrorMessage(err, 'Could not generate suggestions'))
    } finally {
      setLoading(false)
    }
  }

  return {
    field,
    suggestions,
    loading,
    error,
    generate: () => void generate([]),
    more: () => void generate(seen),
    pick: (suggestion) => {
      onPick(suggestion)
      setSuggestions(null)
    },
    reject: () => {
      setSuggestions(null)
      setError(null)
    },
  }
}

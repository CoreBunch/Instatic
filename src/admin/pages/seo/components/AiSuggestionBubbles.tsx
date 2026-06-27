/**
 * AI metadata suggestions — the ✨ action on metadata inputs.
 *
 * Split to fit the editor's two-column field grid (state machine in
 * `hooks/useAiSuggestions.ts`):
 *   - `AiSuggestionSparkle` is the trigger button riding the label cell.
 *   - `AiSuggestionResults` renders the error line and the tappable
 *     suggestion bubbles UNDER the input, in the control column.
 *
 * Gating: requires `ai.chat` — without it the sparkle renders disabled with
 * an inline reason (never available-then-blocked). Provider-not-configured
 * surfaces as an inline error with a pointer to the AI workspace, matching
 * the AgentPanel's handling.
 */
import { Button } from '@ui/components/Button'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import type { AiSuggestions } from '../hooks/useAiSuggestions'
import styles from './AiSuggestionBubbles.module.css'

/** The trigger — rides the label cell next to the field label. */
export function AiSuggestionSparkle({ ai, canManage }: { ai: AiSuggestions; canManage: boolean }) {
  const currentUser = useCurrentAdminUser()
  const unrestricted = !currentUser
  const canChat = unrestricted || hasCapability(currentUser, 'ai.chat')

  const disabledReason = !canManage
    ? 'Your role does not include Manage SEO'
    : !canChat
      ? 'Your role does not include Use AI chat'
      : undefined

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={disabledReason !== undefined || ai.loading}
      tooltip={disabledReason ?? 'Generate suggestions with AI'}
      aria-label={`Generate ${ai.field} suggestions with AI`}
      onClick={ai.generate}
      data-testid={`seo-sparkle-${ai.field}`}
    >
      <AiBoxSolidIcon size={13} aria-hidden="true" />
      {ai.loading && <span className={styles.loadingText}>Generating…</span>}
    </Button>
  )
}

/** Error line + suggestion bubbles — renders under the input. */
export function AiSuggestionResults({ ai }: { ai: AiSuggestions }) {
  return (
    <>
      {ai.error && <p className={styles.error} role="alert">{ai.error}</p>}

      {ai.suggestions !== null && ai.suggestions.length > 0 && (
        <div className={styles.bubbles} role="group" aria-label="AI suggestions">
          {ai.suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              type="button"
              variant="secondary"
              size="xs"
              className={styles.bubble}
              onClick={() => ai.pick(suggestion)}
            >
              {suggestion}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={styles.bubbleAction}
            disabled={ai.loading}
            onClick={ai.more}
            data-testid={`seo-sparkle-${ai.field}-more`}
          >
            More options
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={styles.bubbleAction}
            onClick={ai.reject}
            data-testid={`seo-sparkle-${ai.field}-reject`}
          >
            Reject
          </Button>
        </div>
      )}
    </>
  )
}

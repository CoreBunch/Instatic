/**
 * MessageReasoning — the reasoning/thinking affordance for one assistant turn.
 *
 * While a reasoning model streams its chain-of-thought with no answer yet, this
 * shows a live "Thinking…" indicator. Once the answer arrives (or the stream
 * ends), it becomes a collapsed-by-default expander revealing the captured
 * reasoning. The reasoning is ephemeral (session-only) — never persisted, so
 * rehydrated past turns render nothing here.
 */

import { useState } from 'react'
import { Button } from '@ui/components/Button'
import styles from './AgentPanel.module.css'

interface MessageReasoningProps {
  /** True while this assistant turn has streamed reasoning but no answer yet. */
  isThinking: boolean
  /** Accumulated ephemeral reasoning text for the turn, if any. */
  reasoning?: string
}

export function MessageReasoning({ isThinking, reasoning }: MessageReasoningProps) {
  const [open, setOpen] = useState(false)

  if (isThinking) {
    return (
      <div className={styles.thinkingIndicator} role="status">
        <span className={styles.thinkingDot} aria-hidden="true" />
        Thinking…
      </div>
    )
  }

  if (!reasoning) return null

  return (
    <div className={styles.reasoningDisclosure}>
      <Button variant="ghost" size="micro" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Hide reasoning' : 'Show reasoning'}
      </Button>
      {open && <div className={styles.reasoningContent}>{reasoning}</div>}
    </div>
  )
}

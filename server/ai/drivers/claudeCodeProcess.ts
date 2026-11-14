/**
 * One spawn of the `claude` CLI, and every way it can fail.
 *
 * Isolated from the driver because a subprocess has far more failure modes than
 * an HTTP call, and all of them used to look identical from the composer: a few
 * seconds of output, then nothing, forever. Everything here exists to turn one
 * of those silences into a named, terminal outcome — see `AttemptOutcome`.
 */

import type { AiStreamEvent } from '../runtime/types'
import { createTranslateState, translateLine } from './claudeCodeEvents'

// ---------------------------------------------------------------------------

export type SessionMode = 'start' | 'resume'

export interface AttemptOutcome {
  mode: SessionMode
  /** Terminal message for the chat, or null when the turn ended cleanly. */
  error: string | null
  /** Set when the turn failed in a way a different session mode would fix. */
  retryAs?: SessionMode
  retryReason?: string
}

/**
 * How long the CLI may emit NOTHING before we treat the turn as wedged. It
 * reports progress continuously while working — token-by-token deltas, a
 * `system/thinking_tokens` tick while reasoning, tool traffic — so a gap this
 * long means no output is coming, not that the model is busy. Without this a
 * stuck child hangs the chat forever: the generator simply never yields again
 * and the composer sits there with no error and no `done`.
 */
const IDLE_TIMEOUT_MS = Number(process.env.INSTATIC_CLAUDE_IDLE_TIMEOUT_MS ?? 180_000)

/** Keep the tail of stderr for diagnostics without unbounded retention. */
const STDERR_CAP = 4_000

export async function* runClaudeAttempt(
  baseCmd: string[],
  mode: SessionMode,
  sessionUuid: string,
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): AsyncGenerator<AiStreamEvent, AttemptOutcome> {
  const cmd = [
    ...baseCmd,
    ...(mode === 'start' ? ['--session-id', sessionUuid] : ['--resume', sessionUuid]),
  ]

  const proc = Bun.spawn(cmd, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  // SIGTERM, then SIGKILL if it doesn't go. A CLI that ignores the first signal
  // would otherwise keep `proc.exited` pending and wedge the turn anyway.
  let killTimer: ReturnType<typeof setTimeout> | null = null
  const kill = () => {
    try { proc.kill() } catch { /* already gone */ }
    if (killTimer) return
    killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
  }
  const onAbort = () => kill()
  signal.addEventListener('abort', onAbort, { once: true })

  // Drain stderr CONCURRENTLY. Reading it only after exit (or not at all) lets a
  // chatty child fill the ~64KB pipe buffer and block forever on write — stdout
  // then goes quiet with no error, which is indistinguishable from a hang.
  let stderrText = ''
  const stderrDone = (async () => {
    try {
      const dec = new TextDecoder()
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        stderrText = (stderrText + dec.decode(chunk, { stream: true })).slice(-STDERR_CAP)
      }
    } catch { /* pipe torn down with the process */ }
  })()

  const state = createTranslateState()

  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleTimedOut = true; kill() }, IDLE_TIMEOUT_MS)
  }

  let emitted = 0
  let drained = false
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    touch()
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      touch()
      buffer += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        for (const event of translateLine(line, state)) { emitted += 1; yield event }
        // Fail fast on a toolless turn: the model cannot do anything useful and
        // will bluff a tool call in prose, so stop before spending the turn.
        if (state.sawInit && state.mcpToolCount === 0) { kill(); break }
      }
      if (state.sawInit && state.mcpToolCount === 0) break
    }
    if (buffer.trim() && !(state.sawInit && state.mcpToolCount === 0)) {
      for (const event of translateLine(buffer, state)) { emitted += 1; yield event }
    }
    drained = true
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal.removeEventListener('abort', onAbort)
    // Abandoned before stdout ran out — the consumer stopped iterating (closed
    // tab, handler teardown) and nothing else will ever reap this child, so the
    // abort listener we just dropped can't do it either.
    if (!drained) kill()
  }

  const code = await proc.exited
  await stderrDone
  if (killTimer) clearTimeout(killTimer)
  const stderr = stderrText.trim()

  if (state.unparseableLines > 0) {
    console.warn(
      `[ai/claude-code] skipped ${state.unparseableLines} unreadable output line(s) — CLI output format may have changed.`,
    )
  }

  // --- terminal classification -------------------------------------------
  if (signal.aborted) return { mode, error: null } // user cancelled; runner handles it

  if (idleTimedOut) {
    console.error(`[ai/claude-code] no output for ${IDLE_TIMEOUT_MS}ms — killed. stderr tail: ${stderr.slice(-400)}`)
    return {
      mode,
      error: `Claude Code stopped responding (no output for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s) and was stopped. Your message is saved — send it again to retry.`,
    }
  }

  if (state.sawInit && state.mcpToolCount === 0) {
    console.error(
      `[ai/claude-code] CLI exposed no mcp__instatic__* tools ` +
      `(mcp server status: ${state.mcpServerStatus ?? 'unreported'}). stderr tail: ${stderr.slice(-400)}`,
    )
    // The CLI tells us which of the two causes it was, so say so rather than
    // offering the operator a choice of theories.
    const cause = state.mcpServerStatus === 'failed'
      ? "the CMS tool server (`instatic`) failed to start, so the CLI had nothing to call — its access token may have been revoked."
      : 'the CLI did not expose them — most likely its tool-search feature hid the toolset behind a built-in that this integration strips.'
    return {
      mode,
      error: `Claude Code started with none of the CMS tools available, so it could not act on the site: ${cause}` +
        `${stderr ? ` CLI said: ${stderr.slice(-300)}` : ''}`,
    }
  }

  if (state.rateLimitMessage) return { mode, error: state.rateLimitMessage }

  if (code !== 0 && emitted === 0) {
    // Nothing reached the user yet, so a different session mode can still be
    // tried cleanly. Match on the CLI's own wording for the two recoverable cases.
    if (mode === 'resume' && /no conversation found/i.test(stderr)) {
      return { mode, error: null, retryAs: 'start', retryReason: 'session not on disk' }
    }
    if (mode === 'start' && /already in use/i.test(stderr)) {
      return { mode, error: null, retryAs: 'resume', retryReason: 'session already exists' }
    }
  }

  if (state.resultErrorMessage) {
    console.error(`[ai/claude-code] ${state.resultErrorMessage} stderr tail: ${stderr.slice(-400)}`)
    return {
      mode,
      error: `${state.resultErrorMessage}${stderr ? ` CLI said: ${stderr.slice(-300)}` : ''}`,
    }
  }

  if (!state.resultSeen && code !== 0) {
    console.error(`[ai/claude-code] exited ${code}. stderr tail: ${stderr.slice(-400)}`)
    return {
      mode,
      error: `Claude Code exited ${code}${stderr ? `: ${stderr.slice(-500)}` : ''}. Is \`claude\` installed and signed in on the server?`,
    }
  }

  // Turn ended `success` without calling a single tool AND without saying
  // anything — the other shape of a silent no-op turn.
  if (state.resultSeen && emitted === 0) {
    console.error(`[ai/claude-code] turn produced no output at all (exit ${code}). stderr tail: ${stderr.slice(-400)}`)
    return { mode, error: 'Claude Code finished without producing a reply. Send your message again to retry.' }
  }

  return { mode, error: null }
}

// ---------------------------------------------------------------------------

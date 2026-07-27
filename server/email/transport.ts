/**
 * Email transport seam — a single process-wide singleton the visitor-auth
 * `/forgot` flow (and, later, any other outbound mail) hands a message to.
 *
 * The default is `ConsoleEmailTransport`, which logs the message (reset link
 * included) to stdout. That is enough to run the reset flow end-to-end in dev
 * and in a self-hosted install without an external mail provider — the
 * operator can copy the logged link directly.
 *
 * A real transport (SMTP / Resend / Postmark / SES) is a follow-up: wire it
 * at boot via `configureEmailTransport(new SmtpTransport(...))`. No caller
 * under `server/visitor-auth/` reaches past this seam, so swapping the
 * transport never touches the visitor-auth code.
 *
 * The interface is intentionally minimal (a single `send`): no queue, no
 * retries, no templates. The visitor-auth handler owns the subject/body; the
 * transport owns delivery. A `send` rejection is the transport's problem to
 * surface — callers log the failure and continue (never exposing it to the
 * client; see the `/forgot` handler).
 */

/** The payload a caller hands to a transport. */
export interface SendEmailInput {
  to: string
  subject: string
  text: string
  /** Optional HTML body. Transports that can't render HTML fall back to `text`. */
  html?: string
}

/**
 * Minimal transport contract. `name` is surfaced in logs so an operator can
 * confirm which transport is active without reading boot code.
 */
export interface EmailTransport {
  readonly name: string
  send(input: SendEmailInput): Promise<void>
}

/**
 * Default transport — logs the message to stdout. The reset link (or any
 * other URL embedded in `text`) is printed verbatim so a dev/operator can
 * copy/paste it. No network, no config — it always works.
 */
export class ConsoleEmailTransport implements EmailTransport {
  readonly name = 'console'

  async send(input: SendEmailInput): Promise<void> {
    // One block, newline-separated, prefixed with the recipient so it's
    // greppable in a shared log stream.
    console.log(
      `[email:${input.to}] ${input.subject}\n${input.text}` +
        (input.html ? `\n[html] ${input.html}` : ''),
    )
  }
}

let activeTransport: EmailTransport = new ConsoleEmailTransport()

/** The active transport — visitors-auth `/forgot` reads through this. */
export function getEmailTransport(): EmailTransport {
  return activeTransport
}

/**
 * Replace the active transport. Intended for boot-time wiring of a real
 * transport (SMTP / Resend / Postmark / SES) and for tests that want to
 * capture sent messages. Not concurrency-guarded — set once at boot.
 */
export function configureEmailTransport(transport: EmailTransport): void {
  activeTransport = transport
}

/**
 * Rate limits for the public member endpoints. In-memory sliding windows
 * (one Bun process serves the site), keyed per IP, per IP+email, per email
 * and per member.
 *
 * There is deliberately no hard account lock: anyone who knows a member's
 * address could lock them out. The per-email and per-member windows slow a
 * distributed guesser instead, and reset and sign-in links keep working.
 */
import { RateLimiter } from '../auth/rateLimit'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

export const memberLimits = {
  /** Sign-in attempts from one address against one email. */
  loginPerIpEmail: new RateLimiter({ limit: 5, windowMs: 15 * MINUTE }),
  /** Sign-in attempts from one address, any email. */
  loginPerIp: new RateLimiter({ limit: 30, windowMs: 10 * MINUTE }),
  /** Sign-in attempts against one email from anywhere. */
  loginPerEmail: new RateLimiter({ limit: 20, windowMs: HOUR }),
  /** New accounts from one address. */
  signupPerIp: new RateLimiter({ limit: 10, windowMs: HOUR }),
  /** Actions that send an email, from one address. */
  mailPerIp: new RateLimiter({ limit: 10, windowMs: HOUR }),
  /** Emails sent to one recipient, so nobody's inbox can be flooded. */
  mailPerRecipient: new RateLimiter({ limit: 4, windowMs: HOUR }),
  /** Link-token submissions from one address. */
  tokenPerIp: new RateLimiter({ limit: 30, windowMs: 10 * MINUTE }),
  /** Current-password checks for a signed-in member. */
  reauthPerMember: new RateLimiter({ limit: 8, windowMs: 15 * MINUTE }),
}

/** Test seam: forget every recorded attempt. */
export function resetMemberLimits(): void {
  for (const limiter of Object.values(memberLimits)) limiter.clear()
}

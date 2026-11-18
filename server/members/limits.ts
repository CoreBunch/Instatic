/**
 * Rate limits for the public member endpoints. In-memory sliding windows
 * (one Bun process serves the site), keyed per IP, per IP+email, per email
 * and per member.
 *
 * There is deliberately no hard account lock: anyone who knows a member's
 * address could lock them out. The per-email windows slow a distributed
 * guesser instead. A member whose limits a stranger has used up always has
 * a way in: the last sign-in or reset link sent is still in their inbox and
 * still valid, because a refused request issues no new token.
 */
import { RateLimiter } from '../auth/rateLimit'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

export const memberLimits = {
  /** Sign-in attempts from one address against one email. */
  loginPerIpEmail: new RateLimiter({ limit: 5, windowMs: 15 * MINUTE }),
  /** Sign-in attempts from one address, any email. */
  loginPerIp: new RateLimiter({ limit: 30, windowMs: 10 * MINUTE }),
  /** Failed sign-in attempts against one email from anywhere. */
  loginPerEmail: new RateLimiter({ limit: 20, windowMs: HOUR }),
  /**
   * Once `loginPerEmail` is used up: a few more attempts, only from addresses
   * that have not tried this email before. It keeps a stranger who ran the
   * limit out from locking the owner out of their password, while capping
   * what a guesser with many addresses gains at this many extra tries.
   */
  loginPerEmailFromNewAddress: new RateLimiter({ limit: 5, windowMs: HOUR }),
  /** New accounts from one address. */
  signupPerIp: new RateLimiter({ limit: 10, windowMs: HOUR }),
  /** Actions that send an email, from one address. */
  mailPerIp: new RateLimiter({ limit: 10, windowMs: HOUR }),
  /** Emails of one kind sent to one recipient. */
  mailPerRecipientKind: new RateLimiter({ limit: 4, windowMs: HOUR }),
  /** Emails of every kind sent to one recipient, so nobody's inbox can be flooded. */
  mailPerRecipient: new RateLimiter({ limit: 8, windowMs: HOUR }),
  /** Link-token submissions from one address. */
  tokenPerIp: new RateLimiter({ limit: 30, windowMs: 10 * MINUTE }),
  /** Current-password checks for a signed-in member. */
  reauthPerMember: new RateLimiter({ limit: 8, windowMs: 15 * MINUTE }),
}

/** Test seam: forget every recorded attempt. */
export function resetMemberLimits(): void {
  for (const limiter of Object.values(memberLimits)) limiter.clear()
}

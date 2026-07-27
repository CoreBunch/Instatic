/**
 * In-memory rate limiters for the visitor-auth surface.
 *
 * Mirrors the admin auth surface (`server/auth/rateLimit.ts`): one
 * `RateLimiter` singleton per concern, keyed by IP or by `(ip, email)` /
 * email. The visitor surface is a separate process-wide set so visitor
 * traffic cannot consume the admin buckets and vice-versa.
 *
 *   visitorLoginRateLimit          5 / 15min per (ip, email)
 *   visitorLoginPerIpRateLimit    30 / 10min per ip
 *   visitorRegisterPerIpRateLimit  3 / 60min per ip
 *   visitorForgotPerIpRateLimit    3 / 60min per ip
 *   visitorForgotPerEmailRateLimit 1 / 15min per email
 *
 * The limits are intentionally tight on registration / forgot (high abuse
 * surface, low legitimate volume) and looser on login (real users mistype
 * passwords). See `docs/PRD.md` §4.4.
 */
import { RateLimiter } from '../auth/rateLimit'

/** Per-(ip, email) tuple — defends a single visitor account across many IPs. */
export const visitorLoginRateLimit = new RateLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
})

/** Per-IP — blanket cap so one attacker IP cannot grind many accounts. */
export const visitorLoginPerIpRateLimit = new RateLimiter({
  limit: 30,
  windowMs: 10 * 60 * 1000,
})

/** Per-IP registration — throttles throwaway-account farming. */
export const visitorRegisterPerIpRateLimit = new RateLimiter({
  limit: 3,
  windowMs: 60 * 60 * 1000,
})

/** Per-IP forgot-password — throttles email enumeration via reset floods. */
export const visitorForgotPerIpRateLimit = new RateLimiter({
  limit: 3,
  windowMs: 60 * 60 * 1000,
})

/** Per-email forgot-password — caps reset-mail volume to a single address. */
export const visitorForgotPerEmailRateLimit = new RateLimiter({
  limit: 1,
  windowMs: 15 * 60 * 1000,
})

import { RateLimiter } from '../../../auth/rateLimit'

export const oauthRegistrationRateLimit = new RateLimiter({
  limit: 30,
  windowMs: 60 * 60 * 1000,
})

export const oauthTokenRateLimit = new RateLimiter({
  limit: 60,
  windowMs: 10 * 60 * 1000,
})

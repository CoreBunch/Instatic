/**
 * AI crawler user-agent lists — the bots the Robots.txt tab's two toggles
 * control. These lists churn as the AI ecosystem evolves; this constant is
 * the ONE place to update them. Rendered as per-agent `Disallow: /` blocks
 * by `generateRobotsTxt` when the corresponding group is blocked.
 *
 * Training crawlers ingest content for model training; answer crawlers fetch
 * content to ground live answers (AI search). Operators commonly want to
 * block the former while staying visible to the latter, so the toggles are
 * separate.
 */

export const AI_TRAINING_CRAWLERS = [
  'GPTBot',
  'Google-Extended',
  'CCBot',
  'Applebot-Extended',
  'meta-externalagent',
] as const

export const AI_ANSWER_CRAWLERS = [
  'OAI-SearchBot',
  'PerplexityBot',
  'ChatGPT-User',
  'Claude-SearchBot',
] as const

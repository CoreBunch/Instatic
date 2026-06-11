/**
 * AI usage repository — read-only rollups over `ai_conversations` +
 * `ai_messages` for the `/admin/ai` Audit tab and the dashboard widget.
 *
 * Three rollups, each derived from the same per-message ledger:
 *
 *   - `getUsageByUser(db, sinceIso)`     — one row per `user_id` with
 *                                          summed tokens + cost + chat count.
 *   - `getUsageByScope(db, sinceIso)`    — one row per chat surface
 *                                          ('site' | 'content' | …).
 *   - `getUsageByDay(db, sinceIso)`      — one row per calendar day for the
 *                                          time-series chart in the widget.
 *
 * Plus:
 *   - `getUsageTotals(db, sinceIso)`     — single-row totals (used by the
 *                                          dashboard widget headline).
 *
 * Time bucketing reads `ai_messages.created_at` (the per-call timestamp);
 * `ai_conversations.created_at` would over-count the first day of a chat
 * that ran for weeks.
 *
 * Defence in depth: every query reads from the messages table directly so
 * a stale denormalised total on `ai_conversations` (e.g. partial write
 * crash) can't skew the rollup. The performance cost is negligible at the
 * scales expected for a self-hosted CMS — the heaviest rollup over a
 * 10k-row history is still a single index scan.
 */

import type { DbClient } from '../../db/client'
import { localDayKeyFactory } from '../../time'
import type { AiProviderId, ToolScope } from '../runtime/types'

interface UsageRow {
  promptTokens: number
  completionTokens: number
  costUsd: number
  chatCount: number
  /** Anthropic prompt-cache hit + write tokens. Zero for other providers. */
  cacheReadTokens: number
  cacheCreationTokens: number
}

interface UsageByUserRow extends UsageRow {
  userId: string
  userLabel: string
}

interface UsageByScopeRow extends UsageRow {
  scope: ToolScope
}

interface UsageByDayRow extends UsageRow {
  /** Calendar date in YYYY-MM-DD. */
  day: string
}

interface UsageByModelRow extends UsageRow {
  providerId: AiProviderId
  modelId: string
}

interface AggregateRow {
  prompt_tokens: number | string | null
  completion_tokens: number | string | null
  cost_usd: number | string | null
  chat_count: number | string | null
  cache_read_tokens: number | string | null
  cache_creation_tokens: number | string | null
}

interface UserAggregateRow extends AggregateRow {
  user_id: string
  email: string | null
  display_name: string | null
}

interface ScopeAggregateRow extends AggregateRow {
  scope: string
}

interface DayMessageRow {
  created_at: string | Date
  conversation_id: string
  prompt_tokens: number | string | null
  completion_tokens: number | string | null
  cost_usd: number | string | null
  cache_read_tokens: number | string | null
  cache_creation_tokens: number | string | null
}

interface ModelAggregateRow extends AggregateRow {
  provider_id: string
  model_id: string
}

function toNumber(value: number | string | null | undefined): number {
  if (value == null) return 0
  return typeof value === 'number' ? value : Number(value)
}

function userLabel(email: string | null, displayName: string | null, userId: string): string {
  const name = displayName?.trim()
  if (name) return name
  if (email) return email
  return userId
}

// ---------------------------------------------------------------------------
// Helpers — `since` clause + per-message → per-conversation chat count.
//
// `chat_count` is the number of DISTINCT conversation ids that had any
// message activity inside the window. A user with three active chats this
// month registers `chatCount = 3` even if those chats started months ago.
// ---------------------------------------------------------------------------

export async function getUsageTotals(
  db: DbClient,
  sinceIso: string,
): Promise<UsageRow> {
  const { rows } = await db<AggregateRow>`
    select coalesce(sum(m.prompt_tokens), 0)            as prompt_tokens,
           coalesce(sum(m.completion_tokens), 0)        as completion_tokens,
           coalesce(sum(m.cost_usd), 0)                 as cost_usd,
           coalesce(sum(m.cache_read_tokens), 0)        as cache_read_tokens,
           coalesce(sum(m.cache_creation_tokens), 0)    as cache_creation_tokens,
           count(distinct m.conversation_id)            as chat_count
    from ai_messages m
    where m.created_at >= ${sinceIso}
  `
  const row = rows[0]
  return {
    promptTokens: toNumber(row?.prompt_tokens),
    completionTokens: toNumber(row?.completion_tokens),
    costUsd: toNumber(row?.cost_usd),
    chatCount: toNumber(row?.chat_count),
    cacheReadTokens: toNumber(row?.cache_read_tokens),
    cacheCreationTokens: toNumber(row?.cache_creation_tokens),
  }
}

export async function getUsageByUser(
  db: DbClient,
  sinceIso: string,
): Promise<UsageByUserRow[]> {
  const { rows } = await db<UserAggregateRow>`
    select c.user_id                                  as user_id,
           u.email                                    as email,
           u.display_name                             as display_name,
           coalesce(sum(m.prompt_tokens), 0)          as prompt_tokens,
           coalesce(sum(m.completion_tokens), 0)      as completion_tokens,
           coalesce(sum(m.cost_usd), 0)               as cost_usd,
           coalesce(sum(m.cache_read_tokens), 0)      as cache_read_tokens,
           coalesce(sum(m.cache_creation_tokens), 0)  as cache_creation_tokens,
           count(distinct m.conversation_id)          as chat_count
    from ai_messages m
    join ai_conversations c on c.id = m.conversation_id
    left join users u on u.id = c.user_id
    where m.created_at >= ${sinceIso}
    group by c.user_id, u.email, u.display_name
    order by cost_usd desc, prompt_tokens desc
  `
  return rows.map((row) => ({
    userId: row.user_id,
    userLabel: userLabel(row.email, row.display_name, row.user_id),
    promptTokens: toNumber(row.prompt_tokens),
    completionTokens: toNumber(row.completion_tokens),
    costUsd: toNumber(row.cost_usd),
    chatCount: toNumber(row.chat_count),
    cacheReadTokens: toNumber(row.cache_read_tokens),
    cacheCreationTokens: toNumber(row.cache_creation_tokens),
  }))
}

export async function getUsageByScope(
  db: DbClient,
  sinceIso: string,
): Promise<UsageByScopeRow[]> {
  const { rows } = await db<ScopeAggregateRow>`
    select c.scope                                  as scope,
           coalesce(sum(m.prompt_tokens), 0)        as prompt_tokens,
           coalesce(sum(m.completion_tokens), 0)    as completion_tokens,
           coalesce(sum(m.cost_usd), 0)             as cost_usd,
           coalesce(sum(m.cache_read_tokens), 0)    as cache_read_tokens,
           coalesce(sum(m.cache_creation_tokens), 0) as cache_creation_tokens,
           count(distinct m.conversation_id)        as chat_count
    from ai_messages m
    join ai_conversations c on c.id = m.conversation_id
    where m.created_at >= ${sinceIso}
    group by c.scope
    order by cost_usd desc
  `
  return rows.map((row) => ({
    scope: row.scope as ToolScope,
    promptTokens: toNumber(row.prompt_tokens),
    completionTokens: toNumber(row.completion_tokens),
    costUsd: toNumber(row.cost_usd),
    chatCount: toNumber(row.chat_count),
    cacheReadTokens: toNumber(row.cache_read_tokens),
    cacheCreationTokens: toNumber(row.cache_creation_tokens),
  }))
}

/**
 * Per-`(provider, model)` rollup — the headline view when an operator
 * wants to know "which model is racking up cost?". `provider_id` is sourced
 * by joining through `ai_provider_credentials` (the credential row the
 * conversation was created with) rather than reading from the conversation
 * directly, because conversations only carry `credential_id + model_id`.
 *
 * A credential whose row was deleted mid-window still shows up here — the
 * left join preserves history. Such rows carry `provider_id = 'unknown'`.
 */
export async function getUsageByModel(
  db: DbClient,
  sinceIso: string,
): Promise<UsageByModelRow[]> {
  const { rows } = await db<ModelAggregateRow>`
    select coalesce(cred.provider_id, 'unknown')      as provider_id,
           c.model_id                                 as model_id,
           coalesce(sum(m.prompt_tokens), 0)          as prompt_tokens,
           coalesce(sum(m.completion_tokens), 0)      as completion_tokens,
           coalesce(sum(m.cost_usd), 0)               as cost_usd,
           coalesce(sum(m.cache_read_tokens), 0)      as cache_read_tokens,
           coalesce(sum(m.cache_creation_tokens), 0)  as cache_creation_tokens,
           count(distinct m.conversation_id)          as chat_count
    from ai_messages m
    join ai_conversations c on c.id = m.conversation_id
    left join ai_provider_credentials cred on cred.id = c.credential_id
    where m.created_at >= ${sinceIso}
    group by cred.provider_id, c.model_id
    order by cost_usd desc, prompt_tokens desc
  `
  return rows.map((row) => ({
    providerId: row.provider_id as AiProviderId,
    modelId: row.model_id,
    promptTokens: toNumber(row.prompt_tokens),
    completionTokens: toNumber(row.completion_tokens),
    costUsd: toNumber(row.cost_usd),
    chatCount: toNumber(row.chat_count),
    cacheReadTokens: toNumber(row.cache_read_tokens),
    cacheCreationTokens: toNumber(row.cache_creation_tokens),
  }))
}

/**
 * Daily rollup, bucketed into the VIEWER's calendar day.
 *
 * The day key is computed in JS rather than SQL — same convention as the
 * dashboard's posts histogram (`readPostsHistogram`) — because portable
 * date-truncation SQL is dialect-painful (PG `::text` is banned by the
 * `db-postgres-isms` gate) and, critically, the bucket boundary depends on
 * the operator's timezone, which the database doesn't know. A chat at
 * 23:30 local sits on a different calendar day than the UTC instant suggests,
 * so SQL-side `substr(created_at, 1, 10)` (UTC date) put it on the wrong bar.
 *
 * `timeZone` is an IANA zone (e.g. "Europe/Bratislava"). Using a full zone —
 * not a fixed offset — keeps buckets correct across DST transitions inside a
 * multi-week window and across sub-hour offsets (e.g. Asia/Kathmandu +5:45).
 *
 * Cardinality is bounded by the message count in the window; the same
 * trade-off the posts histogram accepts. Each message is summed once.
 */
export async function getUsageByDay(
  db: DbClient,
  sinceIso: string,
  timeZone: string,
): Promise<UsageByDayRow[]> {
  const { rows } = await db<DayMessageRow>`
    select m.created_at        as created_at,
           m.conversation_id   as conversation_id,
           m.prompt_tokens     as prompt_tokens,
           m.completion_tokens as completion_tokens,
           m.cost_usd          as cost_usd,
           m.cache_read_tokens as cache_read_tokens,
           m.cache_creation_tokens as cache_creation_tokens
    from ai_messages m
    where m.created_at >= ${sinceIso}
  `

  const dayKeyOf = localDayKeyFactory(timeZone)
  const byDay = new Map<string, UsageByDayRow>()
  const convsByDay = new Map<string, Set<string>>()

  for (const row of rows) {
    const day = dayKeyOf(row.created_at)
    let acc = byDay.get(day)
    if (!acc) {
      acc = {
        day,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        chatCount: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
      byDay.set(day, acc)
      convsByDay.set(day, new Set())
    }
    acc.promptTokens += toNumber(row.prompt_tokens)
    acc.completionTokens += toNumber(row.completion_tokens)
    acc.costUsd += toNumber(row.cost_usd)
    acc.cacheReadTokens += toNumber(row.cache_read_tokens)
    acc.cacheCreationTokens += toNumber(row.cache_creation_tokens)
    convsByDay.get(day)!.add(row.conversation_id)
  }

  for (const [day, convs] of convsByDay) {
    byDay.get(day)!.chatCount = convs.size
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

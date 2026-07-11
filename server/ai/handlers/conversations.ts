/**
 * Conversations handler — full CRUD over chat history.
 *
 *   GET    /admin/api/ai/conversations?scope=site            list
 *   POST   /admin/api/ai/conversations                       create
 *   GET    /admin/api/ai/conversations/:id                   read (+messages)
 *   PUT    /admin/api/ai/conversations/:id                   update
 *   DELETE /admin/api/ai/conversations/:id                   soft-delete
 *
 * Every operation is scoped to the authenticated user (cross-user reads
 * return 404).
 */

import { Type } from '@core/utils/typeboxHelpers'
import { jsonResponse, readValidatedBody, badRequest } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import {
  createConversationForUser,
  listConversationsForUserScope,
  listMessagesForConversation,
  readConversationForUser,
  softDeleteConversationForUser,
  toConversationDetailView,
  toConversationView,
  updateConversationForUser,
} from '../conversations/store'
import type { ToolScope } from '../runtime/types'

const VALID_SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']

const CreateBodySchema = Type.Object({
  scope: Type.Union(VALID_SCOPES.map((s) => Type.Literal(s))),
  title: Type.Optional(Type.String()),
  credentialId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
})

const UpdateBodySchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1 })),
  credentialId: Type.Optional(Type.String({ minLength: 1 })),
  modelId: Type.Optional(Type.String({ minLength: 1 })),
})

export function tryHandleAiConversations(
  req: Request,
  db: DbClient,
  url: URL,
  pathname: string,
): Promise<Response> | null {
  if (pathname === '/admin/api/ai/conversations') {
    return dispatchCollection(req, db, url)
  }
  const match = pathname.match(/^\/admin\/api\/ai\/conversations\/([^/]+)$/)
  if (match) {
    return dispatchItem(req, db, match[1]!)
  }
  return null
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function dispatchCollection(req: Request, db: DbClient, url: URL): Promise<Response> {
  if (req.method === 'GET') return handleList(req, db, url)
  if (req.method === 'POST') return handleCreate(req, db)
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleList(req: Request, db: DbClient, url: URL): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const scopeParam = url.searchParams.get('scope')
  if (!scopeParam || !VALID_SCOPES.includes(scopeParam as ToolScope)) {
    return jsonResponse(
      { error: `Query parameter \`scope\` is required (one of: ${VALID_SCOPES.join(', ')})` },
      { status: 400 },
    )
  }
  const records = await listConversationsForUserScope(
    db,
    userOrResponse.id,
    scopeParam as ToolScope,
  )
  return jsonResponse({ conversations: records.map(toConversationView) })
}

async function handleCreate(req: Request, db: DbClient): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, CreateBodySchema)
  if (!body) return badRequest('Invalid request body.')

  const record = await createConversationForUser(db, userOrResponse.id, body)
  return jsonResponse({ conversation: toConversationView(record) }, { status: 201 })
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

async function dispatchItem(req: Request, db: DbClient, id: string): Promise<Response> {
  if (req.method === 'GET') return handleRead(req, db, id)
  if (req.method === 'PUT') return handleUpdate(req, db, id)
  if (req.method === 'DELETE') return handleDelete(req, db, id)
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

async function handleRead(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const conv = await readConversationForUser(db, userOrResponse.id, id)
  if (!conv) return jsonResponse({ error: 'Conversation not found' }, { status: 404 })

  const messages = await listMessagesForConversation(db, id)
  return jsonResponse(
    { conversation: toConversationDetailView(conv, messages) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

async function handleUpdate(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const body = await readValidatedBody(req, UpdateBodySchema)
  if (!body) return badRequest('Invalid request body.')

  const record = await updateConversationForUser(db, userOrResponse.id, id, body)
  if (!record) return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
  return jsonResponse({ conversation: toConversationView(record) })
}

async function handleDelete(req: Request, db: DbClient, id: string): Promise<Response> {
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  const ok = await softDeleteConversationForUser(db, userOrResponse.id, id)
  if (!ok) return jsonResponse({ error: 'Conversation not found' }, { status: 404 })
  return jsonResponse({ ok: true })
}

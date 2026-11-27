import { AiChatRequestBodySchema } from '@core/ai'
import { Type } from '@core/utils/typeboxHelpers'
import { CreateBodySchema as CreateCredential, UpdateBodySchema as UpdateCredential } from '../../ai/handlers/credentials'
import { CreateBodySchema as CreateConversation, UpdateBodySchema as UpdateConversation } from '../../ai/handlers/conversations'
import { PutBodySchema } from '../../ai/handlers/defaults'
import { operation as op } from './operation'

const base = '/admin/api/ai/'
const chat = 'ai.chat'
const manage = 'ai.providers.manage'
const scope = 'Use site, content, data or plugin for scope.'
export const aiOperations = [
  op('GET', base + 'credentials', manage, 'List this identity’s masked AI credentials'),
  op('POST', base + 'credentials', manage, 'Create an AI provider credential', { bodySchema: CreateCredential }),
  op('PUT', base + 'credentials/:id', manage, 'Update a credential owned by this identity', { bodySchema: UpdateCredential }),
  op('DELETE', base + 'credentials/:id', manage, 'Delete an owned credential'),
  op('POST', base + 'credentials/:id/test', manage, 'Test an owned provider credential'),
  op('GET', base + 'defaults', chat, 'Read default AI models by workspace'),
  op('PUT', base + 'defaults/:scope', manage, 'Set a workspace model default. ' + scope, { bodySchema: PutBodySchema }),
  op('DELETE', base + 'defaults/:scope', manage, 'Clear a workspace model default. ' + scope),
  op('GET', base + 'providers/:providerId/models', chat, 'List models from a provider', { querySchema: Type.Object({ credentialId: Type.Optional(Type.String()) }) }),
  op('GET', base + 'conversations', chat, 'List your conversations for a workspace. ' + scope, { querySchema: Type.Object({ scope: Type.String() }) }),
  op('POST', base + 'conversations', chat, 'Create a conversation with a model and credential', { bodySchema: CreateConversation }),
  op('GET', base + 'conversations/:id', chat, 'Read your conversation and messages'),
  op('PUT', base + 'conversations/:id', chat, 'Update your conversation', { bodySchema: UpdateConversation }),
  op('DELETE', base + 'conversations/:id', chat, 'Delete your conversation'),
  op('GET', base + 'conversations/:id/messages/:messageId/images/:index', chat, 'Download an image by its numeric index in your message', { outputFile: 'image.jpg' }),
  op('POST', base + 'chat/:scope', chat, 'Send content to your conversation and stream the reply. Use --branch to select the draft that tools read. ' + scope, { bodySchema: AiChatRequestBodySchema }),
  op('GET', base + 'audit', 'ai.audit.read', 'Read AI usage totals', { querySchema: Type.Partial(Type.Object({ since: Type.String({ description: 'ISO timestamp' }), tz: Type.String({ description: 'IANA time zone' }) })) }),
]

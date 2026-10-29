import type { DbClient } from '../../../db/client'
import type { BranchScope } from '../../../branches/scope'
import { resolveRowAccess, canReadDataRow } from '../../../auth/dataAccess'
import { getRowAttachment, listRowAttachments } from '../../../repositories/rowAttachments'
import { jsonResponse } from '../../../http'
import type { RouteParams } from '../routeTable'
import { requireDataAccess } from './access'

export async function handleRowAttachments(req: Request, db: DbClient, params: RouteParams, scope: BranchScope): Promise<Response> {
  const user = await requireDataAccess(req, db)
  if (user instanceof Response) return user
  const access = await resolveRowAccess(db, scope, params.id, user, canReadDataRow)
  if (access.kind !== 'ok') return jsonResponse({ error: 'Attachment not found' }, { status: 404 })
  if (!params.attachmentId) {
    return jsonResponse({ attachments: await listRowAttachments(db, scope, params.id) }, { headers: { 'cache-control': 'private, no-store' } })
  }
  const file = await getRowAttachment(db, scope, params.id, params.attachmentId)
  if (!file) return jsonResponse({ error: 'Attachment not found' }, { status: 404 })
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(Buffer.from(file.filename, 'utf8').toString('utf8')).replace(/'/g, '%27')}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
    },
  })
}

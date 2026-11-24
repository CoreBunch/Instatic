import type { MemberSettings } from '@core/members'
import type { DbClient } from '../db/client'
import { memberLinkOrigin, memberMailAvailable } from './mail'
import { listMemberPageOptions } from './pages'

export async function memberSettingsView(req: Request, db: DbClient, settings: MemberSettings) {
  const [pageOptions, mailAvailable] = await Promise.all([listMemberPageOptions(db), memberMailAvailable(db, req)])
  return { settings, pageOptions, mailAvailable, linkAvailable: memberLinkOrigin(req) !== null }
}

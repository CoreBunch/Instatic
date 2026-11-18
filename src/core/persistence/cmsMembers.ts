/**
 * Client for the members admin API (`/admin/api/cms/members`). Site members
 * are the people with an account on the published site.
 */
import { Type } from '@sinclair/typebox'
import { apiRequest } from '@core/http'
import {
  MemberAppListResponseSchema,
  MemberAppSchema,
  MemberDetailResponseSchema,
  MemberInviteResponseSchema,
  MemberListResponseSchema,
  MemberSettingsResponseSchema,
  type CreateMemberAppBody,
  type MemberAdminStatus,
  type MemberApp,
  type MemberAppListResponse,
  type MemberDetail,
  type MemberListItem,
  type MemberListResponse,
  type MemberSettings,
  type MemberSettingsResponse,
} from '@core/members'

const MEMBERS_PATH = '/admin/api/cms/members'
const OkSchema = Type.Object({ ok: Type.Boolean() })

const memberPath = (id: string, action = '') => `${MEMBERS_PATH}/${encodeURIComponent(id)}${action}`

export interface CmsMemberListQuery {
  search: string
  status: MemberAdminStatus | null
  tag: string | null
  /** Where the next page starts, from the previous page's `nextOffset`. */
  offset?: number
}

export async function listCmsMembers(query: CmsMemberListQuery, signal?: AbortSignal): Promise<MemberListResponse> {
  return apiRequest(MEMBERS_PATH, {
    query: {
      ...(query.search.trim() ? { q: query.search.trim() } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      ...(query.offset ? { offset: String(query.offset) } : {}),
    },
    schema: MemberListResponseSchema,
    signal,
    fallbackMessage: 'Could not load the members',
  })
}

export async function getCmsMember(id: string, signal?: AbortSignal): Promise<MemberDetail> {
  const body = await apiRequest(memberPath(id), {
    schema: MemberDetailResponseSchema,
    signal,
    fallbackMessage: 'Could not load the member',
  })
  return body.detail
}

export async function inviteCmsMember(
  email: string,
  tags: readonly string[],
  /** `link` mails nothing and answers with the link, for the admin to pass on. */
  delivery: 'email' | 'link' = 'email',
): Promise<{ member: MemberListItem; outcome: 'invited' | 'resent'; link?: string }> {
  return apiRequest(`${MEMBERS_PATH}/invite`, {
    method: 'POST',
    body: { email, tags, delivery },
    schema: MemberInviteResponseSchema,
    fallbackMessage: 'The invitation could not be sent',
  })
}

/** A change to one member; answers with the member as it now stands. */
async function changeMember(
  id: string,
  action: string,
  method: 'POST' | 'DELETE',
  body: unknown,
  fallbackMessage: string,
): Promise<MemberDetail> {
  const response = await apiRequest(memberPath(id, action), {
    method,
    ...(body === undefined ? {} : { body }),
    schema: MemberDetailResponseSchema,
    fallbackMessage,
  })
  return response.detail
}

export function suspendCmsMember(id: string): Promise<MemberDetail> {
  return changeMember(id, '/suspend', 'POST', undefined, 'The member could not be suspended')
}

export function unsuspendCmsMember(id: string): Promise<MemberDetail> {
  return changeMember(id, '/unsuspend', 'POST', undefined, 'The member could not be restored')
}

export function signOutCmsMember(id: string): Promise<MemberDetail> {
  return changeMember(id, '/sign-out', 'POST', undefined, 'The member could not be signed out')
}

/** Signs the member out of one app; `grantId` is the connected app's `id`. */
export function disconnectCmsMemberApp(id: string, grantId: string): Promise<MemberDetail> {
  return changeMember(id, `/apps/${encodeURIComponent(grantId)}`, 'DELETE', undefined, 'The app could not be disconnected')
}

export function grantCmsMemberTag(id: string, tag: string, expiresAt: string | null): Promise<MemberDetail> {
  return changeMember(id, '/tags', 'POST', { tag, expiresAt }, 'The tag could not be added')
}

export function revokeCmsMemberTag(id: string, tag: string, source: string): Promise<MemberDetail> {
  return changeMember(id, '/tags', 'DELETE', { tag, source }, 'The tag could not be removed')
}

export async function deleteCmsMember(id: string): Promise<void> {
  await apiRequest(memberPath(id), { method: 'DELETE', schema: OkSchema, fallbackMessage: 'The member could not be deleted' })
}

export async function getCmsMemberSettings(signal?: AbortSignal): Promise<MemberSettingsResponse> {
  return apiRequest(`${MEMBERS_PATH}/settings`, {
    schema: MemberSettingsResponseSchema,
    signal,
    fallbackMessage: 'Could not load the member settings',
  })
}

export async function saveCmsMemberSettings(settings: MemberSettings): Promise<MemberSettingsResponse> {
  return apiRequest(`${MEMBERS_PATH}/settings`, {
    method: 'PUT',
    body: settings,
    schema: MemberSettingsResponseSchema,
    fallbackMessage: 'The member settings could not be saved',
  })
}

// ─── Sign-in for apps ──────────────────────────────────────────────────────

const APPS_PATH = `${MEMBERS_PATH}/apps`

/** The registered apps, and what an app can be given on this site right now. */
export async function listCmsMemberApps(signal?: AbortSignal): Promise<MemberAppListResponse> {
  return apiRequest(APPS_PATH, {
    schema: MemberAppListResponseSchema,
    signal,
    fallbackMessage: 'Could not load the apps',
  })
}

export async function createCmsMemberApp(body: CreateMemberAppBody): Promise<MemberApp> {
  return apiRequest(APPS_PATH, {
    method: 'POST',
    body,
    schema: MemberAppSchema,
    fallbackMessage: 'The app could not be added',
  })
}

/** Removes the app and signs out everyone who signed in through it. */
export async function deleteCmsMemberApp(id: string): Promise<void> {
  await apiRequest(`${APPS_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    schema: OkSchema,
    fallbackMessage: 'The app could not be removed',
  })
}

/**
 * What an app that signs a site member in may ask for. Shared by the server
 * (the authorization server checks requests against it) and the admin (the
 * owner picks from it when registering an app).
 */
export const MEMBER_APP_SCOPES = ['profile', 'access'] as const
export type MemberAppScope = (typeof MEMBER_APP_SCOPES)[number]

/** Each scope in the words a member reads on the approval page. */
export const MEMBER_APP_SCOPE_TEXT: Record<MemberAppScope, string> = {
  profile: 'Your name and email address',
  access: 'Which memberships and access you hold',
}

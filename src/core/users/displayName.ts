/**
 * The name shown for an admin: the display name, or — since "Your name" is
 * optional at setup and in the profile — the email address.
 *
 * Shared by the admin UI and the collab relay: the relay only forwards
 * presence whose `user.name` equals the session identity it derives with this
 * same function, so both sides must agree.
 */
export function userDisplayLabel(user: { displayName: string; email: string }): string {
  return user.displayName.trim() || user.email
}

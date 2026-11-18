/**
 * Member events for plugins. Each is emitted on the plugin hook bus from the
 * one function every path goes through (creating a member, confirming an
 * address, starting a session, granting a tag, deleting), so no flow can
 * forget to announce itself.
 *
 * Emission never holds the member up: a slow or failing plugin listener must
 * not delay a sign-in. Only plugins holding `members.read` may subscribe
 * (`handleHooksOn`), because the payloads name members.
 */
import { hookBus, type MemberHookEvent } from '@core/plugins/hookBus'

export function emitMemberHook(event: MemberHookEvent, payload: Record<string, unknown>): void {
  void hookBus.emit(event, payload).catch((err: unknown) => {
    console.error(`[members] ${event} hook failed:`, err)
  })
}

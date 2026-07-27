/**
 * Built-in `visitor.current` loop source — exposes the logged-in visitor for
 * per-visitor personalisation on portal pages.
 *
 * Use-case A of the per-visitor-data framework: "Welcome back, {name}",
 * "Your school: {schoolName}", etc. The source emits a SINGLE item carrying
 * the resolved visitor's id, displayName, email, roleName, and every custom
 * profile field (e.g. schoolName), so a `{currentEntry.schoolName}` binding
 * inside the loop renders the visitor's value.
 *
 * `perVisitor: true` → the loop never bakes into static HTML, bypasses the
 * Layer B cache, and re-renders on every page load with `Cache-Control: no-store`.
 * Anonymous requests (no valid session) get an empty item list, so the loop's
 * children simply do not render — wrap the loop in an auth-gated container to
 * ensure it only shows behind a login.
 *
 * Identity is IDOR-safe: the resolved visitor arrives via `ctx.visitor`,
 * which the server prefetch layer derives SOLELY from the validated session
 * cookie. This source never reads a visitor id from filters/query/path.
 */

import type { LoopEntitySource, LoopFetchResult } from '@core/loops/types'

export const VisitorCurrentSource: LoopEntitySource = {
  id: 'visitor.current',
  label: 'Current visitor',
  description:
    'The logged-in visitor — for personalised display (name, email, role, custom profile fields). Per-visitor: anonymous requests render nothing.',

  // Per-visitor: cookie-derived, no-store, never baked into static HTML.
  perVisitor: true,

  // No source-specific filters — identity is always the resolved session.
  filterSchema: {},
  orderByOptions: [],

  // System fields are fixed; custom profile fields are spread dynamically at
  // fetch time, so the declared `fields` list covers the common bindings.
  // Unknown profile-field tokens still resolve (the resolver is name-based).
  fields: [
    { id: 'id', label: 'Member ID' },
    { id: 'displayName', label: 'Display name' },
    { id: 'email', label: 'Email' },
    { id: 'roleName', label: 'Role' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    const visitor = ctx.visitor
    // No valid session → render nothing. The loop's children simply omit.
    if (!visitor) return { items: [], totalItems: 0 }
    return {
      items: [
        {
          id: visitor.id,
          fields: {
            id: visitor.id,
            displayName: visitor.displayName,
            email: visitor.email,
            roleName: visitor.roleName,
            // Spread custom profile fields (schoolName, etc.) so
            // {currentEntry.schoolName} bindings resolve automatically.
            ...visitor.profileFields,
          },
        },
      ],
      totalItems: 1,
    }
  },

  preview() {
    // The canvas loop-preview path synthesises items from a real visitor
    // when available; this synchronous preview returns [] so no placeholder
    // identity leaks into the editor.
    return []
  },
}

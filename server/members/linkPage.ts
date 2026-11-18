/**
 * The one fixed screen members have: a bare page for a link in an email,
 * used only when the owner has not assigned their own page for that link
 * (Members settings). Without it a site that never built a "reset password"
 * page could not reset a password at all.
 *
 * The page never acts on GET. Mail scanners and link previews open links;
 * the token is only used up when the visitor presses the button, which POSTs
 * it to the matching action in `handlers.ts`.
 */
import type { DbClient } from '../db/client'
import { escapeHtml } from '@core/publisher'
import { MEMBER_LINK_PATH_PREFIX } from './mail'
import { getMemberSettings } from './repository'
import { memberTokenIsLive, type MemberTokenKind } from './tokens'

interface LinkPageCopy {
  title: string
  intro: string
  button: string
  action: string
  needsPassword: boolean
}

const COPY: Record<MemberTokenKind, LinkPageCopy> = {
  verify: {
    title: 'Confirm your email address',
    intro: 'Press the button to confirm your address and sign in.',
    button: 'Confirm and sign in',
    action: 'verify',
    needsPassword: false,
  },
  magic: {
    title: 'Sign in',
    intro: 'Press the button to sign in.',
    button: 'Sign in',
    action: 'link/confirm',
    needsPassword: false,
  },
  reset: {
    title: 'Choose a new password',
    intro: 'Enter a new password for your account.',
    button: 'Save password and sign in',
    action: 'password/reset',
    needsPassword: true,
  },
  invite: {
    title: 'Create your account',
    intro: 'Choose a password to finish creating your account.',
    button: 'Create account',
    action: 'invite/accept',
    needsPassword: true,
  },
  email_change: {
    title: 'Confirm your new email address',
    intro: 'Press the button to use this address for your account.',
    button: 'Confirm new address',
    action: 'email/confirm',
    needsPassword: false,
  },
}

const ERRORS: Record<string, string> = {
  invalid_token: 'This link has expired or was already used. Ask for a new one.',
  weak_password: 'Choose a password with at least 12 characters.',
  rate_limited: 'Too many attempts. Try again in a few minutes.',
  email_taken: 'That email address is already in use.',
}

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:15vh 1.5rem;color:#111;background:#fff}' +
  'main{max-width:24rem;margin:0 auto}h1{font-size:1.25rem}' +
  'label{display:block;margin:1rem 0 .25rem}input{font:inherit;width:100%;box-sizing:border-box;padding:.5rem}' +
  'button{font:inherit;margin-top:1.25rem;padding:.6rem 1rem}[role=alert]{color:#b00020}'

function isTokenKind(value: string): value is MemberTokenKind {
  return value in COPY
}

function page(title: string, body: string): Response {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The address bar holds a live token: never hand it to another page.
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    },
  })
}

/**
 * The bare sign-in page a protected page sends a signed-out visitor to when
 * the owner has not assigned a login page. `next` is where they were going;
 * only a site-relative path is honoured.
 */
export async function renderMemberSignInPage(
  db: DbClient,
  url: URL,
  safePath: (value: string | null) => string | null,
): Promise<Response> {
  const settings = await getMemberSettings(db)
  const next = safePath(url.searchParams.get('next')) ?? settings.pages.afterLogin ?? '/'
  const errorCode = url.searchParams.get('member_error') ?? ''
  const here = `${url.pathname}?next=${encodeURIComponent(next)}`
  const error =
    errorCode === 'invalid_credentials'
      ? 'The email or password is not right.'
      : errorCode === 'rate_limited'
        ? 'Too many attempts. Try again in a few minutes.'
        : errorCode
          ? 'Something went wrong. Try again.'
          : ''
  const sent = url.searchParams.get('member_ok') === 'check_email'
  const hidden =
    `<input type="hidden" name="_error" value="${escapeHtml(here)}">`
  const body =
    (error ? `<p role="alert">${escapeHtml(error)}</p>` : '') +
    (sent ? '<p role="status">If that address has an account, a sign-in link is on its way.</p>' : '') +
    '<form method="post" action="/_instatic/members/login">' +
    `<input type="hidden" name="_success" value="${escapeHtml(next)}">${hidden}` +
    '<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>' +
    '<label for="password">Password</label>' +
    '<input id="password" name="password" type="password" autocomplete="current-password" required>' +
    '<button type="submit">Sign in</button></form>' +
    '<form method="post" action="/_instatic/members/link/request">' +
    `<input type="hidden" name="_success" value="${escapeHtml(`${here}&member_ok=check_email`)}">${hidden}` +
    '<label for="link-email">Or get a sign-in link by email</label>' +
    '<input id="link-email" name="email" type="email" autocomplete="username" required>' +
    '<button type="submit">Email me a link</button></form>'
  return page('Sign in', body)
}

export async function renderMemberLinkPage(db: DbClient, url: URL): Promise<Response> {
  const kind = url.pathname.slice(MEMBER_LINK_PATH_PREFIX.length)
  if (!isTokenKind(kind)) return new Response('Not found', { status: 404 })
  const copy = COPY[kind]
  const token = url.searchParams.get('token') ?? ''
  const errorCode = url.searchParams.get('member_error') ?? ''

  if (!(await memberTokenIsLive(db, token, kind))) {
    return page(copy.title, `<p role="alert">${escapeHtml(ERRORS.invalid_token)}</p>`)
  }

  const settings = await getMemberSettings(db)
  const here = `${url.pathname}?token=${encodeURIComponent(token)}`
  const error = ERRORS[errorCode] ?? (errorCode ? 'Something went wrong. Try again.' : '')
  const body =
    `<p>${escapeHtml(copy.intro)}</p>` +
    (error ? `<p role="alert">${escapeHtml(error)}</p>` : '') +
    `<form method="post" action="/_instatic/members/${copy.action}">` +
    `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
    `<input type="hidden" name="_success" value="${escapeHtml(settings.pages.afterLogin ?? '/')}">` +
    `<input type="hidden" name="_error" value="${escapeHtml(here)}">` +
    (copy.needsPassword
      ? '<label for="password">New password</label>' +
        '<input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required>'
      : '') +
    `<button type="submit">${escapeHtml(copy.button)}</button></form>`
  return page(copy.title, body)
}

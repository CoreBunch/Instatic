/**
 * Browser runtime for visitor auth (login / register) + auth-state reveal.
 *
 * Self-contained ES module — no dependencies, no framework. The middleware
 * injects a `<script type="module" src="/_instatic/visitor-auth.js" defer>`
 * tag into the built-in fallback login page (D6) and into any builder-authored
 * page that ships `data-instatic-auth` forms. It mirrors `holeRuntime.ts`.
 *
 * On load, the runtime:
 *   1. Intercepts the `submit` event on every `<form data-instatic-auth="…">`
 *      (`login`, `register`, and the Phase-2 `forgot` / `reset` hooks).
 *      It does light client-side validation (email shape, password >= 8 chars,
 *      register confirm-password match) and POSTs JSON to the matching
 *      `/api/visitor/*` endpoint with `credentials: 'same-origin'`. Server
 *      errors are mapped to friendly copy and shown in the form's
 *      `.instatic-auth-error` element. On success it redirects to the form's
 *      hidden `redirect` field (or `/`).
 *   2. Calls `GET /api/visitor/me` to reveal auth-aware chrome: un-hides
 *      `[data-instatic-auth-show]`, hides `[data-instatic-auth-hide]`, and
 *      stamps the visitor's `displayName || email` into `[data-instatic-auth-name]`.
 *      On any non-200 (or fetch failure) it does the inverse. This branch never
 *      throws — a missing/unreachable `/me` just means "treat as logged out".
 *
 * The shipped string is produced via `runInstaticVisitorAuthRuntime.toString()`;
 * Bun strips the type annotations and the comments here, keeps modern syntax
 * (`const` / arrow / optional-chaining — same as the committed `loopRuntime.ts`),
 * and minifies booleans, yielding a small dependency-free asset (~2-3 KB, per
 * the PRD "no JS by default" promise) servable verbatim with
 * `content-type: application/javascript; charset=utf-8`. The export pattern
 * (`(fn.toString)()`) mirrors `HOLE_RUNTIME_JS` in `holeRuntime.ts`. The body
 * is written compactly (shared `display()` helper, a tight if-chain) because
 * Bun preserves source whitespace verbatim in the stringified output.
 */

/** Best-effort shape of a non-2xx `/api/visitor/*` response body. The same
 *  loose shape is also read on a successful login (it carries the resolved
 *  post-login `redirect` path — D15). */
interface VisitorAuthErrorBody {
  error?: string;
  details?: { password?: string };
  retryAfterMs?: number;
  /** Server-resolved post-login landing path (login success only — D15). */
  redirect?: string;
}

/** Best-effort shape of a successful `GET /api/visitor/me` response body. */
interface VisitorMeBody {
  displayName?: string;
  email?: string;
}

/** Body POSTed to `/api/visitor/login` / `/api/visitor/register`. */
interface VisitorAuthPayload {
  email: string;
  password: string;
  displayName?: string;
}

export function runInstaticVisitorAuthRuntime(): void {
  // `.instatic-auth-error` element: fetch-or-create, then clear (CSS hides it
  // while empty, so it only renders once we set a message).
  const errorEl = (form: HTMLElement): HTMLElement => {
    let el = form.querySelector('.instatic-auth-error') as HTMLElement | null;
    if (!el) { el = document.createElement('div'); el.className = 'instatic-auth-error'; form.appendChild(el); }
    el.textContent = '';
    return el;
  };
  const setErr = (form: HTMLElement, msg: string): void => { errorEl(form).textContent = msg; };
  // Trimmed value of a named form field ('' if absent).
  const field = (form: HTMLElement, name: string): string => {
    const input = form.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    return input ? (input.value || '').trim() : '';
  };
  // Loose email shape check; the server is the real validator.
  const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  // Set `display` on a node list in one call (used 4x in reveal(), so this
  // also keeps the stringified output compact).
  const display = (els: NodeListOf<HTMLElement>, val: string): void => {
    for (const el of els) el.style.display = val;
  };
  // Map a non-2xx `{ error, details, retryAfterMs }` envelope to friendly copy.
  const describe = (status: number, body: VisitorAuthErrorBody | null): string => {
    const code = body?.error || '';
    if (status === 401 && code === 'invalid_credentials') return 'Incorrect email or password.';
    if (status === 409 && code === 'email_taken') return 'An account with that email already exists.';
    if (status === 422) return body?.details?.password || 'Please check your details and try again.';
    if (status === 429) return 'Too many attempts, please wait.';
    if (status === 403 && (code === 'registration_closed' || code === 'visitor_auth_disabled')) {
      return 'Registration is currently closed.';
    }
    return 'Something went wrong. Please try again.';
  };

  const submit = (form: HTMLElement, kind: string): void => {
    if (kind === 'forgot' || kind === 'reset') return setErr(form, 'Password reset is coming soon.');
    const email = field(form, 'email');
    const pw = field(form, 'password');
    const redirect = field(form, 'redirect');
    if (!email || !isEmail(email)) return setErr(form, 'Please enter a valid email address.');
    if (!pw || pw.length < 8) return setErr(form, 'Password must be at least 8 characters.');

    let url: string;
    let payload: VisitorAuthPayload;
    if (kind === 'login') {
      // Send the explicit redirect as a query param so the server can fold it
      // into its D15 landing resolution (explicit redirect > primary-group
      // landing > default). The runtime still honours a missing server value
      // by falling back to the form's own redirect field.
      url = '/api/visitor/login' + (redirect ? ('?redirect=' + encodeURIComponent(redirect)) : '');
      payload = { email, password: pw };
    } else if (kind === 'register') {
      if (form.querySelector('[name="confirm-password"]') && field(form, 'confirm-password') !== pw) {
        return setErr(form, 'Passwords do not match.');
      }
      payload = { email, password: pw };
      const displayName = field(form, 'displayName');
      if (displayName) payload.displayName = displayName;
      url = '/api/visitor/register';
    } else {
      return;
    }

    // The submit control is the only `[type="submit"]` inside an auth form.
    const btn = form.querySelector('[type="submit"]') as HTMLButtonElement | HTMLInputElement | null;
    if (btn) btn.disabled = true;

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    })
      .then((res) =>
        res.json().then((body: VisitorAuthErrorBody) => ({ ok: res.ok, status: res.status, body }), () => ({ ok: res.ok, status: res.status, body: null })),
      )
      .then((r) => {
        // D15: prefer the server-resolved landing path; fall back to the form's
        // explicit redirect field, then `/`. Keeping the runtime dumb means
        // the redirect resolution (primary group, default landing) stays
        // server-side and testable.
        if (r.ok) return (window.location.href = (r.body && r.body.redirect) || redirect || '/');
        setErr(form, describe(r.status, r.body));
        if (btn) btn.disabled = false;
      })
      .catch(() => (setErr(form, 'Network error. Please try again.'), btn && (btn.disabled = false)));
  };

  const init = (): void => {
    // Intercept every auth form.
    for (const form of document.querySelectorAll<HTMLElement>('form[data-instatic-auth]')) {
      const kind = form.getAttribute('data-instatic-auth') || '';
      form.addEventListener('submit', (e: SubmitEvent) => (e.preventDefault(), submit(form, kind)));
    }

    // Toggle auth-aware chrome based on /api/visitor/me. Never throws — a
    // missing/unreachable endpoint just means "treat as logged out".
    const show = document.querySelectorAll<HTMLElement>('[data-instatic-auth-show]');
    const hide = document.querySelectorAll<HTMLElement>('[data-instatic-auth-hide]');
    const nameEls = document.querySelectorAll<HTMLElement>('[data-instatic-auth-name]');
    fetch('/api/visitor/me', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('not authenticated'))))
      .then((user: VisitorMeBody) => {
        display(show, '');
        display(hide, 'none');
        const name = user?.displayName || user?.email || '';
        if (name) for (const el of nameEls) el.textContent = name;
      })
      .catch(() => (display(hide, ''), display(show, 'none')));
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

/**
 * Self-contained IIFE string served to browsers. Parsed once on load.
 */
export const VISITOR_AUTH_RUNTIME_JS = `(${runInstaticVisitorAuthRuntime.toString()})();`

/**
 * Built-in fallback login page (PRD §4.9 / D6).
 *
 * Served inline (NOT a redirect) by the visitor-auth middleware when no
 * published page exists at the configured `loginPath`. Pure HTML + a tiny
 * inline script — no templating required. The inline script reads `?redirect=`
 * from `location.search` and stamps it into the form's hidden `redirect`
 * field so the runtime can round-trip the post-login destination.
 *
 * Styling is intentionally minimal and self-contained: system-ui font,
 * dark-on-light, centered card. The form is wired to the visitor-auth runtime
 * via `data-instatic-auth="login"`.
 */
export const BUILT_IN_LOGIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f4f5f7;
      color: #1a1d21;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      -webkit-font-smoothing: antialiased;
    }
    main { width: 100%; max-width: 24rem; }
    .card {
      background: #ffffff;
      border-radius: 12px;
      padding: 2rem;
      box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1.25rem; font-weight: 600; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.375rem; }
    .field { margin-bottom: 1rem; }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 0.625rem 0.75rem;
      font-size: 1rem;
      color: #1a1d21;
      background: #ffffff;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      outline: none;
    }
    input[type="email"]:focus, input[type="password"]:focus {
      border-color: #6366f1;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
    }
    button[type="submit"] {
      width: 100%;
      padding: 0.625rem 1rem;
      font-size: 1rem;
      font-weight: 600;
      color: #ffffff;
      background: #1a1d21;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      margin-top: 0.25rem;
    }
    button[type="submit"]:hover { background: #303439; }
    button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }
    .instatic-auth-error {
      color: #b91c1c;
      background: #fef2f2;
      border: 1px solid #fee2e2;
      border-radius: 8px;
      padding: 0.5rem 0.75rem;
      font-size: 0.875rem;
      margin-bottom: 1rem;
      display: none;
    }
    .instatic-auth-error:not(:empty) { display: block; }
    .links {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin-top: 1.25rem;
      font-size: 0.875rem;
    }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Sign in</h1>
      <form data-instatic-auth="login" novalidate>
        <div class="field">
          <label for="instatic-email">Email</label>
          <input id="instatic-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="instatic-password">Password</label>
          <input id="instatic-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <input type="hidden" name="redirect" value="">
        <div class="instatic-auth-error" role="alert"></div>
        <button type="submit">Sign in</button>
      </form>
      <div class="links">
        <a href="/register">Create an account</a>
        <a href="/forgot">Forgot password?</a>
      </div>
    </div>
  </main>
  <script>
    // Round-trip ?redirect= into the hidden field without server templating.
    (function () {
      try {
        var params = new URLSearchParams(window.location.search);
        var redirect = params.get('redirect') || '';
        if (redirect) {
          var field = document.querySelector('form[data-instatic-auth="login"] input[name="redirect"]');
          if (field) field.value = redirect;
        }
      } catch (e) { /* no-op */ }
    })();
  </script>
  <script type="module" src="/_instatic/visitor-auth.js" defer></script>
</body>
</html>`

/**
 * Built-in fallback register page — the sibling of the login fallback.
 *
 * Served inline by the visitor-auth middleware on a direct GET to `/register`
 * when no published page exists there (mirrors the login fallback in D6).
 * Same minimal self-contained styling as the login page; the form is wired to
 * the visitor-auth runtime via `data-instatic-auth="register"`.
 */
export const BUILT_IN_REGISTER_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Create your account</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f4f5f7;
      color: #1a1d21;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      -webkit-font-smoothing: antialiased;
    }
    main { width: 100%; max-width: 24rem; }
    .card { background: #ffffff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.04); }
    h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1.25rem; font-weight: 600; }
    label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.375rem; }
    .field { margin-bottom: 1rem; }
    input[type="email"], input[type="password"], input[type="text"] {
      width: 100%; padding: 0.625rem 0.75rem; font-size: 1rem; color: #1a1d21;
      background: #ffffff; border: 1px solid #d0d5dd; border-radius: 8px; outline: none;
    }
    input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18); }
    button[type="submit"] {
      width: 100%; padding: 0.625rem 1rem; font-size: 1rem; font-weight: 600;
      color: #ffffff; background: #1a1d21; border: none; border-radius: 8px; cursor: pointer; margin-top: 0.25rem;
    }
    button[type="submit"]:hover { background: #303439; }
    button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }
    .instatic-auth-error { color: #b91c1c; background: #fef2f2; border: 1px solid #fee2e2; border-radius: 8px; padding: 0.5rem 0.75rem; font-size: 0.875rem; margin-bottom: 1rem; display: none; }
    .instatic-auth-error:not(:empty) { display: block; }
    .links { margin-top: 1.25rem; font-size: 0.875rem; }
    a { color: #4f46e5; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .hint { font-size: 0.8125rem; color: #667085; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>Create your account</h1>
      <form data-instatic-auth="register" novalidate>
        <div class="field">
          <label for="instatic-email">Email</label>
          <input id="instatic-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="instatic-name">Display name <span class="hint">(optional)</span></label>
          <input id="instatic-name" name="displayName" type="text" autocomplete="name" maxlength="200">
        </div>
        <div class="field">
          <label for="instatic-password">Password</label>
          <input id="instatic-password" name="password" type="password" autocomplete="new-password" required>
          <div class="hint">At least 8 characters.</div>
        </div>
        <div class="field">
          <label for="instatic-confirm">Confirm password</label>
          <input id="instatic-confirm" name="confirm-password" type="password" autocomplete="new-password" required>
        </div>
        <input type="hidden" name="redirect" value="">
        <div class="instatic-auth-error" role="alert"></div>
        <button type="submit">Create account</button>
      </form>
      <div class="links">
        <a href="/login">Already have an account? Sign in</a>
      </div>
    </div>
  </main>
  <script>
    (function () {
      try {
        var params = new URLSearchParams(window.location.search);
        var redirect = params.get('redirect') || '';
        if (redirect) {
          var field = document.querySelector('form[data-instatic-auth="register"] input[name="redirect"]');
          if (field) field.value = redirect;
        }
      } catch (e) { /* no-op */ }
    })();
  </script>
  <script type="module" src="/_instatic/visitor-auth.js" defer></script>
</body>
</html>`

/**
 * Built-in fallback "no access" page (D17).
 *
 * Served inline by the visitor-auth middleware when a LOGGED-IN visitor hits a
 * page restricted to a group they are NOT a member of. Anonymous visitors get
 * the login redirect instead (they may simply need to sign in) — this page is
 * specifically for the authenticated-but-unauthorized case, so it links to
 * login + register + home rather than redirecting (they're already signed in)
 * or 404-ing (don't hide the page's existence).
 *
 * Same minimal self-contained styling as the login/register fallbacks; no
 * form, so no visitor-auth runtime script is needed.
 */
export const BUILT_IN_NO_ACCESS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>No access</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f4f5f7;
      color: #1a1d21;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      -webkit-font-smoothing: antialiased;
    }
    main { width: 100%; max-width: 24rem; text-align: center; }
    .card { background: #ffffff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 3px rgba(16, 24, 40, 0.08), 0 1px 2px rgba(16, 24, 40, 0.04); }
    h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 0.75rem; font-weight: 600; }
    p { font-size: 0.9375rem; line-height: 1.5; color: #475467; margin: 0 0 1.5rem; }
    .links { display: flex; flex-direction: column; gap: 0.5rem; }
    a {
      display: inline-block;
      padding: 0.5rem 1rem;
      font-size: 0.9375rem;
      font-weight: 500;
      color: #4f46e5;
      background: #eef2ff;
      border-radius: 8px;
      text-decoration: none;
    }
    a:hover { background: #e0e7ff; }
    a.secondary { color: #475467; background: #f2f4f7; }
    a.secondary:hover { background: #e4e7ec; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <h1>You don't have access to this page</h1>
      <p>You're signed in, but this page is restricted to a member group you're not part of.</p>
      <div class="links">
        <a href="/">Go to home page</a>
        <a class="secondary" href="/login">Sign in with a different account</a>
        <a class="secondary" href="/register">Create an account</a>
      </div>
    </div>
  </main>
</body>
</html>`

/**
 * Browser runtime for CMS-native and member forms — shipped through the
 * module-JS channel: `base.form`'s render() returns this string as `js` when
 * `mode` is `cms` or `member`, the publisher dedupes it per moduleId, and
 * published pages load it from `/_instatic/module-js/base.form.js`. One
 * string serves both modes because the channel keeps one script per module.
 *
 * A member form is a real `<form method="post" action="/_instatic/members/…">`
 * and still works with scripts off; this runtime upgrades it to an in-place
 * submit with per-field errors.
 *
 * Channel authoring contract (see RenderOutput.js):
 *   - self-contained vanilla IIFE, no framework runtime;
 *   - document-level event delegation, because hole fragments insert CMS
 *     forms into the DOM after load (forms present at load are attached
 *     eagerly; late-inserted forms attach on first focus or submit);
 *   - idempotent (window.__instaticFormRuntimeLoaded guard);
 *   - per-form identity: `data-instatic-form-id`, `data-instatic-page-id`,
 *     and `data-instatic-page-token` are stamped onto each <form> tag by
 *     `stampFormPageTokens` (server/forms/formRuntime.ts) for baked pages
 *     AND hole fragments.
 */
export const FORM_RUNTIME_JS = `(() => {
  if (window.__instaticFormRuntimeLoaded) return;
  window.__instaticFormRuntimeLoaded = true;

  const FORM_SELECTOR = 'form[data-instatic-form-mode="cms"][data-instatic-form-id], form[data-instatic-form-mode="member"][data-instatic-form-id]';

  for (const form of document.querySelectorAll(FORM_SELECTOR)) attachForm(form);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || form.tagName !== 'FORM' || !form.matches(FORM_SELECTOR)) return;
    event.preventDefault();
    attachForm(form);
    if (isMemberForm(form)) submitMemberForm(form, event.submitter);
    else submitForm(form);
  });

  // Hole fragments insert forms after load. Attach them as they arrive, so
  // their labels are wired and their success/error messages are hidden
  // before the visitor sees them.
  if (typeof MutationObserver === 'function') {
    new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) {
          if (added.nodeType !== 1) continue;
          if (added.matches(FORM_SELECTOR)) attachForm(added);
          for (const form of added.querySelectorAll(FORM_SELECTOR)) attachForm(form);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Fallback for a form the observer missed: attach on first interaction.
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    const form = target && target.closest ? target.closest(FORM_SELECTOR) : null;
    if (form) attachForm(form);
  });

  function isMemberForm(form) {
    return form.getAttribute('data-instatic-form-mode') === 'member';
  }

  function attachForm(form) {
    if (form.__instaticFormRuntimeAttached) return;
    form.__instaticFormRuntimeAttached = true;
    form.__instaticFormAttachedAt = Date.now();
    connectLabels(form);
    prepareMessages(form);
    if (isMemberForm(form)) fillMemberToken(form);
    else prefetchChallenge(form);
  }

  // ── Member forms ─────────────────────────────────────────────────────────

  // Some member pages are opened with a value in their address: ?token=… from
  // an emailed link, ?request=… from an app that wants to sign the member in.
  // The form posts it back.
  function fillMemberToken(form) {
    const input = form.querySelector('input[data-instatic-member-link-param]');
    if (!input) return;
    const name = input.getAttribute('data-instatic-member-link-param') || '';
    input.value = new URLSearchParams(window.location.search).get(name) || '';
  }

  // submitter is the button that was pressed. A button with a name sends its
  // value with the form, which is how a two-button form (Allow, Cancel)
  // says which one it was.
  async function submitMemberForm(form, submitter) {
    const tokenInput = form.querySelector('input[data-instatic-member-link-param]');
    if (tokenInput && !tokenInput.value) {
      setState(form, 'error', tokenInput.name === 'request'
        ? 'This page was opened without a sign-in request. Start again from the app.'
        : 'This link is incomplete. Open the link from your email again.');
      return;
    }
    setBusy(form, true);
    setState(form, 'pending', 'Sending...');
    try {
      const response = await fetch(form.getAttribute('action') || '', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(memberValues(form, submitter)),
      });
      const body = await readJson(response);
      if (!response.ok || !body.ok) {
        const error = body && body.error && typeof body.error === 'object' ? body.error : {};
        const field = typeof error.field === 'string' ? error.field : '';
        setState(form, 'error', typeof error.message === 'string' && error.message ? error.message : 'Something went wrong. Try again.', field);
        return;
      }
      // An approved or refused app: the answer goes to the app's own address,
      // which the server checked against the ones registered for it.
      if (typeof body.appRedirect === 'string' && body.appRedirect) {
        window.location.assign(body.appRedirect);
        return;
      }
      const next = memberDestination(form, body.code, body.landing);
      if (next) {
        window.location.assign(next);
        return;
      }
      setState(form, 'success', form.getAttribute('data-instatic-success-message') || 'Done.');
      // A saved profile keeps its values on screen; everything else clears.
      if (body.code !== 'updated') form.reset();
      fillMemberToken(form);
    } catch (_err) {
      setState(form, 'error', 'Could not reach the site. Try again.');
    } finally {
      setBusy(form, false);
    }
  }

  // A ?next= value as a full address on this site, or '' when it points anywhere
  // else. The address is resolved the way the browser will resolve it (which
  // drops tabs and newlines, so "/<tab>/host" is really "//host") and kept
  // only if it stays on this origin.
  function sameSitePath(value) {
    if (!value || value.charAt(0) !== '/') return '';
    try {
      const url = new URL(value, window.location.origin);
      // The whole address, never the bare path: a path such as "//host" (from
      // "/.//host") would be read as another site when navigated to on its own.
      return url.origin === window.location.origin ? url.href : '';
    } catch (_err) {
      return '';
    }
  }

  // Flat text values, as the member endpoints read them. An unticked checkbox
  // sends nothing, so each checkbox also says it was on the form.
  function memberValues(form, submitter) {
    const values = {};
    if (submitter && submitter.name) values[submitter.name] = submitter.value;
    for (const [name, value] of new FormData(form).entries()) {
      if (typeof value !== 'string' || name === '_success' || name === '_error') continue;
      if (values[name] === undefined) values[name] = value;
    }
    for (const box of form.querySelectorAll('input[type="checkbox"][name]')) {
      values[box.name + '__present'] = '1';
    }
    return values;
  }

  // Where to go after a member action. Signing in honours ?next= (set when a
  // protected page sent the visitor here), then the form's own redirect, then
  // the site's "after signing in" page (landing). A change of who is signed in
  // with none of those reloads the page, so everything on it reflects the new
  // state.
  function memberDestination(form, code, landing) {
    const changesVisitor = code === 'signed_in' || code === 'signed_out' || code === 'deleted';
    if (code === 'signed_in') {
      const next = sameSitePath(new URLSearchParams(window.location.search).get('next') || '');
      if (next) return next;
    }
    const redirectUrl = form.getAttribute('data-instatic-success-redirect') || '';
    if (redirectUrl) return redirectUrl;
    if (code === 'signed_in') {
      const home = sameSitePath(typeof landing === 'string' ? landing : '');
      if (home) return home;
    }
    return changesVisitor ? window.location.pathname : '';
  }

  async function submitForm(form) {
    const formId = form.getAttribute('data-instatic-form-id') || '';
    const pageId = form.getAttribute('data-instatic-page-id') || '';
    const pageToken = form.getAttribute('data-instatic-page-token') || '';
    if (!formId || !pageId || !pageToken) {
      setState(form, 'error', 'This form is missing its published form link.');
      return;
    }

    setBusy(form, true);
    setState(form, 'pending', 'Sending...');

    try {
      const challenge = await takeChallenge(form);
      await postJson('/_instatic/form/submit', {
        pageId,
        formId,
        token: challenge.token,
        challenge: challenge.challenge,
        values: collectValues(form),
      });

      const redirectUrl = form.getAttribute('data-instatic-success-redirect') || '';
      if (redirectUrl) {
        window.location.assign(redirectUrl);
        return;
      }

      setState(form, 'success', form.getAttribute('data-instatic-success-message') || 'Thanks. Your submission was received.');
      if (form.getAttribute('data-instatic-reset-on-success') !== 'false') form.reset();
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Form submission failed.';
      setState(form, 'error', message);
    } finally {
      setBusy(form, false);
      if (form.isConnected) prefetchChallenge(form);
    }
  }

  function prefetchChallenge(form) {
    if (form.__instaticFormChallenge || form.__instaticFormChallengePromise) return form.__instaticFormChallengePromise;
    const request = requestChallenge(form)
      .then((challenge) => {
        // Stamp the arrival time with this browser's own clock: every later
        // lifetime check is then relative, so a visitor clock that disagrees
        // with the server's cannot make a live challenge look expired.
        challenge.receivedAt = Date.now();
        form.__instaticFormChallenge = challenge;
        form.__instaticFormChallengePromise = null;
        scheduleChallengeRefresh(form, challenge);
        return challenge;
      })
      .catch((err) => {
        form.__instaticFormChallenge = null;
        form.__instaticFormChallengePromise = null;
        throw err;
      });
    form.__instaticFormChallengePromise = request;
    request.catch(() => {});
    return request;
  }

  // Replace the held challenge 30 seconds before it expires, so a visitor who
  // spends minutes on the page still submits with one the server accepts.
  function scheduleChallengeRefresh(form, challenge) {
    clearChallengeRefresh(form);
    const lifetimeMs = challengeLifetimeMs(challenge);
    if (!Number.isFinite(lifetimeMs)) return;
    const delay = Math.min(2147483647, Math.max(lifetimeMs - 30000, lifetimeMs / 2));
    form.__instaticChallengeTimer = setTimeout(() => {
      form.__instaticChallengeTimer = null;
      if (!form.isConnected) return;
      form.__instaticFormChallenge = null;
      prefetchChallenge(form);
    }, delay);
  }

  function clearChallengeRefresh(form) {
    if (!form.__instaticChallengeTimer) return;
    clearTimeout(form.__instaticChallengeTimer);
    form.__instaticChallengeTimer = null;
  }

  async function takeChallenge(form) {
    clearChallengeRefresh(form);
    const existing = form.__instaticFormChallenge;
    form.__instaticFormChallenge = null;
    const challenge = existing && challengeIsFresh(existing) ? existing : await prefetchChallenge(form);
    form.__instaticFormChallenge = null;
    clearChallengeRefresh(form);
    await waitOutMinSubmitTime(form, challenge);
    return challenge;
  }

  // The server's time trap measures from the challenge's issue time. A visitor
  // who has already had the form for the minimum fill time can still be
  // holding a challenge younger than that (it was refreshed in the background,
  // or fetched at submit because the earlier one expired or never arrived), so
  // wait out the difference instead of posting into a certain rejection. A
  // submit sooner than the minimum after the form appeared is posted as-is and
  // the server rejects it, as the time trap intends.
  async function waitOutMinSubmitTime(form, challenge) {
    const minMs = Number(challenge.minSubmitSeconds) * 1000;
    if (!(minMs > 0)) return;
    const now = Date.now();
    if (now - form.__instaticFormAttachedAt < minMs) return;
    const remainingMs = challenge.receivedAt + minMs - now;
    if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs + 50));
  }

  function requestChallenge(form) {
    const formId = form.getAttribute('data-instatic-form-id') || '';
    const pageId = form.getAttribute('data-instatic-page-id') || '';
    const pageToken = form.getAttribute('data-instatic-page-token') || '';
    if (!formId || !pageId || !pageToken) {
      return Promise.reject(new Error('This form is missing its published form link.'));
    }
    return postJson('/_instatic/form/challenge', { pageId, formId, pageToken });
  }

  function challengeLifetimeMs(challenge) {
    return Number(challenge.expiresInSeconds) * 1000;
  }

  function challengeIsFresh(challenge) {
    const lifetimeMs = challengeLifetimeMs(challenge);
    return !Number.isFinite(lifetimeMs) || Date.now() < challenge.receivedAt + lifetimeMs - 10000;
  }

  async function postJson(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(body));
    return body;
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_err) {
      return { error: 'Form submission failed.' };
    }
  }

  function errorMessage(body) {
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.map((entry) => entry && entry.message ? entry.message : '').filter(Boolean).join('\\n') || 'Invalid form values.';
    }
    return typeof body.error === 'string' && body.error ? body.error : 'Form submission failed.';
  }

  function collectValues(form) {
    const values = {};
    const data = new FormData(form);
    for (const [name, value] of data.entries()) {
      const normalized = typeof value === 'string' ? value : value.name;
      if (values[name] === undefined) {
        values[name] = normalized;
      } else if (Array.isArray(values[name])) {
        values[name].push(normalized);
      } else {
        values[name] = [values[name], normalized];
      }
    }
    return values;
  }

  function connectLabels(form) {
    const elements = Array.from(form.querySelectorAll('label[data-instatic-label-target="auto"], input:not([type="hidden"]):not([data-instatic-honeypot]), textarea, select'));
    let counter = 0;
    for (const element of elements) {
      if (element.tagName.toLowerCase() !== 'label') continue;
      const index = elements.indexOf(element);
      const control = elements.slice(index + 1).find((candidate) => candidate.tagName.toLowerCase() !== 'label');
      if (!control) continue;
      if (!control.id) {
        counter += 1;
        control.id = 'instatic-form-' + safeToken(form.getAttribute('data-instatic-form-id') || 'form') + '-' + counter;
      }
      element.setAttribute('for', control.id);
    }
  }

  function safeToken(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'form';
  }

  function setBusy(form, busy) {
    form.setAttribute('aria-busy', busy ? 'true' : 'false');
    const buttons = form.querySelectorAll('button, input[type="submit"], input[type="button"]');
    for (const button of buttons) {
      if (busy) {
        if (button.disabled) button.setAttribute('data-instatic-was-disabled', 'true');
        button.disabled = true;
      } else if (!button.hasAttribute('data-instatic-was-disabled')) {
        button.disabled = false;
      } else {
        button.removeAttribute('data-instatic-was-disabled');
      }
    }
  }

  function prepareMessages(form) {
    for (const message of formMessages(form)) {
      if (!message.hasAttribute('data-instatic-default-text')) {
        message.setAttribute('data-instatic-default-text', message.textContent || '');
      }
      const kind = message.getAttribute('data-instatic-form-message') || 'status';
      if (kind === 'success' || kind === 'error') message.hidden = true;
    }
  }

  // \`field\` names the one control an error is about. Its control is marked
  // invalid, and the error goes to that field's own message when the form has
  // one (\`data-instatic-form-field\`), otherwise to the form's error message.
  function setState(form, state, text, field) {
    form.setAttribute('data-instatic-form-state', state);
    for (const control of form.querySelectorAll('[aria-invalid="true"]')) control.removeAttribute('aria-invalid');
    if (state === 'error' && field) {
      for (const control of form.querySelectorAll('[name]')) {
        if (control.name === field) control.setAttribute('aria-invalid', 'true');
      }
    }
    const all = formMessages(form);
    const fieldMessages = all.filter((message) => message.hasAttribute('data-instatic-form-field'));
    let shownAtField = false;
    for (const message of fieldMessages) {
      const show = state === 'error' && !!field && message.getAttribute('data-instatic-form-field') === field;
      message.textContent = show ? text : '';
      message.hidden = !show;
      if (show) shownAtField = true;
    }
    const messages = all.filter((message) => !message.hasAttribute('data-instatic-form-field'));
    const messageKind = state === 'error' ? 'error' : state === 'success' ? 'success' : 'status';
    const hasExactMessage = messages.some((message) => (message.getAttribute('data-instatic-form-message') || 'status') === messageKind);

    for (const message of messages) {
      if (!message.hasAttribute('data-instatic-default-text')) {
        message.setAttribute('data-instatic-default-text', message.textContent || '');
      }
      if (shownAtField) {
        message.hidden = true;
        continue;
      }
      const kind = message.getAttribute('data-instatic-form-message') || 'status';
      const shouldShow = kind === messageKind || (!hasExactMessage && kind === 'status');
      if (!shouldShow) {
        message.hidden = true;
        continue;
      }
      message.textContent = text || message.getAttribute('data-instatic-default-text') || '';
      message.hidden = !message.textContent;
    }
  }

  function formMessages(form) {
    const formId = form.getAttribute('data-instatic-form-id') || '';
    const inside = Array.from(form.querySelectorAll('[data-instatic-form-message]'));
    if (!formId) return inside;
    // A form repeated in a list shares its id with every other row, so a
    // row that holds messages uses only those. Any other form also gets the
    // messages placed elsewhere on the page and matched by form id.
    if (inside.length > 0) {
      const sameId = Array.from(document.querySelectorAll(FORM_SELECTOR)).filter((other) => {
        return other.getAttribute('data-instatic-form-id') === formId;
      });
      if (sameId.length > 1) return inside;
    }
    return Array.from(document.querySelectorAll('[data-instatic-form-message]')).filter((message) => {
      return form.contains(message) || message.getAttribute('data-instatic-form-id') === formId;
    });
  }
})();`

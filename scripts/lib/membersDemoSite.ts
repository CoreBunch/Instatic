/**
 * The pages of the members demo site.
 *
 * Every page here is made of the same pieces an author uses in the editor:
 * text, links and containers, forms in Members mode (built by the very
 * function the form setup panel's "Add …" button calls), member bindings,
 * show-when rules and page access rules. Nothing is custom code, so the demo
 * shows what the editor can build, and opening any page in the editor shows
 * how.
 */
import { PAIR_FORM_ACTION, memberFormAction, type AccessRule, type MemberSettings, type ShowWhen } from '@core/members'
import { flattenSubtree, createNode, type Page, type PageNode } from '@core/page-tree'
import { memberFormFragment } from '@core/memberForms'

type Nodes = Record<string, PageNode>

/** Collects the nodes of one page while helpers build its tree. */
class PageBuilder {
  readonly nodes: Nodes = {}

  private add(node: PageNode, children: PageNode[] = []): PageNode {
    node.children = children.map((child) => child.id)
    for (const child of children) child.parentId = node.id
    this.nodes[node.id] = node
    return node
  }

  box(role: string, children: PageNode[], extra: { tag?: string; showWhen?: ShowWhen } = {}): PageNode {
    return this.add(
      createNode('base.container', {
        tag: extra.tag ?? 'div',
        htmlAttributes: { 'data-demo': role },
        ...(extra.showWhen ? { showWhen: extra.showWhen } : {}),
      }),
      children,
    )
  }

  /** A list: `children` are rendered once per item of the source. */
  loop(sourceId: string, role: string, children: PageNode[]): PageNode {
    return this.add(createNode('base.loop', { sourceId, limit: 20, htmlAttributes: { 'data-demo': role } }), children)
  }

  text(text: string, tag = 'p', showWhen?: ShowWhen): PageNode {
    return this.add(createNode('base.text', { text, tag, ...(showWhen ? { showWhen } : {}) }))
  }

  link(text: string, href: string, showWhen?: ShowWhen): PageNode {
    return this.add(createNode('base.link', { text, href, ...(showWhen ? { showWhen } : {}) }))
  }

  /**
   * A form in Members mode, completed the way the editor's form setup panel
   * completes it: labelled inputs, an error and a success message, a button.
   */
  memberForm(
    action: string,
    formId: string,
    options: { redirectUrl?: string; showWhen?: ShowWhen; extraFields?: Array<{ name: string; label: string }> } = {},
  ): PageNode {
    const definition = memberFormAction(action)
    if (!definition) throw new Error(`Unknown member form action "${action}"`)
    const fragment = memberFormFragment(definition, formId, {
      fields: [...definition.fields], submit: true, messages: true, secondary: definition.choice !== undefined,
    })
    const form = createNode('base.form', {
      mode: 'member',
      memberAction: action,
      formId,
      successBehavior: options.redirectUrl ? 'redirect' : 'message',
      successMessage: definition.successMessage,
      redirectUrl: options.redirectUrl ?? '',
      ...(options.showWhen ? { showWhen: options.showWhen } : {}),
    })
    Object.assign(this.nodes, fragment.nodes)
    const children = fragment.rootIds.map((id) => fragment.nodes[id])

    // Extra profile fields go before the messages and the button.
    const extras = (options.extraFields ?? []).map((field) => {
      const inputId = `${formId}-${field.name}`
      const label = this.add(createNode('base.label', { text: field.label, targetMode: 'explicit', targetId: inputId }))
      const input = this.add(
        createNode('base.input', {
          fieldId: field.name,
          name: field.name,
          id: inputId,
          inputType: 'text',
          required: false,
          ...(action === 'profile' ? { value: `{member.profile.${field.name}}` } : {}),
        }),
      )
      return this.add(createNode('base.container', { tag: 'div' }), [label, input])
    })
    const firstNonField = children.findIndex((child) => child.moduleId !== 'base.container')
    const at = firstNonField === -1 ? children.length : firstNonField
    return this.add(form, [...children.slice(0, at), ...extras, ...children.slice(at)])
  }

  /** The site header: links that change with who is looking, and a sign-out button. */
  header(): PageNode {
    return this.box(
      'header',
      [
        this.link('Northlight Club', '/'),
        this.box(
          'nav',
          [
            this.link('Members area', '/members'),
            this.link('Pro lounge', '/pro'),
            this.link('Sign in', '/sign-in', { visitor: 'signedOut' }),
            this.link('Join', '/join', { visitor: 'signedOut' }),
            this.link('Account', '/account', { visitor: 'signedIn' }),
            this.memberForm('logout', 'sign-out', { redirectUrl: '/', showWhen: { visitor: 'signedIn' } }),
          ],
          { tag: 'nav' },
        ),
      ],
      { tag: 'header' },
    )
  }

  page(id: string, title: string, slug: string, body: PageNode[], access?: AccessRule): Page {
    const main = this.box('main', body, { tag: 'main' })
    const root = this.add(createNode('base.body', {}), [this.header(), main])
    root.id = 'root'
    // Re-key the root under its fixed id and repoint its children at it.
    delete this.nodes[Object.keys(this.nodes).find((key) => this.nodes[key] === root) ?? '']
    this.nodes.root = root
    // Stamp every child with its parent. Nodes from the form fragment arrive
    // detached, exactly as they do in the editor before they are inserted.
    for (const node of Object.values(this.nodes)) {
      for (const childId of node.children) this.nodes[childId].parentId = node.id
    }
    return { id, title, slug, rootNodeId: 'root', nodes: this.nodes, ...(access ? { access } : {}) } as Page
  }
}

const MEMBERS: AccessRule = { level: 'members', onDeny: 'login' }
const PRO: AccessRule = { level: 'tags', tags: ['pro'], onDeny: 'login' }
const SIGNED_IN: ShowWhen = { visitor: 'signedIn' }
const SIGNED_OUT: ShowWhen = { visitor: 'signedOut' }

/** A narrow page with one card: the shape of every form page. */
function formPage(
  id: string,
  title: string,
  slug: string,
  build: (b: PageBuilder) => PageNode[],
  access?: AccessRule,
): Page {
  const b = new PageBuilder()
  return b.page(id, title, slug, [b.box('card', build(b))], access)
}

/**
 * Move every page under a prefix: `join` becomes `<prefix>join`, the home page
 * `<prefix>home`, and every link and form redirect follows. The E2E suite
 * shares one site between its specs, so it seeds these pages under a prefix
 * of its own and never takes another spec's address.
 */
function withPrefix(pages: Page[], prefix: string): Page[] {
  const move = (path: string) => (path === '/' ? `/${prefix}home` : `/${prefix}${path.slice(1)}`)
  return pages.map((page) => ({
    ...page,
    id: `${prefix}${page.id}`,
    slug: page.slug === 'index' ? `${prefix}home` : `${prefix}${page.slug}`,
    nodes: Object.fromEntries(
      Object.entries(page.nodes).map(([id, node]) => {
        const props = { ...node.props }
        for (const key of ['href', 'redirectUrl']) {
          const value = props[key]
          if (typeof value === 'string' && value.startsWith('/')) props[key] = move(value)
        }
        return [id, { ...node, props }]
      }),
    ),
  }))
}

export function buildMembersDemoPages(prefix = ''): Page[] {
  const home = new PageBuilder()
  const homePage = home.page('demo_home', 'Home', 'index', [
    home.box('hero', [
      home.text('A members site, built in the editor', 'h1'),
      home.text('Hello {member.profile.name|there}. This whole site is ordinary pages: forms, text and links.', 'p'),
      home.box('actions', [
        home.link('Join the club', '/join', SIGNED_OUT),
        home.link('Sign in', '/sign-in', SIGNED_OUT),
        home.link('Go to your account', '/account', SIGNED_IN),
      ]),
    ]),
    home.box('grid', [
      home.box('card', [
        home.text('Members area', 'h2'),
        home.text('Open to anyone who is signed in. A visitor is sent to sign in first, then brought back.', 'p'),
        home.link('Open the members area', '/members'),
      ]),
      home.box('card', [
        home.text('Pro lounge', 'h2'),
        home.text('Only for members holding the tag "pro". Give yourself the tag under Users, Site members.', 'p'),
        home.link('Open the pro lounge', '/pro'),
      ]),
      home.box('card', [
        home.text('What you see depends on who you are', 'h2'),
        home.text('You are signed out, so this card shows the sign-in links.', 'p', SIGNED_OUT),
        home.text('You are signed in as {member.email}.', 'p', SIGNED_IN),
        home.text('Your tags: {member.tagList|none yet}.', 'p', SIGNED_IN),
        home.text('This line is only for members with the tag "pro".', 'p', { visitor: 'tags', tags: ['pro'] }),
      ]),
    ]),
  ])

  const join = formPage('demo_join', 'Join', 'join', (b) => [
    b.text('Join the club', 'h1'),
    b.text('Create an account. We email you a link to confirm your address.', 'p', SIGNED_OUT),
    b.memberForm('signup', 'join', { showWhen: SIGNED_OUT, extraFields: [{ name: 'company', label: 'Company (optional)' }] }),
    b.text('Already a member?', 'p', SIGNED_OUT),
    b.link('Sign in', '/sign-in', SIGNED_OUT),
    b.text('You are already signed in as {member.email}.', 'p', SIGNED_IN),
    b.link('Go to your account', '/account', SIGNED_IN),
  ])

  const signIn = formPage('demo_sign_in', 'Sign in', 'sign-in', (b) => [
    b.text('Sign in', 'h1'),
    b.memberForm('login', 'sign-in-form', { redirectUrl: '/account', showWhen: SIGNED_OUT }),
    b.link('Forgot your password?', '/forgot-password', SIGNED_OUT),
    b.text('Or get a sign-in link by email', 'h2', SIGNED_OUT),
    b.memberForm('link/request', 'sign-in-link', { showWhen: SIGNED_OUT }),
    b.link('Create an account', '/join', SIGNED_OUT),
    b.text('You are signed in as {member.email}.', 'p', SIGNED_IN),
    b.link('Go to your account', '/account', SIGNED_IN),
  ])

  const forgot = formPage('demo_forgot', 'Forgot password', 'forgot-password', (b) => [
    b.text('Forgot your password?', 'h1'),
    b.text('Enter your address and we email you a link to choose a new one.', 'p'),
    b.memberForm('password/forgot', 'forgot'),
    b.link('Back to sign in', '/sign-in'),
  ])

  const reset = formPage('demo_reset', 'Choose a new password', 'reset-password', (b) => [
    b.text('Choose a new password', 'h1'),
    b.text('This page is opened by the link in the reset email.', 'p'),
    b.memberForm('password/reset', 'reset', { redirectUrl: '/account' }),
  ])

  const welcome = formPage('demo_welcome', 'Confirm your address', 'welcome', (b) => [
    b.text('One last step', 'h1'),
    b.text('Confirm your address to finish creating your account.', 'p'),
    b.memberForm('verify', 'confirm', { redirectUrl: '/account' }),
  ])

  const signInLink = formPage('demo_sign_in_link', 'Finish signing in', 'sign-in-link', (b) => [
    b.text('Finish signing in', 'h1'),
    b.text('This page is opened by the link in the sign-in email.', 'p'),
    b.memberForm('link/confirm', 'sign-in-link-confirm', { redirectUrl: '/account' }),
  ])

  const confirmEmail = formPage('demo_confirm_email', 'Confirm your new address', 'confirm-email', (b) => [
    b.text('Confirm your new address', 'h1'),
    b.text('This page is opened by the link we sent to your new address.', 'p'),
    b.memberForm('email/confirm', 'confirm-new-email', { redirectUrl: '/account' }),
  ])

  const invitation = formPage('demo_invitation', 'Accept your invitation', 'invitation', (b) => [
    b.text('You have been invited', 'h1'),
    b.text('Choose a password to create your account.', 'p'),
    b.memberForm('invite/accept', 'invitation', { redirectUrl: '/account' }),
  ])

  const account = new PageBuilder()
  const accountPage = account.page(
    'demo_account',
    'Account',
    'account',
    [
      account.box('hero', [
        account.text('Your account', 'h1'),
        account.text('Signed in as {member.email}. Tags: {member.tagList|none yet}.', 'p'),
      ]),
      account.box('grid', [
        account.box('card', [
          account.text('Profile', 'h2'),
          account.memberForm('profile', 'profile', { extraFields: [{ name: 'company', label: 'Company' }] }),
        ]),
        account.box('card', [
          account.text('Password', 'h2'),
          account.memberForm('password/change', 'change-password'),
        ]),
        account.box('card', [
          account.text('Email address', 'h2'),
          account.text('We send a confirmation link to the new address.', 'p'),
          account.memberForm('email/change', 'change-email'),
        ]),
        account.box('card', [
          account.text('Connected apps', 'h2'),
          account.text('Apps you signed in to with this account. Disconnect one to sign it out.', 'p'),
          // A list of the member's own apps; every row carries a form that
          // sends that row's id back.
          account.loop('members.apps', 'apps', [
            account.box('app', [
              account.text('{currentEntry.name} on {currentEntry.device|a device}', 'h3'),
              account.text('Connected {currentEntry.connectedOn}. Last used {currentEntry.lastUsedOn|not yet}.', 'p'),
              account.memberForm('apps/disconnect', 'disconnect-app', { redirectUrl: '/account' }),
            ]),
          ]),
        ]),
        account.box('card', [
          account.text('Delete account', 'h2'),
          account.text('This removes your account for good.', 'p'),
          account.memberForm('delete', 'delete-account', { redirectUrl: '/' }),
        ]),
      ]),
    ],
    MEMBERS,
  )

  const members = formPage(
    'demo_members',
    'Members area',
    'members',
    (b) => [
      b.text('Members area', 'h1'),
      b.text('Welcome, {member.profile.name|member}. Only signed-in members can open this page.', 'p'),
      b.text('It is rendered for you on each visit and is never written to the public static files.', 'p'),
      b.link('Try the pro lounge', '/pro'),
    ],
    MEMBERS,
  )

  const pro = formPage(
    'demo_pro',
    'Pro lounge',
    'pro',
    (b) => [
      b.text('Pro lounge', 'h1'),
      b.text('You hold the tag "pro", {member.profile.name|member}. A shop plugin would grant this tag after a purchase.', 'p'),
      b.link('Back to the members area', '/members'),
    ],
    PRO,
  )

  // Opened by an app that wants to sign the member in. Members only, so a
  // signed-out visitor is sent to sign in and comes back here.
  const approveApp = formPage(
    'demo_approve_app',
    'Approve an app',
    'approve-app',
    (b) => [
      b.text('Sign in to {member.appRequest.name|an app}?', 'h1'),
      b.text('It runs on {member.appRequest.device|a device} ({member.appRequest.returnsTo|your device}) and asks for: {member.appRequest.access|your account}.', 'p'),
      b.text('You are signed in as {member.email|a member}.', 'p'),
      b.memberForm('apps/approve', 'approve-app'),
    ],
    MEMBERS,
  )

  const pairBuilder = new PageBuilder()
  const pairForm = pairBuilder.memberForm(PAIR_FORM_ACTION, 'device-approval')
  const pairPage = pairBuilder.page('demo_app_pair', 'App connection', 'connect-app', [pairForm])
  // A focused, installation-owned page. Its typography, spacing and controls
  // remain normal node styles in the inspector.
  const root = pairPage.nodes[pairPage.rootNodeId]
  const header = root.children.shift()!
  for (const id of flattenSubtree(pairPage, header)) delete pairPage.nodes[id]
  const main = pairPage.nodes[root.children[0]]
  main.inlineStyles = { minHeight: '100svh', boxSizing: 'border-box', display: 'grid', placeItems: 'center',
    margin: '0', maxWidth: 'none', padding: '24px', backgroundColor: '#f3f3f0', color: '#171817',
    fontFamily: 'system-ui, sans-serif', lineHeight: '1.5' }
  pairForm.inlineStyles = { width: 'min(100%, 440px)', boxSizing: 'border-box', padding: 'clamp(24px, 5vw, 40px)',
    borderRadius: '26px', border: '1px solid #deded9', backgroundColor: '#ffffff',
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.06)', margin: '0' }
  for (const groupId of pairForm.children) {
    const group = pairPage.nodes[groupId]
    group.inlineStyles = { display: 'grid', gap: '12px' }
    for (const id of group.children) {
      const node = pairPage.nodes[id]
      const attrs = node.props.htmlAttributes as Record<string, string> | undefined
      const part = attrs?.['data-approval-part']
      if (node.moduleId === 'base.text') {
        node.inlineStyles = { margin: '0', fontSize: '16px', color: '#50514d', overflowWrap: 'anywhere' }
        if (node.props.tag === 'h1') Object.assign(node.inlineStyles, {
          fontSize: 'clamp(27px, 4vw, 36px)', lineHeight: '1.12', letterSpacing: '-0.045em', color: '#171817' })
        if (part === 'label') Object.assign(node.inlineStyles, { fontSize: '13px', fontWeight: '650', marginBottom: '-8px' })
        if (part === 'code') Object.assign(node.inlineStyles, { padding: '16px', textAlign: 'center', margin: '6px 0',
          borderRadius: '12px', backgroundColor: '#f1f1ee', color: '#171817', letterSpacing: '0.12em',
          fontFamily: 'ui-monospace, monospace', fontSize: '24px', fontWeight: '600' })
      }
      if (node.moduleId === 'base.label') node.inlineStyles = { fontSize: '14px', fontWeight: '600', marginBottom: '-6px' }
      if (node.moduleId === 'base.input') node.inlineStyles = { minWidth: '0', padding: '12px 14px', font: 'inherit',
        borderRadius: '10px', border: '1px solid #cccfc8', boxShadow: '0 1px 3px rgba(0,0,0,.08)' }
      if (node.moduleId === 'base.submit') {
        const secondary = node.props.value === 'deny'
        node.inlineStyles = { padding: '12px 16px', font: 'inherit', fontWeight: '600', cursor: 'pointer',
          borderRadius: '10px', border: '1px solid #212220', color: secondary ? '#171817' : '#fff',
          backgroundColor: secondary ? '#fff' : '#212220' }
      }
    }
  }

  const pages = [
    homePage, join, signIn, forgot, reset, welcome, signInLink, confirmEmail, invitation, accountPage, members, pro,
    approveApp, pairPage,
  ]
  return prefix === '' ? pages : withPrefix(pages, prefix)
}

/** The demo page behind each member setting, by slug. */
const MEMBER_PAGE_SLUGS = {
  login: 'sign-in',
  afterLogin: 'account',
  verify: 'welcome',
  reset: 'reset-password',
  magic: 'sign-in-link',
  invite: 'invitation',
  emailChange: 'confirm-email',
  appSignIn: 'approve-app',
  appPair: 'connect-app',
} as const

/** Who can join, and which of the demo pages each member link opens. Settings name a page by id. */
export function membersDemoSettings(prefix = ''): MemberSettings {
  const idBySlug = new Map(buildMembersDemoPages(prefix).map((page) => [page.slug, page.id]))
  const pages: MemberSettings['pages'] = {}
  for (const [key, slug] of Object.entries(MEMBER_PAGE_SLUGS)) {
    const id = idBySlug.get(`${prefix}${slug}`)
    if (id) pages[key as keyof typeof MEMBER_PAGE_SLUGS] = id
  }
  return {
    signupMode: 'open',
    profileFields: [
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'company', label: 'Company', type: 'text', required: false },
    ],
    pages,
  }
}

/** One stylesheet for the whole demo. Elements are marked with `data-demo`, set in the editor's Attributes view. */
export const MEMBERS_DEMO_CSS = `
:root { color-scheme: light; --ink: #16181d; --muted: #5b6270; --line: #e3e6ec; --paper: #f6f7f9; --accent: #2f5bea; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
/* The form runtime hides a message with the hidden attribute; layout rules below must not undo that. */
[hidden] { display: none !important; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
[data-demo="header"] { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 32px; background: #fff; border-bottom: 1px solid var(--line); }
[data-demo="header"] > a { font-weight: 700; color: var(--ink); }
[data-demo="nav"] { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
[data-demo="nav"] form { margin: 0; display: inline-flex; }
[data-demo="main"] { max-width: 960px; margin: 0 auto; padding: 48px 24px 96px; display: grid; gap: 32px; }
[data-demo="hero"] h1 { margin: 0 0 8px; font-size: 40px; line-height: 1.1; letter-spacing: -0.02em; }
[data-demo="hero"] p { margin: 0; color: var(--muted); font-size: 18px; }
[data-demo="actions"] { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
[data-demo="actions"] a { padding: 10px 18px; border-radius: 999px; background: var(--ink); color: #fff; font-weight: 600; }
[data-demo="actions"] a + a { background: #fff; color: var(--ink); border: 1px solid var(--line); }
[data-demo="grid"] { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; align-items: start; }
[data-demo="card"] { display: grid; gap: 12px; padding: 28px; background: #fff; border: 1px solid var(--line); border-radius: 16px; }
[data-demo="main"] > [data-demo="card"] { max-width: 420px; width: 100%; margin: 0 auto; box-sizing: border-box; }
[data-demo="card"] h1 { margin: 0; font-size: 28px; letter-spacing: -0.01em; }
[data-demo="card"] h2 { margin: 0; font-size: 18px; }
[data-demo="card"] p { margin: 0; color: var(--muted); }
[data-demo="apps"] { display: grid; gap: 12px; }
[data-demo="app"] { display: grid; gap: 6px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; }
[data-demo="app"] h3 { margin: 0; font-size: 16px; }
form { display: grid; gap: 14px; }
form > div { display: grid; gap: 6px; }
label { font-size: 14px; font-weight: 600; }
input { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink); }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
input[aria-invalid="true"] { border-color: #d43c3c; }
button[type="submit"] { font: inherit; font-weight: 600; padding: 11px 18px; border: 0; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
button[type="submit"]:disabled { opacity: 0.6; cursor: default; }
[data-demo="nav"] button[type="submit"] { padding: 0; background: none; color: var(--muted); font-weight: 400; }
[data-demo="nav"] button[type="submit"]:hover { color: var(--ink); text-decoration: underline; }
[data-instatic-form-message] { font-size: 14px; padding: 10px 12px; border-radius: 10px; }
[data-instatic-form-message="error"] { background: #fdecec; color: #a12727; }
[data-instatic-form-message="success"], [data-instatic-form-message="status"] { background: #e9f6ee; color: #1d6b3c; }
[data-instatic-form-message]:empty { display: none; }
`

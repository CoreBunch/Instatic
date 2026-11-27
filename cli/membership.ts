import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Page } from 'playwright-core'
import { openChromium } from './browser'

const Settings = Type.Object({
  settings: Type.Object({ signupMode: Type.String(), pages: Type.Record(Type.String(), Type.String()) }),
  pageOptions: Type.Array(Type.Object({
    id: Type.String(), publishedPath: Type.Union([Type.String(), Type.Null()]), membersOnly: Type.Boolean(), formActions: Type.Array(Type.String()),
  })),
  mailAvailable: Type.Boolean(), linkAvailable: Type.Boolean(),
})

function publishedPaths(settings: Static<typeof Settings>) {
  const find = (key: string) => settings.pageOptions.find(p => p.id === settings.settings.pages[key])
  const signup = settings.pageOptions.find(p => p.publishedPath && p.formActions.includes('signup'))
  const dashboard = find('afterLogin')
  return { signup: signup?.publishedPath, login: find('login')?.publishedPath, verify: find('verify')?.publishedPath,
    dashboard: dashboard?.publishedPath, protected: dashboard?.membersOnly }
}

async function submit(page: Page, action: string, email?: string, password?: string) {
  const form = page.locator('form[action="/_instatic/members/' + action + '"]').first()
  if (!await form.count()) throw new Error('Missing published ' + action + ' form at ' + new URL(page.url()).pathname)
  if (email) await form.locator('input[name=email]').fill(email)
  if (password) await form.locator('input[name=password]').fill(password)
  for (const field of await form.locator('input[type=text][required],input:not([type])[required],textarea[required]').all()) {
    if (await field.isVisible() && !(await field.inputValue())) await field.fill('Demo member')
  }
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/_instatic/members/' + action)
  await Promise.all([response, form.locator('button[type=submit],input[type=submit],button:not([type])').first().click()])
  await page.waitForLoadState('networkidle')
}

export async function checkMembership(origin: string, raw: unknown, live: boolean, output?: string) {
  if (!Value.Check(Settings, raw)) throw new Error('Unexpected member settings response')
  const paths = publishedPaths(raw)
  if (raw.settings.signupMode !== 'open' || !raw.mailAvailable || !raw.linkAvailable || !paths.protected ||
      !paths.login || !paths.signup || !paths.dashboard || !paths.verify) {
    throw new Error('Membership wiring incomplete: ' + JSON.stringify({ paths, signup: raw.settings.signupMode, mail: raw.mailAvailable, links: raw.linkAvailable }))
  }
  const inbox = process.env.INSTATIC_TEST_INBOX
  if (live && (!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname) || !inbox)) {
    throw new Error('Live signup requires a disposable loopback site and INSTATIC_TEST_INBOX containing captured verification links.')
  }
  const browser = await openChromium()
  const screenshots: string[] = []
  const dir = resolve(output ?? 'membership-' + randomUUID())
  try {
    const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'block' })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    const visit = async (path: string) => {
      const url = new URL(path, origin)
      if (url.origin !== origin) throw new Error('Expected a site-local path')
      return page.goto(url.href, { waitUntil: 'networkidle' })
    }
    const capture = async (name: string) => {
      await mkdir(dir, { recursive: true })
      const file = join(dir, name + '.png')
      await page.screenshot({ path: file })
      screenshots.push(file)
    }
    const denied = async () => {
      const res = await visit(paths.dashboard!)
      const path = new URL(page.url()).pathname
      const loginRedirect = path === paths.login && res?.ok()
      if (!loginRedirect && ![401, 403, 404].includes(res?.status() ?? 0)) throw new Error('Anonymous dashboard access was not denied')
    }
    await denied()
    for (const [path, action] of [[paths.login,'login'],[paths.signup,'signup'],[paths.verify,'verify']]) {
      await visit(path)
      if (!await page.locator('form[method="post" i][action="/_instatic/members/' + action + '"]').count()) throw new Error('Missing published ' + action + ' form at ' + path)
    }
    if (!live) return { passed: true, checked: 'Published wiring and anonymous dashboard guard', paths }
    const email = 'instatic-check-' + randomUUID() + '@example.invalid'
    const password = randomUUID() + 'aA9!'
    process.stderr.write('Test inbox: ' + email + '\n')
    await visit(paths.signup)
    await submit(page, 'signup', email, password)
    await capture('after-signup')
    const receiptPath = new URL(page.url()).pathname
    const feedback = await page.locator('[role=status]:visible, [data-instatic-form-message=success]:visible').allInnerTexts()
    if ([paths.signup, paths.login].includes(receiptPath) && !feedback.some(message => message.trim())) {
      throw new Error('Signup returned to a form without a visible confirmation message. Inspect ' + screenshots[0])
    }
    let link = ''
    for (let i = 0; i < 60 && !link; i++) {
      try { link = (await readFile(join(inbox!, email + '.url'), 'utf8')).trim() }
      catch (err) { if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT')) throw err }
      if (!link) await Bun.sleep(500)
    }
    if (!link || new URL(link).origin !== origin || new URL(link).pathname !== paths.verify) throw new Error('No matching verification link in the local test inbox')
    await visit(link)
    await submit(page, 'verify')
    const dashboard = async () => {
      const res = await visit(paths.dashboard!)
      if (!res?.ok() || new URL(page.url()).pathname !== paths.dashboard) throw new Error('Member could not open the dashboard')
      const session = await context.request.get('/_instatic/members/me')
      const member = Type.Object({ member: Type.Object({ email: Type.Literal(email) }) })
      if (!session.ok() || !Value.Check(member, await session.json())) throw new Error('Expected the new visitor to have a member session')
    }
    await dashboard()
    await capture('dashboard')
    await submit(page,'logout')
    await denied()
    await visit(paths.login)
    await submit(page,'login',email,password)
    await dashboard()
    return { passed:true, checked:'Signup, confirmation, members-only dashboard, logout, anonymous denial and returning login', paths, receipt: { path: receiptPath, feedback }, screenshots }
  } finally { await browser.close() }
}

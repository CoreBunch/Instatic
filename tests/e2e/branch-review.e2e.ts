import { mkdir } from 'node:fs/promises'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, OWNER_STATE_FILE, completeStepUp, loginAs } from './helpers'

/**
 * Merge review across two accounts (REVIEW-001).
 *
 *   1. The owner creates a branch and a site editor who cannot merge.
 *   2. The editor edits the home page on the branch, reads the review with
 *      before/after renders and highlights, comments, and requests a merge.
 *   3. The owner edits the same page on main (a conflict), reviews, comments,
 *      declines with a note.
 *   4. The editor sees the decline and requests again.
 *   5. The owner resolves the conflict, merges with a password step-up, and
 *      main's draft carries the branch's edit.
 *
 * Evidence lands under `.tmp/evidence/branch-review-*.png`.
 */

const EVIDENCE_DIR = '.tmp/evidence'
const VIEWPORT = { width: 1440, height: 900 }
const BRANCH_ID = 'launch-review'
const EDITOR = { email: 'review-editor.e2e@example.com', password: 'review-editor-pass-12345', name: 'Eli Editor' }
const BRANCH_TITLE = 'Home, launch edition'
const MAIN_TITLE = 'Home, main edition'

test.use({ viewport: VIEWPORT })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true })
})

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${EVIDENCE_DIR}/branch-review-${name}.png` })
}

/** Same-origin fetch from the page's session; branch-scoped when `branch` is set. */
async function api<T>(page: Page, path: string, init: { method?: string; body?: unknown; branch?: string } = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ path, init }) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (init.branch) headers['x-instatic-branch'] = init.branch
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'include',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = await res.text()
    const parse = (): unknown => {
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return { status: res.status, body: parse() as never }
  }, { path, init })
}

interface HomeRow {
  id: string
  slug: string
  cells: { title: string; body: { nodes: Record<string, { moduleId: string; props?: Record<string, unknown>; children?: string[] }>; rootNodeId: string } }
}

async function homeRow(page: Page, branch?: string): Promise<HomeRow> {
  const { status, body } = await api<{ rows: HomeRow[] }>(page, '/admin/api/cms/pages', { branch })
  expect(status).toBe(200)
  const home = body.rows.find((row) => row.slug === '' || row.slug === 'home') ?? body.rows[0]
  expect(home).toBeDefined()
  return home!
}

async function saveHome(page: Page, home: HomeRow, cells: HomeRow['cells'], branch?: string): Promise<void> {
  const { status } = await api(page, `/admin/api/cms/data/rows/${encodeURIComponent(home.id)}`, {
    method: 'PATCH',
    body: { cells: { ...home.cells, ...cells } },
    branch,
  })
  expect(status).toBe(200)
}

async function editorPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: ANONYMOUS_STATE, viewport: VIEWPORT })
  const page = await context.newPage()
  await loginAs(page, EDITOR.email, EDITOR.password)
  return page
}

test('owner prepares a branch and an editor without merge rights', async ({ page }) => {
  await page.goto('/admin/dashboard')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // Creating roles and users is step-up gated; re-verify the owner first.
  const stepUp = await api(page, '/admin/api/cms/auth/step-up', { method: 'POST', body: { password: OWNER.password } })
  expect(stepUp.status).toBe(200)
  // Step-up rotates the session token; later owner contexts must reuse it.
  await page.context().storageState({ path: OWNER_STATE_FILE })

  // The editor role edits pages (through the row API this spec uses) but
  // cannot manage branches, so it cannot merge. Reused across runs.
  const capabilities = [
    'dashboard.read', 'site.read', 'site.content.edit', 'site.structure.edit', 'site.style.edit', 'pages.edit', 'media.read',
    'content.create', 'content.edit.any', 'data.system.tables.read', 'data.system.tables.manage',
  ]
  const roleCreate = await api<{ role: { id: string } }>(page, '/admin/api/cms/roles', {
    method: 'POST',
    body: { name: 'Site editor (review)', slug: 'site-editor-review', description: 'Edits pages; asks for merges.', capabilities },
  })
  let roleId: string
  if (roleCreate.status === 201) {
    roleId = roleCreate.body.role.id
  } else {
    const roles = await api<{ roles: Array<{ id: string; slug: string }> }>(page, '/admin/api/cms/roles')
    const existing = roles.body.roles.find((entry) => entry.slug === 'site-editor-review')
    expect(existing, `role create answered ${roleCreate.status}: ${JSON.stringify(roleCreate.body)}`).toBeDefined()
    roleId = existing!.id
    const patched = await api(page, `/admin/api/cms/roles/${roleId}`, { method: 'PATCH', body: { capabilities } })
    expect(patched.status, `role patch answered ${patched.status}: ${JSON.stringify(patched.body)}`).toBe(200)
  }
  const user = await api(page, '/admin/api/cms/users', {
    method: 'POST',
    body: { email: EDITOR.email, displayName: EDITOR.name, password: EDITOR.password, roleId },
  })
  if (user.status !== 201) {
    const users = await api<{ users: Array<{ id: string; email: string }> }>(page, '/admin/api/cms/users')
    const existing = users.body.users.find((entry) => entry.email === EDITOR.email)
    expect(existing, `user create answered ${user.status}: ${JSON.stringify(user.body)}`).toBeDefined()
    const patched = await api(page, `/admin/api/cms/users/${existing!.id}`, { method: 'PATCH', body: { roleId } })
    expect(patched.status, `user patch answered ${patched.status}: ${JSON.stringify(patched.body)}`).toBe(200)
  }

  // A real home page, so the review has something to render: a hero with a
  // heading, a paragraph and a button.
  const home = await homeRow(page)
  const root = home.cells.body.rootNodeId
  const nodes = {
    ...home.cells.body.nodes,
    [root]: { ...home.cells.body.nodes[root]!, children: ['review-hero'] },
    'review-hero': { id: 'review-hero', moduleId: 'base.container', props: {}, children: ['review-heading', 'review-copy', 'review-cta'] },
    'review-heading': { id: 'review-heading', moduleId: 'base.text', props: { text: 'Ship your site faster', tag: 'h1' }, children: [] },
    'review-copy': { id: 'review-copy', moduleId: 'base.text', props: { text: 'A self-hosted CMS with a visual editor and a plugin system that runs in a sandbox.', tag: 'p' }, children: [] },
    'review-cta': { id: 'review-cta', moduleId: 'base.button', props: { label: 'Get started', href: '/pricing' }, children: [] },
  }
  await saveHome(page, home, { ...home.cells, title: 'Home', body: { ...home.cells.body, nodes } })

  // A clean branch for this run.
  await api(page, `/admin/api/cms/branches/${BRANCH_ID}`, { method: 'DELETE' })
  const created = await api(page, '/admin/api/cms/branches', { method: 'POST', body: { name: 'Launch review', id: BRANCH_ID } })
  expect(created.status).toBe(201)
})

test('the editor edits the branch, reads the review, comments and requests a merge', async ({ browser }) => {
  const page = await editorPage(browser)
  const home = await homeRow(page, BRANCH_ID)
  const heading = home.cells.body.nodes['review-heading']!
  const hero = home.cells.body.nodes['review-hero']!
  const nodes = {
    ...home.cells.body.nodes,
    'review-heading': { ...heading, props: { ...heading.props, text: 'Launch week starts Monday' } },
    'review-hero': { ...hero, children: [...(hero.children ?? []), 'review-note'] },
    'review-note': { id: 'review-note', moduleId: 'base.text', props: { text: 'Five features in five days, starting with branches.', tag: 'p' }, children: [] },
  }
  await saveHome(page, home, { ...home.cells, title: BRANCH_TITLE, body: { ...home.cells.body, nodes } }, BRANCH_ID)

  // The review page is where the branch strip's "Request merge…" lands.
  await page.goto(`/admin/branches/${BRANCH_ID}/review?branch=${BRANCH_ID}`)
  await expect(page.getByTestId('branch-review-title')).toHaveText(/Merge Launch review into main/)
  const strip = page.getByTestId('branch-strip')
  await expect(strip).toContainText('Launch review')
  // Without merge rights the strip's action reads as a request, not a merge.
  await expect(page.getByTestId('branch-strip-merge')).toHaveText(/Request merge/)
  const homeChange = page.getByTestId(`review-change-row:${home.id}`)
  await expect(homeChange).toBeVisible()
  // Both renders load (the frame host flips to loaded once measured).
  await expect(homeChange.locator('[data-loaded="true"]').first()).toBeVisible({ timeout: 30_000 })
  await expect(homeChange.locator('[data-loaded="true"]')).toHaveCount(2, { timeout: 30_000 })
  // The changed heading and the added paragraph are outlined in the branch
  // render, found by their node ids.
  await expect(homeChange.locator('[data-tone="changed"]')).toHaveCount(1)
  await expect(homeChange.locator('[data-tone="added"]')).toHaveCount(1)
  // Labels name the node the plan diffed (a text node here).
  await expect(homeChange.locator('[data-tone="changed"]')).toContainText('text')
  await shot(page, '1-editor-review')

  await page.getByTestId(`review-thread-row:${home.id}-input`).fill('New headline for launch week; the rest of the page is untouched.')
  await page.getByTestId(`review-thread-row:${home.id}-submit`).click()
  await expect(page.getByTestId(`review-thread-row:${home.id}-comment`)).toHaveCount(1)

  await page.getByTestId('review-request-open').first().click()
  await page.getByTestId('review-request-note').fill('Launch week home page. Please review before Monday.')
  await page.getByTestId('review-request-confirm').click()
  await expect(page.getByTestId('review-status').first()).toHaveText(/Awaiting review/)
  await expect(page.getByTestId('review-withdraw')).toBeVisible()
  await shot(page, '3-editor-requested')
  await page.context().close()
})

test('the owner sees a conflict, comments, and declines with a note', async ({ page }) => {
  // Main moves on the same page: a conflict on the title.
  await page.goto('/admin/dashboard')
  const home = await homeRow(page)
  await saveHome(page, home, { ...home.cells, title: MAIN_TITLE })

  await page.goto(`/admin/branches/${BRANCH_ID}/review?branch=${BRANCH_ID}`)
  await expect(page.getByTestId('branch-review-title')).toHaveText(/Merge Launch review into main/)
  await expect(page.getByTestId('review-status').first()).toHaveText(/Awaiting review · 1 conflict/)
  const conflict = page.getByTestId(`review-conflict-row:${home.id}`)
  await expect(conflict).toContainText('Both sides changed title')
  await expect(page.getByTestId('review-merge')).toBeDisabled()
  await expect(page.getByTestId(`review-thread-row:${home.id}-comment`)).toHaveCount(1)
  await shot(page, '4-owner-conflict')

  await page.getByTestId('review-thread-request-input').fill('Main got a new title in the meantime; I will take yours after you fix the excerpt.')
  await page.getByTestId('review-thread-request-submit').click()
  await expect(page.getByTestId('review-thread-request-comment')).toHaveCount(1)

  await page.getByTestId('review-decline-open').click()
  await page.getByTestId('review-decline-note').fill('Shorten the headline to fit the hero on mobile, then request again.')
  await page.getByTestId('review-decline-confirm').click()
  await expect(page.getByTestId('review-status').first()).toHaveText(/Changes requested/)
  await expect(page.getByTestId('review-decision')).toContainText('Shorten the headline')
  await shot(page, '5-owner-declined')
})

test('the editor sees the decline and requests again', async ({ browser }) => {
  const page = await editorPage(browser)
  await page.goto(`/admin/branches/${BRANCH_ID}/review?branch=${BRANCH_ID}`)
  await expect(page.getByTestId('branch-review-title')).toHaveText(/Changes requested on Launch review/)
  await expect(page.getByTestId('review-decision')).toContainText('Shorten the headline')
  await shot(page, '6-editor-declined')

  await page.getByTestId('review-request-open').first().click()
  await page.getByTestId('review-request-note').fill('Headline shortened. Ready for another look.')
  await page.getByTestId('review-request-confirm').click()
  await expect(page.getByTestId('review-status').first()).toHaveText(/Awaiting review/)
  await shot(page, '7-editor-requested-again')
  await page.context().close()
})

test('the owner resolves the conflict and merges with a step-up', async ({ page }) => {
  await page.goto(`/admin/branches/${BRANCH_ID}/review?branch=${BRANCH_ID}`)
  const home = await homeRow(page)
  await expect(page.getByTestId('review-merge')).toBeDisabled()
  await page.getByRole('radio', { name: 'Take branch' }).or(page.getByRole('button', { name: 'Take branch' })).first().click()
  await expect(page.getByTestId(`review-conflict-row:${home.id}`)).toContainText('Resolved: taking the branch')
  await expect(page.getByTestId('review-merge')).toBeEnabled()
  await shot(page, '8-owner-resolved')

  await page.getByTestId('review-merge').click()
  await completeStepUp(page, OWNER.password)
  await expect(page.getByText(/Merged Launch review into main/)).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/\/admin\/site/)
  await shot(page, '9-owner-merged')

  // Main's draft carries the branch's title; the branch is gone.
  const merged = await homeRow(page)
  expect(merged.cells.title).toBe(BRANCH_TITLE)
  const branches = await api<{ branches: Array<{ id: string }> }>(page, '/admin/api/cms/branches')
  expect(branches.body.branches.some((branch) => branch.id === BRANCH_ID)).toBe(false)

  await page.goto('/admin/users')
  await page.getByRole('radio', { name: 'Audit' }).or(page.getByRole('tab', { name: 'Audit' })).or(page.getByRole('button', { name: 'Audit' })).first().click()
  await expect(page.getByText(/was merged|review/i).first()).toBeVisible()
  await shot(page, '10-audit')
})

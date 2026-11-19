import { execFileSync } from 'node:child_process'
import { expect, type Page } from '@playwright/test'
import { OWNER } from './constants'

/**
 * A member site for a spec to work on.
 *
 * Member features run on pages the owner builds: there is no built-in
 * sign-in page and no built-in page for an emailed link. A spec that drives
 * a member flow therefore needs real pages, and gets them here: the members
 * demo site (`scripts/e2e-members-seed.ts`, the same builder as
 * `bun run demo:members`) under an address prefix of the run, imported,
 * published, and named in the member settings.
 *
 * The suite shares one site, so `remove()` takes the pages off again and
 * puts the member settings back as they were.
 */
export interface MemberSite {
  /** The address of one of the seeded pages, by its unprefixed slug. */
  path: (slug: string) => string
  /** Open the owner's step-up window on the admin session of `page`. */
  stepUp: () => Promise<void>
  /** Headers every state-changing admin call needs. */
  headers: { origin: string }
  /** The link in the newest captured email to `to` that this spec has not used yet. */
  emailedLink: (to: string) => Promise<string>
  remove: () => Promise<void>
}

interface SeededSite {
  pages: Array<{ id: string; slug: string; cells: Record<string, unknown> }>
  settings: Record<string, unknown>
}

/** `page` must be signed in to the admin as the owner. */
export async function seedMemberSite(
  page: Page,
  prefix: string,
  /** `assignPages: false` publishes the pages and leaves the member settings alone. */
  { assignPages = true }: { assignPages?: boolean } = {},
): Promise<MemberSite> {
  const headers = { origin: new URL(page.url()).origin }
  const admin = page.request
  const stepUp = async () => {
    const res = await admin.post('/admin/api/cms/auth/step-up', { headers, data: { password: OWNER.password } })
    expect(res.ok(), await res.text()).toBe(true)
  }

  const before = (await (await admin.get('/admin/api/cms/members/settings')).json()) as {
    settings: { pages: Record<string, string> }
    pageOptions: Array<{ id: string }>
  }
  // A run that died may have left a setting on a page that is gone; such a setting cannot be saved back.
  const existing = new Set(before.pageOptions.map((option) => option.id))
  const settingsBefore = {
    ...before.settings,
    pages: Object.fromEntries(Object.entries(before.settings.pages).filter(([, pageId]) => existing.has(pageId))),
  }
  const seeded = JSON.parse(
    execFileSync('bun', ['scripts/e2e-members-seed.ts', prefix], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
  ) as SeededSite

  await stepUp()
  // Pages are editor documents, so they arrive the way a site transfer brings them: as an import.
  const { tables } = (await (await admin.get('/admin/api/cms/data/tables')).json()) as { tables: Array<{ id: string }> }
  const now = new Date().toISOString()
  const imported = await admin.post('/admin/api/cms/import?strategy=merge-add', {
    headers,
    data: {
      schemaVersion: 1,
      exportedAt: now,
      tables: tables.filter((table) => table.id === 'pages'),
      rows: seeded.pages.map((seededPage) => ({
        ...seededPage,
        tableId: 'pages',
        status: 'draft',
        authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
        author: null, createdBy: null, updatedBy: null, publishedBy: null,
        createdAt: now, updatedAt: now, publishedAt: null, scheduledPublishAt: null, deletedAt: null,
      })),
    },
  })
  expect(imported.ok(), await imported.text()).toBe(true)
  const published = await admin.post('/admin/api/cms/publish', { headers })
  expect(published.ok(), await published.text()).toBe(true)
  if (assignPages) {
    const saved = await admin.put('/admin/api/cms/members/settings', { headers, data: seeded.settings })
    expect(saved.ok(), await saved.text()).toBe(true)
  }

  const seenMail = new Set<string>()
  async function emailedLink(to: string): Promise<string> {
    let link: string | undefined
    await expect
      .poll(async () => {
        const res = await admin.get(`/admin/api/cms/mail/activity?period=24h&q=${encodeURIComponent(to)}`)
        const { entries } = (await res.json()) as { entries: Array<{ id: string; to: string; body: string | null }> }
        const entry = entries.find((candidate) => candidate.to === to && !seenMail.has(candidate.id))
        link = entry?.body?.match(/https?:\/\/\S*token=[\w-]+/)?.[0]
        if (entry && link) seenMail.add(entry.id)
        return link
      }, { message: `an email with a link reaches ${to}`, timeout: 20_000 })
      .toBeTruthy()
    return link!
  }

  async function remove(): Promise<void> {
    await stepUp()
    for (const seededPage of seeded.pages) {
      const removed = await admin.delete(`/admin/api/cms/data/rows/${seededPage.id}`, { headers })
      expect(removed.ok(), await removed.text()).toBe(true)
    }
    const restored = await admin.put('/admin/api/cms/members/settings', { headers, data: settingsBefore })
    expect(restored.ok(), await restored.text()).toBe(true)
  }

  return { path: (slug) => `/${prefix}${slug}`, stepUp, headers, emailedLink, remove }
}

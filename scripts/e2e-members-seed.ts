/**
 * Prints the member pages the E2E suite seeds, as JSON on stdout:
 * `bun scripts/e2e-members-seed.ts <prefix>`.
 *
 * The pages are the members demo site (`scripts/lib/membersDemoSite.ts`),
 * built from the same editor pieces, moved under `<prefix>` so they never
 * take another spec's address. A spec runs this with Bun because the builder
 * imports the engine, which Playwright's own loader does not resolve.
 */
import { pageToCells } from '../src/core/data/pageFromRow'
import { buildMembersDemoPages, membersDemoSettings } from './lib/membersDemoSite'

const prefix = process.argv[2] ?? ''
if (!/^[a-z0-9-]+$/.test(prefix)) {
  console.error('usage: bun scripts/e2e-members-seed.ts <prefix>')
  process.exit(1)
}

process.stdout.write(
  JSON.stringify({
    pages: buildMembersDemoPages(prefix).map((page) => ({ id: page.id, slug: page.slug, cells: pageToCells(page) })),
    settings: membersDemoSettings(prefix),
  }),
)

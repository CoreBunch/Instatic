/**
 * A members demo site, ready to poke at: `bun run demo:members`.
 *
 * Builds the admin, creates a fresh database under `.tmp/`, seeds a small
 * published site whose sign-up, sign-in, account and members-only pages are
 * ordinary editor pages (see `scripts/lib/membersDemoSite.ts`), adds two
 * members, and serves it all on one local address.
 *
 * It is a development tool. The owner and member passwords below are fixed
 * and printed on start, the server listens on 127.0.0.1 only, and emails are
 * captured into Email → Activity instead of being sent. Every run starts from
 * an empty database; nothing outside `.tmp/members-demo-*` is touched.
 */
import { mkdir, rm } from 'node:fs/promises'
import { nanoid } from 'nanoid'
import { bunCommand, bunRunCommand } from './lib/bunCommand'
import { ensureDependencies } from './lib/ensureDependencies'
import { buildMembersDemoPages, MEMBERS_DEMO_CSS, membersDemoSettings } from './lib/membersDemoSite'
import { pageToCells } from '../src/core/data/pageFromRow'
import { hashPassword } from '../server/auth/tokens'
import { MAIN_SCOPE } from '../server/branches/scope'
import { devStackBunError } from '../server/bunVersion'
import { createDbClient } from '../server/db'
import { runMigrations } from '../server/db/runMigrations'
import { handleCmsRequest } from '../server/handlers/cms'
import { createMemberApp } from '../server/members/apps/store'
import { createMember, grantMemberTag, saveMemberSettings } from '../server/members/repository'
import { publishDraftSite } from '../server/publish/publishSite'
import { createDataRow, listDataRows, saveDataRowDraft } from '../server/repositories/data'
import { syncSystemRoles } from '../server/repositories/roles'
import { getDraftSite, saveDraftSite } from '../server/repositories/site'
import { findUserByEmail } from '../server/repositories/users'

const DATABASE_PATH = './.tmp/members-demo.db'
const UPLOADS_DIR = './.tmp/members-demo-uploads'
const PORT = process.env.DEMO_PORT ?? '3040'
const ORIGIN = `http://127.0.0.1:${PORT}`

/** Fixed, local-only accounts. Change them here, not in a live installation. */
const OWNER = { email: 'owner@demo.test', password: 'demo-owner-password' }
const MEMBER_PASSWORD = 'demo-member-password'
const MEMBERS = [
  { email: 'member@demo.test', name: 'Mia Member', tags: [] as string[] },
  { email: 'pro@demo.test', name: 'Paul Pro', tags: ['pro'] },
]

function log(message: string): void {
  console.error(`[members-demo] ${message}`)
}

// The accounts above have fixed, published passwords: never on a live installation.
if (process.env.NODE_ENV === 'production') {
  log('Refusing to run with NODE_ENV=production: the demo creates accounts with fixed, public passwords.')
  process.exit(1)
}

const bunError = devStackBunError(Bun.version)
if (bunError) {
  log(bunError)
  process.exit(1)
}
await ensureDependencies((message) => log(message))

await mkdir('./.tmp', { recursive: true })
for (const suffix of ['', '-shm', '-wal']) await rm(`${DATABASE_PATH}${suffix}`, { force: true })
await rm(UPLOADS_DIR, { force: true, recursive: true })

if (!process.argv.includes('--skip-build')) {
  log('building the admin (bun run build)')
  const build = Bun.spawnSync(bunRunCommand('build'), { stdout: 'inherit', stderr: 'inherit' })
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1)
}

// ── Seed, before the server starts, through the same functions it uses ─────
log('seeding the demo site')
const { db, migrations } = createDbClient(`sqlite:${DATABASE_PATH}`)
await runMigrations(db, migrations)
await syncSystemRoles(db)

// First-run setup, exactly as the setup screen does it.
const setupRequest = new Request('http://127.0.0.1/admin/api/cms/setup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ siteName: 'Northlight Club', email: OWNER.email, password: OWNER.password }),
})
const setup = await handleCmsRequest(setupRequest, db, { uploadsDir: UPLOADS_DIR })
if (setup.status !== 201) {
  log(`setup failed (${setup.status}): ${await setup.text()}`)
  process.exit(1)
}
const owner = await findUserByEmail(db, OWNER.email)
if (!owner) throw new Error('The owner account was not created')

const shell = await getDraftSite(db, MAIN_SCOPE)
if (!shell) throw new Error('Setup did not create a site')
await saveDraftSite(db, MAIN_SCOPE, {
  ...shell,
  files: [...shell.files, { id: nanoid(), path: 'styles/members-demo.css', type: 'style', content: MEMBERS_DEMO_CSS }],
})

// Setup made a home page; the demo's home page takes its place.
const existingPages = await listDataRows(db, MAIN_SCOPE, 'pages')
const existingHome = existingPages.find((row) => row.slug === 'index')
for (const page of buildMembersDemoPages()) {
  if (page.slug === 'index' && existingHome) {
    await saveDataRowDraft(db, MAIN_SCOPE, existingHome.id, { cells: pageToCells({ ...page, id: existingHome.id }), slug: 'index' }, owner.id)
  } else {
    await createDataRow(db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, owner.id)
  }
}

await saveMemberSettings(db, membersDemoSettings())
const passwordHash = await hashPassword(MEMBER_PASSWORD)
for (const member of MEMBERS) {
  const created = await createMember(db, { email: member.email, passwordHash, profile: { name: member.name }, verified: true })
  if (!created) continue
  for (const tag of member.tags) await grantMemberTag(db, { memberId: created.id, tag, source: 'admin', expiresAt: null })
}

// An app members can sign in to, for `bun run demo:member-app`.
const demoApp = await createMemberApp(db, {
  name: 'Demo terminal app',
  redirectUris: ['http://127.0.0.1/callback'],
  scopes: ['profile', 'access'],
  createdByUserId: owner.id,
})

await publishDraftSite(db, owner.id, UPLOADS_DIR)
await db.close()

// ── Serve ───────────────────────────────────────────────────────────────────
log(`starting on ${ORIGIN}`)
const server = Bun.spawn(bunCommand('server/index.ts'), {
  env: {
    ...process.env,
    PORT,
    HOST: '127.0.0.1',
    DATABASE_URL: `sqlite:${DATABASE_PATH}`,
    UPLOADS_DIR,
    STATIC_DIR: './dist',
    PUBLIC_ORIGIN: ORIGIN,
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

log('')
log(`Site:    ${ORIGIN}/`)
log(`Admin:   ${ORIGIN}/admin   ${OWNER.email} / ${OWNER.password}`)
for (const member of MEMBERS) {
  log(`Member:  ${member.email} / ${MEMBER_PASSWORD}${member.tags.length > 0 ? `   (tags: ${member.tags.join(', ')})` : ''}`)
}
log('Emails are captured, not sent: read them under Email → Activity in the admin.')
log('')
log('Sign an app in as a member (in a second terminal):')
log(`  bun run demo:member-app -- --site ${ORIGIN} --app ${demoApp.id}`)
log('')

let shuttingDown = false
function stopServer(signal: NodeJS.Signals = 'SIGTERM'): void {
  shuttingDown = true
  if (server.exitCode === null) server.kill(signal)
}
process.on('SIGINT', () => stopServer('SIGINT'))
process.on('SIGTERM', () => stopServer('SIGTERM'))

const code = await server.exited
if (!shuttingDown) log(`server exited with code ${code}`)
process.exit(code ?? 0)

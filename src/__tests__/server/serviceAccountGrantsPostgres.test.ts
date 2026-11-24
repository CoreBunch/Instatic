import { expect, test } from 'bun:test'
import { createDbClient } from '../../../server/db'
import { runMigrations } from '../../../server/db/runMigrations'
import { createUser } from '../../../server/repositories/users'
import { createAccount } from '../../../server/serviceAccounts/store'

const url = process.env.INSTATIC_TEST_POSTGRES_URL

test.skipIf(!url)('Postgres stores new and upgraded CLI grants as JSON arrays', async () => {
  const { db, migrations } = createDbClient(url!)
  try {
    await runMigrations(db, migrations)
    await db.transaction(async tx => {
      const owner = await createUser(tx, { email: crypto.randomUUID() + '@example.test', displayName: 'Owner',
        roleId: 'member', passwordHash: '!' })
      const capabilities = ['site.read', 'site.content.edit'] as const
      const id = await createAccount(tx, owner.id, { label: 'Editor', ttlHours: 1, capabilities: [...capabilities] })
      const stored = async () => (await tx`select jsonb_typeof(capabilities_json) as kind, capabilities_json
        from service_accounts where id = ${id}`).rows[0]
      expect(await stored()).toEqual({ kind: 'array', capabilities_json: capabilities })

      await tx`update service_accounts set capabilities_json = to_jsonb(cast(capabilities_json as text)) where id = ${id}`
      expect((await stored()).kind).toBe('string')
      const repair = migrations.find(migration => migration.id === '044_service_account_capability_arrays')!
      await tx.unsafe(repair.sql)
      expect(await stored()).toEqual({ kind: 'array', capabilities_json: capabilities })
      await tx`delete from service_accounts where id = ${id}`
      await tx`delete from users where id in (${id}, ${owner.id})`
    })
  } finally {
    await db.close()
  }
})

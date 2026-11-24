import { expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson } from '../helpers/capabilityHarness'

it('pages users in a stable order and counts the full search before limiting rows', async () => {
  const harness = await createCapabilityTestHarness()
  try {
    const cookie = await harness.setupOwner()
    for (let index = 0; index < 51; index++) {
      const id = String(index).padStart(2, '0')
      const email = `account${id}@example.test`
      const name = index === 50 ? 'Sample_Editor' : 'Sample Editor'
      await harness.db`
        insert into users (id, email, email_normalized, display_name, role_id, password_hash, created_at)
        values (${id}, ${email}, ${email}, ${name}, 'admin', '', '2026-01-01T00:00:00Z')
      `
    }
    const list = async (query: string) => {
      const res = await harness.cms(`/admin/api/cms/users?${query}`, { cookie })
      expect(res.status).toBe(200)
      return readJson<{ users: Array<{ id: string }>; offset: number; matching: number }>(res)
    }
    const first = await list('q=sample')
    expect(first.matching).toBe(51)
    expect(first.offset).toBe(0)
    expect(first.users).toHaveLength(50)
    const last = await list('q=SAMPLE&offset=50')
    expect(last.users.map((user) => user.id)).toEqual(['50'])
    expect(first.users.some((user) => user.id === '50')).toBe(false)
    const filtered = await list('q=_editor&offset=50')
    expect(filtered.offset).toBe(0)
    expect(filtered.matching).toBe(1)
    expect(filtered.users).toEqual(last.users)
  } finally {
    await harness.cleanup()
  }
})

import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

function credentialDirectory() {
  const local = process.env.LOCALAPPDATA
  const root = process.platform === 'win32' && local ? join(local, 'Instatic') : join(homedir(), '.instatic')
  return process.env.INSTATIC_CREDENTIAL_DIR || join(root, 'credentials')
}
function checkOwner(stat: Awaited<ReturnType<typeof lstat>>) {
  if (process.platform !== 'win32' && ((Number(stat.mode) & 0o077) || stat.uid !== process.getuid?.())) {
    throw new Error('Instatic credential storage must be private to the current user.')
  }
}
async function location(account: string) {
  const directory = credentialDirectory()
  if (!isAbsolute(directory)) throw new Error('INSTATIC_CREDENTIAL_DIR must be an absolute path')
  if (!/^svc_[a-f0-9-]{36}$/.test(account)) throw new Error('Invalid service account ID')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory()) throw new Error('Invalid Instatic credential directory')
  checkOwner(stat)
  return join(directory, account + '.json')
}
export async function saveCredential(account: string, data: string) {
  const file = await location(account)
  const temp = file + '.' + randomUUID()
  const handle = await open(temp, 'wx', 0o600)
  try {
    try { await handle.writeFile(data) } finally { await handle.close() }
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}
export async function readCredential(account: string) {
  const file = await location(account)
  try {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('Invalid credential file')
      checkOwner(stat)
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}
export async function forgetCredential(account: string) {
  await rm(await location(account), { force: true })
}

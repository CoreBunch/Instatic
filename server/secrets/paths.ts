import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function homeDir(): string {
  return process.env.HOME?.trim() || homedir()
}

export function perUserConfigDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homeDir(), 'Library', 'Application Support', 'instatic')
    case 'win32': {
      const appData = process.env.APPDATA?.trim() || join(homeDir(), 'AppData', 'Roaming')
      return join(appData, 'instatic')
    }
    case 'linux':
    default: {
      const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homeDir(), '.config')
      return join(configHome, 'instatic')
    }
  }
}

export function defaultMasterKeyPath(): string {
  return join(perUserConfigDir(), 'secret.key')
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

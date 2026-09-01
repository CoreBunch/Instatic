import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function homeDir(): string {
  return process.env.HOME?.trim() || homedir()
}

function dataDirFromEnv(): string | null {
  const override = process.env.INSTATIC_DATA_DIR?.trim()
  return override && override.length > 0 ? override : null
}

/**
 * Resolve the per-user data directory for Instatic local state.
 *
 *   Linux:   $XDG_DATA_HOME/instatic (default ~/.local/share/instatic)
 *   macOS:   ~/Library/Application Support/instatic
 *   Windows: %LOCALAPPDATA%\instatic
 *
 * The `INSTATIC_DATA_DIR` env var (if set) overrides the platform default and
 * is also used for the dev SQLite database location.
 */
export function perUserDataDir(): string {
  const override = dataDirFromEnv()
  if (override) return override
  switch (process.platform) {
    case 'darwin':
      return join(homeDir(), 'Library', 'Application Support', 'instatic')
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA?.trim()
        || join(homeDir(), 'AppData', 'Local')
      return join(localAppData, 'instatic')
    }
    case 'linux':
    default: {
      const dataHome = process.env.XDG_DATA_HOME?.trim()
        || join(homeDir(), '.local', 'share')
      return join(dataHome, 'instatic')
    }
  }
}

/** Absolute filesystem path to the dev SQLite database file. */
export function defaultDevDbPath(): string {
  return join(perUserDataDir(), 'dev.db')
}

/** `sqlite:` URL pointing at the per-user dev database. */
export function defaultDevDbUrl(): string {
  return `sqlite:${defaultDevDbPath()}`
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

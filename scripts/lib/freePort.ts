/**
 * Interactive port pre-flight for local dev/start scripts.
 *
 * `ensurePortFree(port, name)` probes the port. If something is already
 * listening, it looks up the holder(s), prints them, and asks the user
 * (via `prompt`) whether to kill them and take over. Default answer is
 * "yes" — `Enter` accepts. Anything else cancels and exits 1.
 *
 * macOS/Linux only — uses `lsof` and `ps`. The CMS isn't supported on
 * Windows for local dev today, so this is intentionally Unix-only.
 */

const decoder = new TextDecoder()

interface PortHolder {
  pid: number
  command: string
}

/**
 * Returns the PID(s) currently listening on `port` along with the
 * holding process's `comm` name. Empty array when the port is free.
 */
function findPortHolders(port: number): PortHolder[] {
  if (process.platform === 'win32') return []
  const lsof = Bun.spawnSync(
    ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  if (lsof.exitCode !== 0) return []

  const pids = decoder
    .decode(lsof.stdout)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)

  const holders: PortHolder[] = []
  for (const pid of pids) {
    const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const command =
      ps.exitCode === 0 ? decoder.decode(ps.stdout).trim() : '<unknown>'
    holders.push({ pid, command })
  }
  return holders
}

function probePort(port: number): 'free' | 'busy' {
  try {
    const probe = Bun.serve({ port, fetch: () => new Response() })
    probe.stop(true)
    return 'free'
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'EADDRINUSE') return 'busy'
    throw err
  }
}

function killHolder(holder: PortHolder, log: (msg: string) => void): boolean {
  try {
    process.kill(holder.pid, 'SIGTERM')
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'ESRCH') return true // already gone
    log(`failed to SIGTERM pid ${holder.pid}: ${String(err)}`)
    return false
  }
  // Wait briefly for graceful exit, then escalate.
  for (let i = 0; i < 20; i++) {
    Bun.spawnSync(['sleep', '0.1'])
    try {
      process.kill(holder.pid, 0)
    } catch {
      return true // gone
    }
  }
  try {
    process.kill(holder.pid, 'SIGKILL')
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'ESRCH') return true
    log(`failed to SIGKILL pid ${holder.pid}: ${String(err)}`)
    return false
  }
  return true
}

/**
 * Ensure `port` is free. If something is listening, prompt the user
 * whether to kill the holder(s) and take over. Exits the process with
 * code 1 if the user declines or if killing fails.
 *
 * `log` lets callers control the prefix ("[dev]" / "[start]") so output
 * stays consistent with the surrounding script.
 */
export async function ensurePortFree(
  port: number,
  name: string,
  log: (msg: string) => void,
): Promise<void> {
  if (probePort(port) === 'free') return

  const holders = findPortHolders(port)
  if (holders.length === 0) {
    if (process.platform === 'win32') {
      // On Windows we can't enumerate holders easily; just wait a bit
      // and re-probe in case a previous dev server is shutting down.
      for (let i = 0; i < 30; i++) {
        if (probePort(port) === 'free') return
        Bun.spawnSync(['cmd', '/c', 'timeout', '/t', '1', '/nobreak', '>nul', '2>&1'])
      }
    }
    log(`Port ${port} (${name}) is in use, but the holding process could not be identified.`)
    log(`Run \`lsof -i :${port} -P -n\` to inspect it manually.`)
    process.exit(1)
  }

  log(`Port ${port} (${name}) is in use by:`)
  for (const h of holders) {
    log(`  pid ${h.pid}  (${h.command})`)
  }

  const answer = prompt(`Kill ${holders.length === 1 ? 'it' : 'them'} and take over? [Y/n]`)
  const decision = (answer ?? '').trim().toLowerCase()
  const yes = decision === '' || decision === 'y' || decision === 'yes'

  if (!yes) {
    log('Aborted — leaving the existing process in place.')
    process.exit(1)
  }

  for (const h of holders) {
    log(`Killing pid ${h.pid} (${h.command})...`)
    if (!killHolder(h, log)) {
      log(`Could not free pid ${h.pid}. Aborting.`)
      process.exit(1)
    }
  }

  // Re-probe to confirm the OS has released the socket.
  for (let i = 0; i < 20; i++) {
    if (probePort(port) === 'free') return
    Bun.spawnSync(['sleep', '0.1'])
  }
  log(`Port ${port} is still busy after killing its holders. Aborting.`)
  process.exit(1)
}

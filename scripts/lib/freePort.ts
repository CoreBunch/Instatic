/**
 * Interactive port pre-flight for local dev/start scripts.
 *
 * `ensurePortFree(port, name)` probes the port. If something is already
 * listening, it looks up the holder(s), prints them, and asks the user
 * (via `prompt`) whether to kill them and take over. Default answer is
 * "yes" — `Enter` accepts. Anything else cancels and exits 1.
 *
 * Cross-platform: holder lookup shells out to `lsof` + `ps` on macOS/Linux
 * and to `netstat` + `tasklist` on Windows. Probing, killing, and the
 * wait/escalate loop use `Bun.serve`, signal-based `process.kill`, and
 * `Bun.sleepSync`, which behave the same on every platform.
 */

import { platform } from 'node:os'

const decoder = new TextDecoder()
const isWindows = platform() === 'win32'

interface PortHolder {
  pid: number
  command: string
}

/**
 * Returns the PID(s) currently listening on `port` along with the
 * holding process's name. Empty array when the port is free.
 */
function findPortHolders(port: number): PortHolder[] {
  return isWindows ? findWindowsPortHolders(port) : findUnixPortHolders(port)
}

function findUnixPortHolders(port: number): PortHolder[] {
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

  return [...new Set(pids)].map((pid) => ({ pid, command: unixProcessName(pid) }))
}

function unixProcessName(pid: number): string {
  const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm='], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (ps.exitCode !== 0) return '<unknown>'
  return decoder.decode(ps.stdout).trim() || '<unknown>'
}

function findWindowsPortHolders(port: number): PortHolder[] {
  // `netstat -ano` prints one row per socket: Proto, Local Address,
  // Foreign Address, State, PID. Match TCP rows in LISTENING state whose
  // local address ends in `:<port>` (covers 0.0.0.0, 127.0.0.1, [::], …).
  const netstat = Bun.spawnSync(['netstat', '-ano'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (netstat.exitCode !== 0) return []

  const pids = new Set<number>()
  for (const line of decoder.decode(netstat.stdout).split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue
    const local = cols[1]
    const localPort = Number(local.slice(local.lastIndexOf(':') + 1))
    if (localPort !== port) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }

  return [...pids].map((pid) => ({ pid, command: windowsProcessName(pid) }))
}

function windowsProcessName(pid: number): string {
  // `tasklist` CSV row: "ImageName","PID","Session","Session#","MemUsage".
  const tasklist = Bun.spawnSync(
    ['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  if (tasklist.exitCode !== 0) return '<unknown>'
  const match = decoder.decode(tasklist.stdout).trim().match(/^"([^"]+)"/)
  return match ? match[1] : '<unknown>'
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
    Bun.sleepSync(100)
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
    // Port is busy but we couldn't enumerate the holder (rare — usually a
    // permissions issue, or the lookup tool is unavailable). Fall through
    // to the manual message.
    const inspect = isWindows
      ? `netstat -ano | findstr :${port}`
      : `lsof -i :${port} -P -n`
    log(`Port ${port} (${name}) is in use, but the holding process could not be identified.`)
    log(`Run \`${inspect}\` to inspect it manually.`)
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
    Bun.sleepSync(100)
  }
  log(`Port ${port} is still busy after killing its holders. Aborting.`)
  process.exit(1)
}

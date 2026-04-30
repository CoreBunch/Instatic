import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import type { PublishFile } from '../../src/core/publishing/types'

export async function createTempWorkspace(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `${prefix}-`))
}

export async function removeTempWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export async function writePublishFiles(root: string, files: PublishFile[]): Promise<void> {
  for (const file of files) {
    const target = normalize(join(root, file.path))
    if (!target.startsWith(root)) throw new Error(`Refusing to write outside workspace: ${file.path}`)
    await mkdir(dirname(target), { recursive: true })
    const data = file.encoding === 'base64' ? Buffer.from(file.data, 'base64') : file.data
    await writeFile(target, data)
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}\n${stderr || stdout}`)
  }
  return { stdout, stderr }
}


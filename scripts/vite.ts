import { viteCommand } from './lib/bunCommand'

const child = Bun.spawn(viteCommand(...Bun.argv.slice(2)), {
  env: process.env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await child.exited)

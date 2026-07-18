import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { materializeSiteArtifact } from '../server/publish/siteArtifact'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: 'string', short: 'o', default: 'site-deploy' },
    'uploads-dir': { type: 'string', default: process.env.UPLOADS_DIR ?? 'uploads' },
    'allow-incomplete': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (values.help) {
  console.log(`Usage: bun run site:export [options]

Options:
  -o, --output <dir>       Railway deployment directory (default: site-deploy)
      --uploads-dir <dir>  Instatic uploads directory (default: uploads)
      --allow-incomplete   Export even when dynamic features need cloud services
  -h, --help               Show this help
`)
  process.exit(0)
}

const root = resolve(import.meta.dir, '..')
const outputDir = resolve(values.output)
const manifest = await materializeSiteArtifact({
  uploadsDir: resolve(values['uploads-dir']),
  outputDir,
  runtimeTemplateDir: resolve(root, 'site-runtime'),
  allowIncomplete: values['allow-incomplete'],
})

console.log(`Site artifact ${manifest.artifactId} exported to ${outputDir}`)
console.log(`Routes: ${manifest.routes.length}; uploaded files: ${manifest.uploadedFiles.length}`)
if (!manifest.deployment.portable) {
  console.warn(
    `Preview-only export: ${manifest.deployment.requirements.map((item) => item.code).join(', ')}`,
  )
}

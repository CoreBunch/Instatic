import manifest from '../../cli/package.json' with { type: 'json' }
// @ts-expect-error Bun's text loader embeds this source in single-file server builds.
import cli from '../../cli/instatic.ts' with { type: 'text' }

// @ts-expect-error Bun embeds this module beside the CLI entry point in the archive.
import canvas from '../../cli/canvas.ts' with { type: 'text' }

export const cliFilename = 'instatic-cli-' + manifest.version + '.tgz'
let packed: Promise<Blob> | undefined
export async function cliPackageResponse() {
  packed ??= new Bun.Archive({
    'package/package.json': JSON.stringify(manifest),
    'package/instatic.ts': cli,
    'package/canvas.ts': canvas,
  }, { compress: 'gzip' }).blob()
  return new Response(await packed, { headers: {
    'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="' + cliFilename + '"',
  } })
}

/**
 * `bun run sdk:pack [-- <version>]` — build the installable
 * `@instatic/plugin-sdk` package and its tarball under `.tmp/plugin-sdk/`.
 * The version defaults to the repo's; a release passes its tag's version.
 * See `scripts/lib/pluginSdkPackage.ts`.
 */
import { relative, resolve } from 'node:path'
import { buildPluginSdkPackage } from './lib/pluginSdkPackage'

const ROOT = resolve(import.meta.dir, '..')
const built = await buildPluginSdkPackage({ version: Bun.argv[2] })
console.warn(`[sdk:pack] ${relative(ROOT, built.tarballPath)} (@instatic/plugin-sdk ${built.version})`)

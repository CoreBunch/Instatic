import { valid } from 'semver'
import packageInfo from '../../package.json'
import type { BuildInfo } from '@core/updates'

// Compiled server artifacts embed their --version, independently of the
// checkout's manifest. Source/image builds use their configured release
// metadata, falling back to the actual package manifest rather than a guess.
declare const __INSTATIC_BUILD_VERSION__: string | undefined
declare const __INSTATIC_BUILD_REVISION__: string | undefined

const artifactVersion = typeof __INSTATIC_BUILD_VERSION__ === 'string' ? __INSTATIC_BUILD_VERSION__ : null
const artifactRevision = typeof __INSTATIC_BUILD_REVISION__ === 'string' ? __INSTATIC_BUILD_REVISION__ : null

export const buildInfo: BuildInfo = {
  version: valid(artifactVersion ?? process.env.INSTATIC_VERSION ?? packageInfo.version),
  revision: /^[a-f0-9]{40}$/i.test(artifactRevision ?? process.env.INSTATIC_REVISION ?? '')
    ? artifactRevision ?? process.env.INSTATIC_REVISION ?? null
    : null,
  source: artifactVersion ? 'artifact' : process.env.INSTATIC_VERSION ? 'environment' : 'package',
}

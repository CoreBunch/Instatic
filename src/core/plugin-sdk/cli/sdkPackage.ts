/**
 * Facts about the published `@instatic/plugin-sdk` package this CLI ships in.
 *
 * `scripts/build-plugin-sdk-package.ts` replaces `__INSTATIC_SDK_VERSION__`
 * with the package version at bundle time. Run from source inside the
 * Instatic checkout the constant is not defined, and the version is `null`:
 * that is how the CLI tells the two situations apart.
 *
 *   • Packaged (the installed package's bin): the plugin is its own project. It
 *     resolves `@instatic/plugin-sdk` through `node_modules`, so `init`
 *     writes a `package.json` and a `tsconfig.json`.
 *   • From source (the checkout's `instatic-plugin` script): the plugin sits inside the
 *     checkout, whose root `tsconfig.json` maps `@instatic/plugin-sdk` to
 *     `src/core/plugin-sdk`. A scaffold must NOT carry its own
 *     `tsconfig.json` there: Bun reads only the nearest one, which would
 *     hide that mapping.
 */
declare const __INSTATIC_SDK_VERSION__: string | undefined

export const SDK_PACKAGE_NAME = '@instatic/plugin-sdk'

export const SDK_PACKAGE_VERSION: string | null =
  typeof __INSTATIC_SDK_VERSION__ === 'string' ? __INSTATIC_SDK_VERSION__ : null

/** File name of the SDK tarball attached to the GitHub release of `version`. */
export function sdkTarballName(version: string): string {
  return `instatic-plugin-sdk-${version}.tgz`
}

/**
 * The dependency specifier a scaffolded plugin uses for the SDK: the tarball
 * attached to the Instatic release of the same version. It installs without
 * a registry and cannot be answered by anyone but this repository's releases.
 */
export function sdkTarballUrl(version: string): string {
  return `https://github.com/CoreBunch/Instatic/releases/download/v${version}/${sdkTarballName(version)}`
}

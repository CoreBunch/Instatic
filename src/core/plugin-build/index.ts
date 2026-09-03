/**
 * @core/plugin-build — the shared plugin-package builder.
 *
 * One `Bun.build`-backed pipeline behind two frontends: the CLI
 * (`instatic-plugin build|dev`) and the server-side site plugin build.
 * See `./buildPackage.ts` for the core entry.
 */
export {
  buildPluginPackage,
  findEntrypoint,
  listFrontendSources,
  type BuildPackageInput,
  type BuildPackageResult,
} from './buildPackage'
export { assertNoBuildTimeMacros, type ImportResolverPolicy } from './containment'
export {
  bundleEntrypoint,
  formatBuildLog,
  HOST_RUNTIME_EXTERNALS,
  type BuildLogLike,
  type BundleOptions,
} from './bundle'
export { generateModulesFacade, generateSandboxFacade } from './facades'

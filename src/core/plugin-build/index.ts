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
export type { ImportResolverPolicy } from './containment'
export { bundleEntrypoint, HOST_RUNTIME_EXTERNALS, type BundleOptions } from './bundle'
export { generateModulesFacade, generateSandboxFacade } from './facades'

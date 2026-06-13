/**
 * Typed api-call schemas — the SINGLE SOURCE OF TRUTH for the set of RPC
 * targets the host accepts from a plugin worker.
 *
 * `ApiCallSchemas` maps every target to its validated request shape (TypeBox).
 * Everything else is DERIVED from this record so the enumeration can never
 * drift out of lockstep:
 *   - `AllowedApiTarget`  = `keyof typeof ApiCallSchemas`
 *   - `ALLOWED_API_TARGETS` / `isAllowedApiTarget` = the record's own keys
 *   - `ValidatedApiCall`  = the discriminated union of every schema's `Static<>`
 *   - per-handler param types = `ApiCallFor<'target'>` (`Extract` on the union)
 *
 * Add a target by adding ONE entry to `ApiCallSchemas`; the handler table in
 * `host/apiDispatch.ts` is then compile-forced to grow a matching handler, and
 * `protocol/targets.ts` pairs it with its required permission.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { StorageListOptionsSchema } from '@core/plugin-sdk/storageSchemas'
import { RouteRegistrationArgSchema } from './schemas/routes'
import { HookListenerArgSchema, HookFilterArgSchema, HookEmitArgSchema } from './schemas/hooks'
import { LoopSourceDescriptorSchema } from './schemas/loops'
import { JsonRecordSchema } from './schemas/storage'
import { NetworkFetchInitSchema, NetworkAbortArgSchema } from './schemas/network'
import { ScheduleRegisterArgSchema, ScheduleCancelArgSchema } from './schemas/schedule'
import {
  RegisterStorageAdapterArgSchema,
  RegisterUrlTransformerArgSchema,
  RegisterVariantDelegateArgSchema,
} from './schemas/media'
import { CryptoDigestArgSchema, CryptoSignHmacArgSchema } from './schemas/crypto'
import {
  ContentEntriesCreateArgsSchema,
  ContentEntriesCreateManyArgsSchema,
  ContentEntriesDeleteArgsSchema,
  ContentEntriesDeleteManyArgsSchema,
  ContentEntriesGetArgsSchema,
  ContentEntriesGetBySlugArgsSchema,
  ContentEntriesListArgsSchema,
  ContentEntriesMoveTableArgsSchema,
  ContentEntriesPublishArgsSchema,
  ContentEntriesUpdateArgsSchema,
  ContentEntriesUpdateManyArgsSchema,
  ContentRepublishAllArgsSchema,
  ContentSearchArgsSchema,
  ContentSnapshotArgsSchema,
  ContentTablesCreateArgsSchema,
  ContentTablesGetArgsSchema,
  ContentTablesListArgsSchema,
  ContentTreeMutateArgsSchema,
  ContentTreeReadArgsSchema,
  ContentTreeReplaceArgsSchema,
} from './schemas/content'

// ---------------------------------------------------------------------------
// Generic schema builder
// ---------------------------------------------------------------------------

function apiCallSchema<TTarget extends string, TArgs extends TSchema>(
  target: TTarget,
  args: TArgs,
) {
  return Type.Object(
    {
      kind: Type.Literal('api-call'),
      correlationId: Type.String({ minLength: 1 }),
      pluginId: Type.String({ minLength: 1 }),
      target: Type.Literal(target),
      args,
    },
    { additionalProperties: false },
  )
}

// ---------------------------------------------------------------------------
// Per-target schemas
// ---------------------------------------------------------------------------

export const ApiCallSchemas = {
  'cms.routes.register': apiCallSchema('cms.routes.register', Type.Tuple([RouteRegistrationArgSchema])),
  'cms.hooks.on': apiCallSchema('cms.hooks.on', Type.Tuple([HookListenerArgSchema])),
  'cms.hooks.filter': apiCallSchema('cms.hooks.filter', Type.Tuple([HookFilterArgSchema])),
  'cms.hooks.emit': apiCallSchema('cms.hooks.emit', Type.Tuple([HookEmitArgSchema])),
  'cms.loops.registerSource': apiCallSchema('cms.loops.registerSource', Type.Tuple([LoopSourceDescriptorSchema])),
  'cms.storage.list': apiCallSchema('cms.storage.list', Type.Tuple([
    Type.String({ minLength: 1 }),
    StorageListOptionsSchema,
  ])),
  'cms.storage.create': apiCallSchema('cms.storage.create', Type.Tuple([Type.String({ minLength: 1 }), JsonRecordSchema])),
  'cms.storage.update': apiCallSchema('cms.storage.update', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
    JsonRecordSchema,
  ])),
  'cms.storage.delete': apiCallSchema('cms.storage.delete', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
  ])),
  'cms.settings.replace': apiCallSchema('cms.settings.replace', Type.Tuple([JsonRecordSchema])),
  'network.fetch': apiCallSchema('network.fetch', Type.Tuple([
    Type.String({ minLength: 1, maxLength: 2048 }),
    NetworkFetchInitSchema,
  ])),
  // The host is intentionally permissive about `network.abort` — it does
  // NOT require `network.outbound` to be granted. A plugin without the
  // permission can never have minted a live `abortId` in the first place,
  // so the worst case is a missed lookup that no-ops (see dispatchApiCall).
  'network.abort': apiCallSchema('network.abort', Type.Tuple([NetworkAbortArgSchema])),
  'cms.schedule.register': apiCallSchema('cms.schedule.register', Type.Tuple([ScheduleRegisterArgSchema])),
  'cms.schedule.cancel': apiCallSchema('cms.schedule.cancel', Type.Tuple([ScheduleCancelArgSchema])),
  'cms.media.registerStorageAdapter': apiCallSchema(
    'cms.media.registerStorageAdapter',
    Type.Tuple([RegisterStorageAdapterArgSchema]),
  ),
  'cms.media.registerUrlTransformer': apiCallSchema(
    'cms.media.registerUrlTransformer',
    Type.Tuple([RegisterUrlTransformerArgSchema]),
  ),
  'cms.media.registerVariantDelegate': apiCallSchema(
    'cms.media.registerVariantDelegate',
    Type.Tuple([RegisterVariantDelegateArgSchema]),
  ),
  'cms.content.tables.list': apiCallSchema('cms.content.tables.list', ContentTablesListArgsSchema),
  'cms.content.tables.get': apiCallSchema('cms.content.tables.get', ContentTablesGetArgsSchema),
  'cms.content.tables.create': apiCallSchema('cms.content.tables.create', ContentTablesCreateArgsSchema),
  'cms.content.entries.list': apiCallSchema('cms.content.entries.list', ContentEntriesListArgsSchema),
  'cms.content.entries.get': apiCallSchema('cms.content.entries.get', ContentEntriesGetArgsSchema),
  'cms.content.entries.getBySlug': apiCallSchema('cms.content.entries.getBySlug', ContentEntriesGetBySlugArgsSchema),
  'cms.content.entries.create': apiCallSchema('cms.content.entries.create', ContentEntriesCreateArgsSchema),
  'cms.content.entries.update': apiCallSchema('cms.content.entries.update', ContentEntriesUpdateArgsSchema),
  'cms.content.entries.delete': apiCallSchema('cms.content.entries.delete', ContentEntriesDeleteArgsSchema),
  'cms.content.entries.publish': apiCallSchema('cms.content.entries.publish', ContentEntriesPublishArgsSchema),
  'cms.content.entries.moveTable': apiCallSchema('cms.content.entries.moveTable', ContentEntriesMoveTableArgsSchema),
  'cms.content.entries.createMany': apiCallSchema('cms.content.entries.createMany', ContentEntriesCreateManyArgsSchema),
  'cms.content.entries.updateMany': apiCallSchema('cms.content.entries.updateMany', ContentEntriesUpdateManyArgsSchema),
  'cms.content.entries.deleteMany': apiCallSchema('cms.content.entries.deleteMany', ContentEntriesDeleteManyArgsSchema),
  'cms.content.tree.read': apiCallSchema('cms.content.tree.read', ContentTreeReadArgsSchema),
  'cms.content.tree.mutate': apiCallSchema('cms.content.tree.mutate', ContentTreeMutateArgsSchema),
  'cms.content.tree.replace': apiCallSchema('cms.content.tree.replace', ContentTreeReplaceArgsSchema),
  'cms.content.search': apiCallSchema('cms.content.search', ContentSearchArgsSchema),
  'cms.content.snapshot': apiCallSchema('cms.content.snapshot', ContentSnapshotArgsSchema),
  'cms.content.republishAll': apiCallSchema('cms.content.republishAll', ContentRepublishAllArgsSchema),
  'crypto.digest': apiCallSchema('crypto.digest', Type.Tuple([CryptoDigestArgSchema])),
  'crypto.signHmac': apiCallSchema('crypto.signHmac', Type.Tuple([CryptoSignHmacArgSchema])),
} satisfies Record<string, TSchema>

// ---------------------------------------------------------------------------
// Derived target set + validated-call union — ALL of this comes from the
// `ApiCallSchemas` record above, so there is exactly one list to maintain.
// ---------------------------------------------------------------------------

/** The union of every accepted RPC target, derived from the schema record. */
export type AllowedApiTarget = keyof typeof ApiCallSchemas

/** Runtime allowlist of dotted RPC names — the record's own keys. */
export const ALLOWED_API_TARGETS = Object.keys(ApiCallSchemas) as AllowedApiTarget[]

/**
 * Typed guard backed by the record. Uses `Object.hasOwn` (NOT `key in obj`)
 * so inherited `Object.prototype` members (`'toString'`, `'constructor'`, …)
 * can never masquerade as a valid target and reach `ApiCallSchemas[target]`.
 */
export function isAllowedApiTarget(target: string): target is AllowedApiTarget {
  return Object.hasOwn(ApiCallSchemas, target)
}

/**
 * The discriminated union of every validated api-call, derived from the
 * schemas. `Static<>` distributes over the union of schema value types, so
 * this is a `target`-discriminated union with no hand-written members.
 */
export type ValidatedApiCall = Static<(typeof ApiCallSchemas)[keyof typeof ApiCallSchemas]>

/** Narrow the union to the call for a single target — replaces the old aliases. */
export type ApiCallFor<TTarget extends AllowedApiTarget> = Extract<
  ValidatedApiCall,
  { target: TTarget }
>

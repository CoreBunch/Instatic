/**
 * Permissive TypeBox shapes for the upstream registry documents. Only the
 * fields the server consumes are named, and only the ones an install depends
 * on are typed; decorative metadata (`readme`, `keywords`, `maintainers`) is
 * `Unknown` and filtered by the projection, because an odd shape in a
 * README field must never make a package impossible to install. Everything
 * else passes through `additionalProperties: true` since registry metadata is
 * large and changes without notice.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

const loose = { additionalProperties: true } as const

const PackumentVersionSchema = Type.Object({
  dist: Type.Optional(Type.Object({
    integrity: Type.Optional(Type.String()),
    tarball: Type.Optional(Type.String()),
    unpackedSize: Type.Optional(Type.Number()),
    fileCount: Type.Optional(Type.Number()),
  }, loose)),
  deprecated: Type.Optional(Type.Unknown()),
  license: Type.Optional(Type.Unknown()),
  dependencies: Type.Optional(Type.Unknown()),
  peerDependencies: Type.Optional(Type.Unknown()),
  exports: Type.Optional(Type.Unknown()),
  module: Type.Optional(Type.Unknown()),
  main: Type.Optional(Type.Unknown()),
  types: Type.Optional(Type.Unknown()),
  typings: Type.Optional(Type.Unknown()),
}, loose)
export type PackumentVersion = Static<typeof PackumentVersionSchema>

/** Full packument, or the abbreviated install document (same shape minus the decorative fields). */
export const PackumentSchema = Type.Object({
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.Unknown()),
  'dist-tags': Type.Optional(Type.Record(Type.String(), Type.String())),
  versions: Type.Optional(Type.Record(Type.String(), PackumentVersionSchema)),
  time: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  readme: Type.Optional(Type.Unknown()),
  homepage: Type.Optional(Type.Unknown()),
  repository: Type.Optional(Type.Unknown()),
  license: Type.Optional(Type.Unknown()),
  maintainers: Type.Optional(Type.Unknown()),
  keywords: Type.Optional(Type.Unknown()),
}, loose)
export type Packument = Static<typeof PackumentSchema>

/** `GET <registry>/<name>/<dist-tag>`: one version manifest. */
export const VersionManifestSchema = Type.Object({
  version: Type.Optional(Type.String()),
}, loose)

export const SearchResponseSchema = Type.Object({
  total: Type.Optional(Type.Number()),
  objects: Type.Optional(Type.Array(Type.Object({
    package: Type.Optional(Type.Object({
      name: Type.Optional(Type.String()),
      version: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      date: Type.Optional(Type.String()),
      publisher: Type.Optional(Type.Object({ username: Type.Optional(Type.String()) }, loose)),
    }, loose)),
    downloads: Type.Optional(Type.Object({ weekly: Type.Optional(Type.Number()) }, loose)),
    dependents: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    score: Type.Optional(Type.Object({
      detail: Type.Optional(Type.Object({
        quality: Type.Optional(Type.Number()),
        popularity: Type.Optional(Type.Number()),
        maintenance: Type.Optional(Type.Number()),
      }, loose)),
    }, loose)),
    flags: Type.Optional(Type.Object({ insecure: Type.Optional(Type.Number()) }, loose)),
  }, loose))),
}, loose)

export const DownloadsRangeResponseSchema = Type.Object({
  downloads: Type.Optional(Type.Array(Type.Object({
    day: Type.Optional(Type.String()),
    downloads: Type.Optional(Type.Number()),
  }, loose))),
}, loose)

export const OsvQueryResponseSchema = Type.Object({
  vulns: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.String()),
    summary: Type.Optional(Type.String()),
    details: Type.Optional(Type.String()),
    database_specific: Type.Optional(Type.Object({
      severity: Type.Optional(Type.String()),
    }, loose)),
  }, loose))),
}, loose)

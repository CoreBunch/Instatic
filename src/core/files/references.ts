import { Type, type Static } from '@sinclair/typebox'
import type { SiteFile } from './schemas'
import { publicAssetUrl, PublicAssetValidationError } from './publicAssets'

/** A passive file capability presented to a render, independent of its storage. */
export const PublicFileReferenceSchema = Type.Object({
  id: Type.String(),
  path: Type.String(),
  url: Type.String(),
  mimeType: Type.String(),
})
export type PublicFileReference = Static<typeof PublicFileReferenceSchema>
export const PublicFileReferencesSchema = Type.Record(Type.String(), PublicFileReferenceSchema)
export type PublicFileReferences = Static<typeof PublicFileReferencesSchema>

/** Published references are ordinary public URLs; previews supply scoped capabilities. */
export function buildPublicFileReferences(files: readonly SiteFile[]): PublicFileReferences {
  const references: PublicFileReferences = Object.create(null)
  for (const file of files) {
    if (file.type !== 'asset' || !file.blob) continue
    if (Object.hasOwn(references, file.id)) throw new PublicAssetValidationError(file.path, 'Public asset IDs must be unique.')
    references[file.id] = { id: file.id, path: file.path, url: publicAssetUrl(file.path), mimeType: file.blob.mimeType }
  }
  return references
}

/** An authored file reference must resolve to an actual typed file/property. */
export function readPublicFileField(files: PublicFileReferences | undefined, field: string): string {
  const separator = field.lastIndexOf('.')
  const id = field.slice(0, separator)
  const property = field.slice(separator + 1)
  if (separator < 1 || !files || !Object.hasOwn(files, id)) {
    throw new PublicAssetValidationError(`file.${field}`, 'The referenced public file does not exist or has no binary payload.')
  }
  const reference = files[id]
  if (!Object.hasOwn(reference, property)) {
    throw new PublicAssetValidationError(`file.${field}`, 'The referenced public-file property does not exist.')
  }
  return reference[property as keyof PublicFileReference]
}

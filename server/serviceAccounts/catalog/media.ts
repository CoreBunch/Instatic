import { Type } from '@core/utils/typeboxHelpers'
import { CmsMediaLookupRequestSchema } from '@core/persistence/responseSchemas'
import { AssignFoldersBodySchema, UpdateMediaMetadataBodySchema } from '../../handlers/cms/media'
import { CreateFolderBodySchema, PatchFolderBodySchema } from '../../handlers/cms/mediaFolders'
import { ElectAdapterBodySchema, ElectDelegateBodySchema } from '../../handlers/cms/mediaStorageAdmin'
import { MigrateBodySchema } from '../../handlers/cms/mediaStorageMigration'
import { operation as op } from './operation'

export const mediaOperations = [
  op('GET', 'media', 'media.read', 'List media assets', { querySchema: Type.Partial(Type.Object({ query: Type.String(), limit: Type.Integer(), trash: Type.Literal('1') })) }),
  op('POST', 'media', 'media.write', 'Upload an image, video or font', { multipart: { file: 'Required media file', altText: 'Optional text alternative' } }),
  op('POST', 'media/lookup', 'media.read', 'Resolve media references', { bodySchema: CmsMediaLookupRequestSchema }),
  op('PATCH', 'media/:id', 'media.write', 'Update asset metadata', { bodySchema: UpdateMediaMetadataBodySchema }),
  op('DELETE', 'media/:id', 'media.delete', 'Trash an asset. Set purge=1 to permanently remove an already trashed asset.', { querySchema: Type.Object({ purge: Type.Optional(Type.Literal('1')) }) }),
  op('POST', 'media/:id/restore', 'media.write', 'Restore a trashed asset'),
  op('POST', 'media/:id/replace', 'media.replace', 'Replace the bytes of an asset', { multipart: { file: 'Required replacement media file' } }),
  op('POST', 'media/:id/folders', 'media.write', 'Add or remove the asset from folders by ID', { bodySchema: AssignFoldersBodySchema }),
  op('GET', 'media/folders', 'media.read', 'List media folders'),
  op('POST', 'media/folders', 'media.write', 'Create a media folder', { bodySchema: CreateFolderBodySchema }),
  op('PATCH', 'media/folders/:id', 'media.write', 'Rename, move or reorder a folder', { bodySchema: PatchFolderBodySchema }),
  op('DELETE', 'media/folders/:id', 'media.delete', 'Delete a folder'),
  op('GET', 'media/storage', 'storage.elect', 'Read storage adapters, current elections and migration backlog'),
  op('POST', 'media/storage/elect', 'storage.elect', 'Elect a storage adapter for a media role', { bodySchema: ElectAdapterBodySchema }),
  op('POST', 'media/storage/delegate', 'storage.elect', 'Elect or clear a variant delegate', { bodySchema: ElectDelegateBodySchema }),
  op('POST', 'media/storage/verify/:adapterId', 'storage.elect', 'Verify a storage adapter'),
  op('POST', 'media/storage/migrate', 'storage.migrate', 'Migrate existing assets and stream progress', { bodySchema: MigrateBodySchema }),
]

// ---------------------------------------------------------------------------
// Resource fields — plugin-declared backend record shapes
// ---------------------------------------------------------------------------

export type PluginResourceFieldType = 'text' | 'longtext' | 'number' | 'date' | 'boolean'

export interface PluginResourceField {
  id: string
  label: string
  type: PluginResourceFieldType
  required?: boolean
}

export interface PluginResource {
  id: string
  title: string
  singularLabel?: string
  pluralLabel?: string
  fields: PluginResourceField[]
  /**
   * Id of a `text` field whose value is unique among this resource's records.
   * Enables `createIfAbsent` and `getByKey` on the collection.
   */
  uniqueField?: string
}

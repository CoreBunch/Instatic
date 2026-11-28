import { Type, type Static } from '@core/utils/typeboxHelpers'

const strings = Type.Array(Type.String())
const id = Type.Integer({ minimum: 0 })
const field = Type.Object({
  key: Type.String(), name: Type.String(), label: Type.String(), type: Type.String(),
  post_type: Type.Optional(Type.Union([strings, Type.String(), Type.Null()])),
  multiple: Type.Optional(Type.Union([Type.Number(), Type.Boolean()])),
})
export const SourceSchema = Type.Object({
  version: Type.Literal(1), site: Type.String(), blog: id, name: Type.String(), date: Type.String(),
  homeHtml: Type.String(), warnings: strings, inventory: Type.Record(Type.String(), Type.Unknown()),
  types: Type.Array(Type.Object({
    name: Type.String(), label: Type.String(), singular: Type.String(), fields: Type.Array(field),
    archive: Type.String(), archiveHtml: Type.String(),
  })),
  posts: Type.Array(Type.Object({
    id, type: Type.String(), slug: Type.String(), title: Type.String(), status: Type.String(), public: Type.Boolean(), passwordProtected: Type.Boolean(),
    publicMeta: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))), authorName: Type.Optional(Type.String()),
    url: Type.String(), raw: Type.String(), html: Type.String(), featured: id, date: Type.String(), modified: Type.String(),
    fields: Type.Record(Type.String(), Type.Unknown()), terms: Type.Record(Type.String(), Type.Array(id)), shortcodes: strings,
  })),
  taxonomies: Type.Array(Type.Object({
    name: Type.String(), label: Type.String(), types: strings,
    terms: Type.Array(Type.Object({ id, name: Type.String(), slug: Type.String(), parent: id })),
  })),
  media: Type.Array(Type.Object({ id, url: Type.String(), alt: Type.String(), title: Type.String(), caption: Type.String() })),
})
export type Source = Static<typeof SourceSchema>
export type SourceField = Source['types'][number]['fields'][number]

export const MappingSchema = Type.Object({
  types: Type.Optional(Type.Record(Type.String(), Type.Object({
    title: Type.Optional(Type.String()), body: Type.Optional(Type.String()), listing: Type.Optional(Type.String()),
    text: Type.Optional(Type.Record(Type.String(), Type.String())),
    gallery: Type.Optional(Type.Record(Type.String(), Type.String())),
  }))),
  scripts: Type.Optional(strings),
  forms: Type.Optional(Type.Array(Type.Object({
    selector: Type.String(), name: Type.String(), fields: Type.Record(Type.String(), Type.Union([
      Type.Literal('text'), Type.Literal('longText'), Type.Literal('email'),
    ])),
  }))),
})
export type Mapping = Static<typeof MappingSchema>

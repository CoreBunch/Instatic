/**
 * base.body — page body module.
 *
 * Represents the page's `<body>` element. Emits no wrapper element at publish
 * time: the body node's children render directly into `<body>`, and any user
 * classes applied to the body land on `<body class="...">` via the publisher
 * (see `publishPage` in `src/core/publisher/render.ts`). The editor preview
 * component still wraps children in a `<div>` so the canvas has a click
 * target / drop zone for the body node — that wrapper is editor-only and
 * never reaches published HTML.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { BodyEditor } from './BodyEditor'
import { Type } from '@core/utils/typeboxHelpers'
import type { Static } from '@core/utils/typeboxHelpers'

// No authored fields — additionalProperties:true makes validation a pass-through
// while still satisfying the propsSchema contract for consistency.
const BodyPropsSchema = Type.Object({}, { additionalProperties: true })
type BodyProps = Static<typeof BodyPropsSchema>

export const BodyModule: ModuleDefinition<BodyProps> = {
  id: 'base.body',
  name: 'Body',
  category: 'Layout',
  version: '2.0.0',
  trusted: true,
  canHaveChildren: true,
  icon: FileTextSolidIcon,

  schema: {},
  propsSchema: BodyPropsSchema,
  defaults: {},

  component: BodyEditor,

  // The body node represents the page's <body> element at publish time, even
  // though render() emits children directly (the publisher wraps them in
  // `<body>` separately). Surfacing the tag here keeps the layers panel honest.
  htmlTag: 'body',

  htmlContract: {
    tag: 'body',
    canHaveChildren: true,
    // The body node is the page root — it's not claimed from imported HTML
    // (the importer starts from doc.body and maps its children, not body itself).
  },

  // No wrapper element — children render directly into <body>. Body-level
  // user classes are applied to <body> by publishPage(), not here.
  render: (_props, renderedChildren) => ({
    html: renderedChildren.join(''),
  }),
}

registry.registerOrReplace(BodyModule)

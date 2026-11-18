/**
 * Canvas plugin stylesheets — the wire shape of
 * `GET /admin/api/cms/runtime/canvas-stylesheets`.
 *
 * The server (`server/publish/canvasStylesheets.ts`) resolves every stylesheet
 * that enabled plugins add to published pages into plain CSS text; the editing
 * canvas (`PluginStylesheetInjector`) injects that text into each breakpoint
 * iframe. Server and client both derive their types from this schema.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

const CanvasPluginStylesheetSchema = Type.Object({
  pluginId: Type.String(),
  /**
   * Where the published page emits this stylesheet relative to the site's own
   * CSS: `head` assets sit at the top of `<head>` (before it), every other
   * placement comes after it.
   */
  position: Type.Union([Type.Literal('before-site'), Type.Literal('after-site')]),
  /** Stylesheet text, with relative `url(...)` references already rebased. */
  css: Type.String(),
  /** The asset's `media` attribute, when it declares one. */
  media: Type.Optional(Type.String()),
})

export type CanvasPluginStylesheet = Static<typeof CanvasPluginStylesheetSchema>

export const CanvasPluginStylesheetsResponseSchema = Type.Object({
  stylesheets: Type.Array(CanvasPluginStylesheetSchema),
})

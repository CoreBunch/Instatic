/**
 * CSSPropertyBag — the publisher-boundary narrowing type for class styles.
 *
 * §4.1 rationale: `validate.ts` line 822 stores `styles` as
 * `Record<string, unknown>` without narrowing to CSSPropertyBag. The editor
 * only writes known CSSPropertyBag keys via classSlice, but the persistence
 * layer preserves arbitrary keys (forward-compat with future CSS properties).
 *
 * Consequence:
 *   - `StyleRuleSchema.styles` uses `Type.Record(Type.String(), Type.Unknown())`
 *     to match the persistence semantics exactly.
 *   - `CSSPropertyBagSchema` exists as the TypeBox source-of-truth for the
 *     type only, used at the publisher narrowing point (classCss.ts
 *     `bagToCSS`).
 *   - Per-property fallback is intentionally absent: the publisher already
 *     guards via the ALLOWED_PROPS set + `sanitiseCssValue`, so silently
 *     coercing bad values here would be redundant and misleading.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

const CSSPropertyBagSchema = Type.Object({
  // Typography
  fontFamily: Type.Optional(Type.String()),
  fontSize: Type.Optional(Type.String()),
  fontWeight: Type.Optional(Type.String()),
  fontStyle: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('italic')])),
  letterSpacing: Type.Optional(Type.String()),
  lineHeight: Type.Optional(Type.String()),
  textAlign: Type.Optional(Type.Union([
    Type.Literal('left'), Type.Literal('center'), Type.Literal('right'), Type.Literal('justify'),
  ])),
  textDecoration: Type.Optional(Type.String()),
  textTransform: Type.Optional(Type.Union([
    Type.Literal('none'), Type.Literal('uppercase'), Type.Literal('lowercase'), Type.Literal('capitalize'),
  ])),
  whiteSpace: Type.Optional(Type.Union([
    Type.Literal('normal'), Type.Literal('nowrap'), Type.Literal('pre'),
    Type.Literal('pre-wrap'), Type.Literal('pre-line'), Type.Literal('break-spaces'),
  ])),
  color: Type.Optional(Type.String()),
  textShadow: Type.Optional(Type.String()),

  // Layout
  display: Type.Optional(Type.Union([
    Type.Literal('block'), Type.Literal('flex'), Type.Literal('grid'),
    Type.Literal('inline'), Type.Literal('inline-block'), Type.Literal('inline-flex'),
    Type.Literal('none'),
  ])),
  flexDirection: Type.Optional(Type.Union([
    Type.Literal('row'), Type.Literal('column'),
    Type.Literal('row-reverse'), Type.Literal('column-reverse'),
  ])),
  flexWrap: Type.Optional(Type.Union([Type.Literal('nowrap'), Type.Literal('wrap')])),
  alignItems: Type.Optional(Type.String()),
  justifyContent: Type.Optional(Type.String()),
  justifyItems: Type.Optional(Type.String()),
  alignSelf: Type.Optional(Type.String()),
  justifySelf: Type.Optional(Type.String()),
  flex: Type.Optional(Type.String()),
  gap: Type.Optional(Type.String()),
  rowGap: Type.Optional(Type.String()),
  columnGap: Type.Optional(Type.String()),
  gridTemplateColumns: Type.Optional(Type.String()),
  gridTemplateRows: Type.Optional(Type.String()),
  gridColumn: Type.Optional(Type.String()),
  gridRow: Type.Optional(Type.String()),

  // Size
  width: Type.Optional(Type.String()),
  height: Type.Optional(Type.String()),
  minWidth: Type.Optional(Type.String()),
  maxWidth: Type.Optional(Type.String()),
  minHeight: Type.Optional(Type.String()),
  maxHeight: Type.Optional(Type.String()),
  aspectRatio: Type.Optional(Type.String()),
  boxSizing: Type.Optional(Type.Union([Type.Literal('border-box'), Type.Literal('content-box')])),

  // Spacing — per-side ONLY. The visual editor stores per-side values as the
  // canonical shape; the publisher's `bagToCSS` collapses 4 sides into the
  // CSS shorthand (`padding: 20px 0;`) at emission time. There is no
  // `padding` / `margin` shorthand in storage — that ambiguity was removed
  // pre-release so there's exactly one valid shape.
  marginTop: Type.Optional(Type.String()),
  marginRight: Type.Optional(Type.String()),
  marginBottom: Type.Optional(Type.String()),
  marginLeft: Type.Optional(Type.String()),
  paddingTop: Type.Optional(Type.String()),
  paddingRight: Type.Optional(Type.String()),
  paddingBottom: Type.Optional(Type.String()),
  paddingLeft: Type.Optional(Type.String()),

  // Position
  position: Type.Optional(Type.Union([
    Type.Literal('static'), Type.Literal('relative'), Type.Literal('absolute'),
    Type.Literal('fixed'), Type.Literal('sticky'),
  ])),
  top: Type.Optional(Type.String()),
  right: Type.Optional(Type.String()),
  bottom: Type.Optional(Type.String()),
  left: Type.Optional(Type.String()),
  zIndex: Type.Optional(Type.Number()),

  // Visual
  backgroundColor: Type.Optional(Type.String()),
  background: Type.Optional(Type.String()),
  backgroundImage: Type.Optional(Type.String()),
  backgroundSize: Type.Optional(Type.String()),
  backgroundPosition: Type.Optional(Type.String()),
  backgroundRepeat: Type.Optional(Type.String()),
  objectFit: Type.Optional(Type.Union([
    Type.Literal('contain'), Type.Literal('cover'), Type.Literal('fill'),
    Type.Literal('none'), Type.Literal('scale-down'),
  ])),
  objectPosition: Type.Optional(Type.String()),
  opacity: Type.Optional(Type.Number()),
  visibility: Type.Optional(Type.Union([
    Type.Literal('visible'), Type.Literal('hidden'), Type.Literal('collapse'),
  ])),
  overflow: Type.Optional(Type.String()),
  overflowX: Type.Optional(Type.String()),
  overflowY: Type.Optional(Type.String()),

  // Border
  border: Type.Optional(Type.String()),
  borderTop: Type.Optional(Type.String()),
  borderRight: Type.Optional(Type.String()),
  borderBottom: Type.Optional(Type.String()),
  borderLeft: Type.Optional(Type.String()),

  // 4-sides shorthand longhands. `borderColor` was already here;
  // `borderWidth` and `borderStyle` are added so a real-site import
  // that mixes shorthand and longhand round-trips losslessly.
  borderWidth: Type.Optional(Type.String()),
  borderStyle: Type.Optional(Type.String()),
  borderColor: Type.Optional(Type.String()),

  // Per-side longhand — the canonical storage shape edited by the
  // visual BorderControl. The publisher collapses all-sides-equal
  // values to the `border: W S C` shorthand at emission time so the
  // generated CSS stays compact (mirrors the padding / margin sides
  // shorthand in `bagToCSS`).
  borderTopWidth: Type.Optional(Type.String()),
  borderTopStyle: Type.Optional(Type.String()),
  borderTopColor: Type.Optional(Type.String()),
  borderRightWidth: Type.Optional(Type.String()),
  borderRightStyle: Type.Optional(Type.String()),
  borderRightColor: Type.Optional(Type.String()),
  borderBottomWidth: Type.Optional(Type.String()),
  borderBottomStyle: Type.Optional(Type.String()),
  borderBottomColor: Type.Optional(Type.String()),
  borderLeftWidth: Type.Optional(Type.String()),
  borderLeftStyle: Type.Optional(Type.String()),
  borderLeftColor: Type.Optional(Type.String()),

  borderRadius: Type.Optional(Type.String()),
  borderTopLeftRadius: Type.Optional(Type.String()),
  borderTopRightRadius: Type.Optional(Type.String()),
  borderBottomLeftRadius: Type.Optional(Type.String()),
  borderBottomRightRadius: Type.Optional(Type.String()),

  // border-image — the browser unrolls the `border` shorthand into these
  // five longhands too. No dedicated editor UI (border-image is niche), but
  // allowlisted so imported CSS round-trips faithfully instead of warning.
  // `borderImageSource` is the picture/gradient; the others control slicing.
  borderImageSource: Type.Optional(Type.String()),
  borderImageSlice: Type.Optional(Type.String()),
  borderImageWidth: Type.Optional(Type.String()),
  borderImageOutset: Type.Optional(Type.String()),
  borderImageRepeat: Type.Optional(Type.String()),

  outline: Type.Optional(Type.String()),
  outlineOffset: Type.Optional(Type.String()),

  // Native form-control reset. `appearance: none` is ubiquitous in modern
  // reset stylesheets (Tailwind preflight, Open Props, ...). The editor's
  // own controls have no use for it, but imported CSS that targets form
  // elements needs it to round-trip.
  appearance: Type.Optional(Type.String()),

  // Effects
  boxShadow: Type.Optional(Type.String()),
  filter: Type.Optional(Type.String()),
  backdropFilter: Type.Optional(Type.String()),
  transform: Type.Optional(Type.String()),
  transformOrigin: Type.Optional(Type.String()),

  // Motion
  transition: Type.Optional(Type.String()),
  animation: Type.Optional(Type.String()),

  // Interaction
  cursor: Type.Optional(Type.String()),
  pointerEvents: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('auto')])),
  userSelect: Type.Optional(Type.String()),

  // Scrollbar
  scrollBehavior: Type.Optional(Type.String()),

  // SVG / icon color utilities
  fill: Type.Optional(Type.String()),
})

export type CSSPropertyBag = Static<typeof CSSPropertyBagSchema>

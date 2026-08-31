/**
 * Inspector glyphs — the thin, 1.3–1.5-stroke marks the inspector redesign
 * needs at 8–12px.
 *
 * These are deliberately NOT in `pixel-art-icons`: that catalog is a chunky
 * pixel-art set whose lightest glyph still reads as a block at this size,
 * which is wrong for a hairline caret between a section title and its count.
 * Everything at normal UI sizes (14px and up) still comes from the pixel set
 * — these are only the sub-12px hairline marks.
 *
 * They live here, in `src/ui`, so the panels share ONE definition instead of
 * each pasting its own copy of the same path (Constraint #348's inline-SVG
 * gate covers `src/admin/pages/site/` for exactly that reason).
 */

/** Section-header caret. Points down; callers rotate it when collapsed. */
export function CaretGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path
        d="m1 2.75 2.293 2.293a1 1 0 0 0 1.414 0L7 2.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Number-field stepper chevron. Points up; the down button rotates it. */
export function StepperChevronGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path
        d="m1.5 5 1.875-1.5a1 1 0 0 1 1.25 0L6.5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Magnifier for the in-menu search row. */
export function SearchGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="5.25" cy="5.25" r="3.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="m8 8 2.25 2.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Ratio-lock padlock: closed shackle when locked, open when not. */
export function PadlockGlyph({ locked }: { locked: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d={locked ? 'M4 5.5V4a2 2 0 1 1 4 0v1.5' : 'M4 5.5V4a2 2 0 1 1 4 0'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <rect x="3" y="5.5" width="6" height="4.5" rx="1.2" fill="currentColor" />
    </svg>
  )
}

/** Scope toggle: one rounded box — edit all sides / corners together. */
export function AllSidesGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3.25 1.25a2 2 0 0 0-2 2v5.5a2 2 0 0 0 2 2h5.5a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Scope toggle: four detached edges — edit each side separately. */
export function PerSideGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M3 1.25h6M10.75 3v6M3 10.75h6M1.25 3v6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Scope toggle: four detached corners — edit each corner radius separately. */
export function PerCornerGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M1.25 4v-.75a2 2 0 0 1 2-2H4M10.75 4v-.75a2 2 0 0 0-2-2H8M10.75 8v.75a2 2 0 0 1-2 2H8M1.25 8v.75a2 2 0 0 0 2 2H4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Section-header "+" — opens the add-property menu. */
export function AddPropertyGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Remove cross on a swatch / stack row. */
export function RemoveXGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path
        d="m1.5 6.5 5-5M6.5 6.5l-5-5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Menu tick — marks the option a menu is currently ON (the selected value in a
 * Select, a property already present in a section). 9px, drawn in the accent.
 */
export function CheckGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path
        d="M1 4.5 3.25 7 7 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Row handle — takes the whole row away (`.rowx`, inspector-panel.md §5).
 *
 * A flat dash, not a cross: the cross means "clear this value" and lives
 * INSIDE the field. Two different actions must not wear the same mark.
 */
export function RemoveDashGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.25 6h7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Effect type: a shadow (square with its cast behind it). */
export function ShadowGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.75" y="2.75" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.75 13.25h5.5a2 2 0 0 0 2-2v-5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Effect type: a blur (dashed edge — the shape without a hard boundary). */
export function BlurGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
    </svg>
  )
}

/**
 * Inset pin — the bar that locks one edge of the inset box. Horizontal for
 * the left/right edges, vertical for top/bottom, so the mark reads as the
 * edge it holds.
 */
export function PinBarGlyph({ axis }: { axis: 'x' | 'y' }) {
  return axis === 'y' ? (
    <svg width="2" height="9" viewBox="0 0 2 10" aria-hidden="true">
      <path d="M0 1a1 1 0 0 1 2 0v8a1 1 0 0 1-2 0z" fill="currentColor" />
    </svg>
  ) : (
    <svg width="9" height="2" viewBox="0 0 10 2" aria-hidden="true">
      <path d="M0 1a1 1 0 0 1 1-1h8a1 1 0 0 1 0 2H1a1 1 0 0 1-1-1z" fill="currentColor" />
    </svg>
  )
}

/** Display segmented control: Flex (two upright bars). */
export function DisplayFlexGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.25" y="3.75" width="4" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.75" y="3.75" width="4" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

/** Display segmented control: Grid (2x2 filled cells). */
export function DisplayGridGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" fill="currentColor" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" fill="currentColor" />
    </svg>
  )
}

/** Cross-axis alignment: flex-start. */
export function AlignStartGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 2.75h10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5"
        y="5.5"
        width="6"
        height="7.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Cross-axis alignment: center. */
export function AlignCenterGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 8h2.25M11 8h2.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5"
        y="3.25"
        width="6"
        height="9.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Cross-axis alignment: flex-end. */
export function AlignEndGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 13.25h10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5"
        y="3"
        width="6"
        height="7.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Cross-axis alignment: stretch (axis with arrows at both ends). */
export function AlignStretchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.75v10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="m5.5 5.25 2.5-2.5 2.5 2.5M5.5 10.75l2.5 2.5 2.5-2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** text-align: left. */
export function TextAlignLeftGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 4h10.5M2.75 8h6.5M2.75 12h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** text-align: center. */
export function TextAlignCenterGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 4h10.5M4.75 8h6.5M3.5 12h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** text-align: right. */
export function TextAlignRightGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 4h10.5M6.75 8h6.5M4.25 12h9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** text-align: justify. */
export function TextAlignJustifyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 4h10.5M2.75 8h10.5M2.75 12h10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Main-axis (justify) marks — the prototype's full-width icon row, plus the
// transposed counterparts it does not draw (column-flow variants).
// ---------------------------------------------------------------------------

/** Main-axis alignment: start (items packed against the left edge). */
export function JustifyStartGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5.75"
        y="4.75"
        width="8"
        height="6.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Main-axis alignment: center. */
export function JustifyCenterGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7.75 1.5v3M7.75 12v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="2.75"
        y="4.75"
        width="10"
        height="6.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Main-axis alignment: end (items packed against the right edge). */
export function JustifyEndGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M13.25 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="2.25"
        y="4.75"
        width="8"
        height="6.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Main-axis distribution: space-between (gap pushed to both outer edges). */
export function JustifySpaceBetweenGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.25 2.5v11M13.75 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5.5"
        y="5.5"
        width="5"
        height="5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Main-axis distribution: space-between, column flow — space-between transposed. */
export function JustifySpaceBetweenVerticalGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 2.25h11M2.5 13.75h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5.5"
        y="5.5"
        width="5"
        height="5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Main-axis distribution: space-around — space-between with the rules pulled inward. */
export function JustifySpaceAroundGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.25 2.5v11M11.75 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="6"
        y="5.5"
        width="4"
        height="5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Main-axis distribution: space-around, column flow — space-around transposed. */
export function JustifySpaceAroundVerticalGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.25h11M2.5 11.75h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect
        x="5.5"
        y="6"
        width="5"
        height="4"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="currentColor"
        fillOpacity=".15"
      />
    </svg>
  )
}

/** Cross-axis alignment: stretch, column flow — AlignStretchGlyph transposed. */
export function AlignStretchHorizontalGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 8h10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="m5.25 5.5-2.5 2.5 2.5 2.5M10.75 5.5l2.5 2.5-2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Cross-axis alignment: baseline. */
export function AlignBaselineGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.75 12.25h10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M5.5 9.5V4.75a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2V9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

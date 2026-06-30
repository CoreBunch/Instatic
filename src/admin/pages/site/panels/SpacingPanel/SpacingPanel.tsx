/**
 * SpacingPanel — docked sidebar UI for fluid spacing scales.
 *
 * Sister component to `TypographyPanel`; both share the `FrameworkScalePanel`
 * shell. Spacing's adapter targets the padding/margin/gap CSS surface, exposes
 * the wider Perfect-Octave-inclusive ratio set, and replaces the per-step
 * mini-bars with a unified two-sided bar chart that sizes every bar in real
 * CSS pixels:
 *
 *   ┌───────────────────────────────────────────────┐
 *   │ ●DESKTOP                                      │
 *   │                                            ▮  │
 *   │                                       ▮    ▮  │   ← desktop bars (height = px)
 *   │                                  ▮    ▮    ▮  │
 *   │                            ▮     ▮    ▮    ▮  │
 *   │ ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─── ─ │   ← centerline + step labels
 *   │  ▮   ▮   ▮   ▮   ▮   ▮    ▮     ▮    ▮    ▮   │   ← mobile bars (height = px)
 *   │ ●MOBILE                                       │
 *   └───────────────────────────────────────────────┘
 *
 * Bar heights are taken from the literal px value, so a 158px max bar is
 * 158 actual pixels tall, and a 5px min bar is 5 pixels tall — there is no
 * scaling step. Bars are simple CSS pills (`border-radius: 999px`) with a
 * small inter-bar gap; each bar is its own `<span>` whose height is set
 * inline from the data. Top row = max breakpoint (Desktop), bottom row =
 * min breakpoint (Mobile).
 */

import { type CSSProperties } from "react";
import { useEditorStore } from "@site/store/store";
import { SPACING_RATIO_OPTIONS } from '@core/framework'
import type {
  FrameworkSpacingClassGenerator,
  FrameworkSpacingGroup,
} from '@core/framework-schema'
import { cn } from "@ui/cn";
import { MonitorSolidIcon } from "pixel-art-icons/icons/monitor-solid";
import { RulerDimensionSolidIcon } from "pixel-art-icons/icons/ruler-dimension-solid";
import { SmartphoneSolidIcon } from "pixel-art-icons/icons/smartphone-solid";
import {
  FrameworkScalePanel,
  type ScaleAdapter,
} from "@site/panels/FrameworkScalePanel";
import { useFrameworkChangeConfirm } from "@admin/shared/dialogs/FrameworkChangeConfirmDialog";
import { applySpacingGroupPatchPreview } from "@site/store/slices/site/framework/spacing";
import styles from "./SpacingPanel.module.css";

const SPACING_CSS_PROPERTIES = [
  { value: "padding", label: "padding" },
  { value: "padding-top", label: "padding-top" },
  { value: "padding-right", label: "padding-right" },
  { value: "padding-bottom", label: "padding-bottom" },
  { value: "padding-left", label: "padding-left" },
  { value: "margin", label: "margin" },
  { value: "margin-top", label: "margin-top" },
  { value: "margin-right", label: "margin-right" },
  { value: "margin-bottom", label: "margin-bottom" },
  { value: "margin-left", label: "margin-left" },
  { value: "gap", label: "gap" },
  { value: "row-gap", label: "row-gap" },
  { value: "column-gap", label: "column-gap" },
] as const;

const EMPTY_GROUPS: FrameworkSpacingGroup[] = [];
const EMPTY_CLASSES: FrameworkSpacingClassGenerator[] = [];

export interface ChartPoint {
  stepLabel: string;
  variableName: string;
  minPx: number;
  maxPx: number;
  isBase: boolean;
}

// Reserved label space at the outer edge of each row so a bar's value label
// can sit directly above (desktop) / below (mobile) the bar tip without
// squeezing the bar itself.
const VALUE_LABEL_RESERVE_PX = 12

/**
 * Compact integer-ish formatter for the inline numbers above/below each bar.
 * No trailing zeros, max two decimals — keeps the labels visually small so
 * they don't fight the bars for space (and we drop the px suffix entirely).
 */
function formatBarValue(v: number): string {
  if (!Number.isFinite(v)) return ''
  return v.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * Single bar row — a flat list of CSS pill `<span>` elements, one per step.
 * Each bar's height is the literal px value from the data (so a 5px bar is
 * 5 actual pixels tall). Bars are equal-width via the parent grid template
 * and are anchored to the centerline-side of the row by the parent's
 * `align-items` (set in the stylesheet, per side).
 */
function PillBarRow({
  heights,
  seriesClassName,
}: {
  heights: number[]
  seriesClassName: string
}) {
  return (
    <div className={styles.barChartBars} aria-hidden="true">
      {heights.map((h, idx) => (
        <span
          key={`bar-${idx}`}
          className={cn(styles.barChartBar, seriesClassName)}
          style={{ height: `${Math.max(0, h)}px` } as CSSProperties}
        />
      ))}
    </div>
  )
}

export function SpacingBarChart({ points }: { points: ChartPoint[] }) {
  const desktopHeights = points.map((p) => Math.max(0, p.maxPx))
  const mobileHeights = points.map((p) => Math.max(0, p.minPx))

  // Per-side max bar height. Plus the reserve gives the wrapping row height,
  // leaving room for the floating value labels.
  const desktopBarHeight = desktopHeights.reduce((acc, h) => Math.max(acc, h), 0)
  const mobileBarHeight = mobileHeights.reduce((acc, h) => Math.max(acc, h), 0)
  const desktopRowHeight =
    desktopBarHeight > 0 ? desktopBarHeight + VALUE_LABEL_RESERVE_PX : 0
  const mobileRowHeight =
    mobileBarHeight > 0 ? mobileBarHeight + VALUE_LABEL_RESERVE_PX : 0

  return (
    <div
      className={styles.barChart}
      role="group"
      aria-label="Spacing scale chart"
    >
      {/* Baseline-step highlight — a vertical pill in the base step's
       *  column that spans the full chart height (desktop bars + center
       *  + mobile bars). Same width as a bar, same border-radius. Sits
       *  behind every other layer so the bars and labels paint on top
       *  of it. Uses the same column grid as the bars so it lines up
       *  exactly under the base column. */}
      <div className={styles.barChartBaseHighlight} aria-hidden="true">
        {points.map((p, idx) => (
          <span
            key={`base-hi-${p.stepLabel}-${idx}`}
            className={styles.barChartBaseHighlightCell}
            data-base={p.isBase ? 'true' : undefined}
          />
        ))}
      </div>

      {/* Desktop row — icon on the left, pill bars + floating value labels. */}
      <div
        className={styles.barChartIcon}
        data-side="desktop"
        aria-label="Desktop"
      >
        <MonitorSolidIcon size={14} aria-hidden="true" />
      </div>
      <div
        className={styles.barChartRow}
        data-side="desktop"
        style={{ height: `${desktopRowHeight}px` } as CSSProperties}
      >
        <PillBarRow
          heights={desktopHeights}
          seriesClassName={styles.barChartBarMax}
        />
        <div className={styles.barChartLabelOverlay} aria-hidden="true">
          {points.map((p, idx) => (
            <span
              key={`desktop-label-${p.stepLabel}-${idx}`}
              className={styles.barChartLabelCell}
            >
              <span
                className={styles.barValueLabel}
                data-series="max"
                data-base={p.isBase ? 'true' : undefined}
                style={
                  {
                    // Desktop label cell uses flex-start (label at row top).
                    // Push it down by (maxBar − thisBar) so it sits right
                    // above this bar's tip.
                    transform: `translateY(${desktopBarHeight - Math.max(0, p.maxPx)}px)`,
                  } as CSSProperties
                }
                title={`${p.variableName}: desktop ${p.maxPx}px${p.isBase ? ' (base step)' : ''}`}
              >
                {formatBarValue(p.maxPx)}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Center row — step labels only (no divider line). The label grid
       *  template matches the bar grid template so each label sits exactly
       *  under its bar column. */}
      <div className={styles.barChartCenter}>
        <div className={styles.barChartStepLabels}>
          {points.map((p, idx) => (
            <span
              key={`step-${p.stepLabel}-${idx}`}
              className={styles.barChartStepLabel}
              data-base={p.isBase ? 'true' : undefined}
            >
              {p.stepLabel}
            </span>
          ))}
        </div>
      </div>

      {/* Mobile row — same approach as desktop, mirrored. */}
      <div
        className={styles.barChartIcon}
        data-side="mobile"
        aria-label="Mobile"
      >
        <SmartphoneSolidIcon size={14} aria-hidden="true" />
      </div>
      <div
        className={styles.barChartRow}
        data-side="mobile"
        style={{ height: `${mobileRowHeight}px` } as CSSProperties}
      >
        <PillBarRow
          heights={mobileHeights}
          seriesClassName={styles.barChartBarMin}
        />
        <div className={styles.barChartLabelOverlay} aria-hidden="true">
          {points.map((p, idx) => (
            <span
              key={`mobile-label-${p.stepLabel}-${idx}`}
              className={styles.barChartLabelCell}
            >
              <span
                className={styles.barValueLabel}
                data-series="min"
                data-base={p.isBase ? 'true' : undefined}
                style={
                  {
                    // Mobile cells use flex-end (label parked at row bottom).
                    // Pull it up by (maxBar − thisBar) so it rides this bar's
                    // tip — negative translateY moves it up.
                    transform: `translateY(${Math.max(0, p.minPx) - mobileBarHeight}px)`,
                  } as CSSProperties
                }
                title={`${p.variableName}: mobile ${p.minPx}px${p.isBase ? ' (base step)' : ''}`}
              >
                {formatBarValue(p.minPx)}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function SpacingTab() {
  const onToggleDisabled = useEditorStore(
    (s) => s.toggleFrameworkSpacingDisabled,
  );
  const onCreateGroup = useEditorStore((s) => s.createFrameworkSpacingGroup);
  const onUpdateGroup = useEditorStore((s) => s.updateFrameworkSpacingGroup);
  const onDuplicateGroup = useEditorStore(
    (s) => s.duplicateFrameworkSpacingGroup,
  );
  const onResetGroup = useEditorStore((s) => s.resetFrameworkSpacingGroup);
  const onDeleteGroup = useEditorStore((s) => s.deleteFrameworkSpacingGroup);
  const onUpsertManualSize = useEditorStore(
    (s) => s.upsertFrameworkSpacingManualSize,
  );
  const onSetClassGenerators = useEditorStore(
    (s) => s.setFrameworkSpacingClassGenerators,
  );
  const confirmFrameworkChange = useFrameworkChangeConfirm();

  const wrappedToggleDisabled = () =>
    confirmFrameworkChange({
      actionLabel: "Disable spacing framework",
      applyChange: (draft) => {
        const sg = draft.settings.framework?.spacing;
        if (sg) sg.isDisabled = !sg.isDisabled;
      },
      commit: onToggleDisabled,
    });

  const wrappedDeleteGroup = (groupId: string) =>
    confirmFrameworkChange({
      actionLabel: "Delete spacing scale",
      applyChange: (draft) => {
        const sg = draft.settings.framework?.spacing;
        if (!sg) return;
        sg.groups = (sg.groups ?? []).filter((g) => g.id !== groupId);
      },
      commit: () => onDeleteGroup(groupId),
    });

  const wrappedUpdateGroup = (
    groupId: string,
    patch: Parameters<typeof onUpdateGroup>[1],
  ) =>
    confirmFrameworkChange({
      actionLabel: "Update spacing scale",
      applyChange: (draft) =>
        applySpacingGroupPatchPreview(draft, groupId, patch),
      commit: () => onUpdateGroup(groupId, patch),
    });

  const wrappedSetClassGenerators = (
    next: FrameworkSpacingClassGenerator[],
  ) =>
    confirmFrameworkChange({
      actionLabel: "Update spacing class generators",
      applyChange: (draft) => {
        const sg = draft.settings.framework?.spacing;
        if (sg) sg.classes = next;
      },
      commit: () => onSetClassGenerators(next),
    });

  const adapter: ScaleAdapter<
    FrameworkSpacingGroup,
    FrameworkSpacingClassGenerator
  > = {
    title: "Spacing",
    panelId: "spacing",
    selectGroups: (state) =>
      state.site?.settings.framework?.spacing?.groups ?? EMPTY_GROUPS,
    selectClasses: (state) =>
      state.site?.settings.framework?.spacing?.classes ?? EMPTY_CLASSES,
    selectIsDisabled: (state) =>
      Boolean(state.site?.settings.framework?.spacing?.isDisabled),
    ratioOptions: SPACING_RATIO_OPTIONS,
    classGeneratorProperties: SPACING_CSS_PROPERTIES,
    scalesSectionIcon: RulerDimensionSolidIcon,
    baseSizeLabel: "Size",
    readBaseSize: (group, side) => Number(group[side].size),
    patchBaseSize: (side, value) => ({
      [side]: { size: value },
    }),
    // Spacing relies on the unified bar chart above the list, so each
    // per-step row collapses to its text-only header. Returning null
    // skips the body entirely.
    renderPreview: (sizePx) => (
      <span
        className={styles.previewBar}
        style={{ width: `${Math.max(2, sizePx)}px` } as CSSProperties}
      />
    ),
    renderStepBody: () => null,
    renderChart: ({ points }) => <SpacingBarChart points={points} />,
    onToggleDisabled: wrappedToggleDisabled,
    onCreateGroup,
    onUpdateGroup: wrappedUpdateGroup,
    onDuplicateGroup,
    onResetGroup,
    onDeleteGroup: wrappedDeleteGroup,
    onUpsertManualSize,
    onSetClassGenerators: wrappedSetClassGenerators,
  };

  return <FrameworkScalePanel adapter={adapter} />;
}

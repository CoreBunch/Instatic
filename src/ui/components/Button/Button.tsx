/**
 * Button — shared action button primitive for the editor UI.
 *
 * Replaces 33+ one-off button classes across 37 files.
 *
 * Variants:  ghost | secondary | primary | destructive
 * Sizes:     micro (18px) | xs (26px) | sm (28px, default) | md (32px) | lg (44px touch target)
 * Icon-only: iconOnly={true} → square, requires aria-label
 * Pressed:   pressed={true} → aria-pressed + active bg (toolbar toggles)
 * Tooltip:   tooltip={...} → wraps with Tooltip primitive (works for disabled too).
 *            Auto-suppressed while aria-expanded={true} (open dropdown/menu),
 *            so the tooltip never overlays the popup it triggered.
 *
 * Constraints:
 *   - CSS Modules only — no Tailwind, no inline styles (#402/#403)
 *   - Strictly achromatic tokens (#376) — all colours via direct global design tokens vars
 *   - pixel-art-icons only (#350)
 *   - No !important (#403)
 *   - default type="button" (never accidentally submits forms)
 */
import { type Ref, type ReactNode } from "react";
import { cn } from "@ui/cn";
import { Tooltip, type TooltipSide } from "@ui/components/Tooltip";
import styles from "./Button.module.css";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant: "ghost" | "secondary" | "primary" | "destructive";
  size?: "micro" | "xs" | "sm" | "md" | "lg";
  align?: "center" | "start" | "between";
  shape?: "default" | "pill" | "flush";
  tone?: "default" | "danger";
  iconOnly?: boolean;
  pressed?: boolean;
  active?: boolean;
  accentFill?: boolean;
  fullWidth?: boolean;
  menuItem?: boolean;
  navItem?: boolean;
  dangerHover?: boolean;
  numeric?: boolean;
  /**
   * Tooltip content shown on hover. Works even for disabled buttons — icon-only
   * disabled buttons especially benefit from a tooltip to communicate their
   * purpose when they cannot be activated.
   * Note: mouseenter fires on disabled <button> elements in all major browsers.
   */
  tooltip?: ReactNode;
  /** Which side the tooltip should prefer. Default: 'auto'. */
  tooltipSide?: TooltipSide;
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLButtonElement>;
}

export function Button(
  {
    variant,
    size = "sm",
    align = "center",
    shape = "default",
    tone = "default",
    iconOnly = false,
    pressed,
    active = false,
    accentFill: _accentFill = false,
    fullWidth = false,
    menuItem = false,
    navItem = false,
    dangerHover = false,
    numeric = false,
    className,
    children,
    type = "button",
    "aria-label": ariaLabel,
    tooltip,
    tooltipSide,
    // Explicitly destructured so we can intercept disabled+tooltip combos
    // and preserve any direct aria-disabled prop passed by callers.
    disabled,
    onClick,
    ref,
    ...rest
  }: ButtonProps,
) {
    if (import.meta.env.DEV && iconOnly && !ariaLabel) {
      console.warn(
        "[Button] iconOnly={true} requires an aria-label prop for accessibility.",
      );
    }

    // Extract aria-disabled from rest so we can merge it with our own logic.
    const { 'aria-disabled': ariaDisabledRest, ...restProps } = rest

    // When this button is the trigger for an open popup (its `aria-expanded` is
    // true), suppress its tooltip: the open menu/dropdown already makes the
    // button's purpose obvious, and a hover tooltip would overlay the popup.
    // Reading without destructuring keeps `aria-expanded` in restProps so it
    // still lands on the rendered <button> for accessibility.
    const popupOpen = rest['aria-expanded'] === true || rest['aria-expanded'] === 'true'

    // When a tooltip is provided alongside disabled, use aria-disabled instead
    // of the native disabled attribute so that mouseenter still fires and the
    // tooltip can show (native disabled silently swallows pointer events).
    const useAriaDisabled = !!disabled && !!tooltip;

    // effectiveAriaDisabled is true when:
    //   • disabled+tooltip combo (converts to aria-disabled), OR
    //   • caller passed aria-disabled directly (e.g. PagesSection delete button)
    const effectiveAriaDisabled =
      useAriaDisabled || ariaDisabledRest === true || ariaDisabledRest === 'true'

    const button = (
      <button
        ref={ref}
        type={type}
        aria-label={ariaLabel}
        aria-pressed={pressed !== undefined ? pressed : undefined}
        data-active={active ? "true" : undefined}
        data-tone={tone !== "default" ? tone : undefined}
        data-danger-hover={dangerHover ? "true" : undefined}
        className={cn(
          styles.btn,
          styles[`variant-${variant}`],
          styles[`size-${size}`],
          styles[`align-${align}`],
          shape !== "default" && styles[`shape-${shape}`],
          iconOnly && styles.iconOnly,
          fullWidth && styles.fullWidth,
          menuItem && styles.menuItem,
          navItem && styles.navItem,
          numeric && styles.numeric,
          className,
        )}
        {...restProps}
        // Override disabled/aria semantics and click interception for both the
        // disabled+tooltip case and the direct aria-disabled case.
        disabled={useAriaDisabled ? undefined : (disabled || undefined)}
        aria-disabled={effectiveAriaDisabled ? true : undefined}
        onClick={effectiveAriaDisabled ? (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault() : onClick}
      >
        {children}
      </button>
    );

    if (tooltip) {
      return (
        <Tooltip content={tooltip} side={tooltipSide ?? "auto"} disabled={popupOpen}>
          {button}
        </Tooltip>
      );
    }

    return button;
}

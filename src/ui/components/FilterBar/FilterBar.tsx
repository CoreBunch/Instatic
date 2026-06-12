/**
 * FilterBar — reusable horizontal filter/segment row used at the top of panels.
 *
 * Layout (top → bottom):
 *   1. Optional SearchBar
 *   2. Row containing:
 *      - chip group (items rendered as pressable Buttons) + optional inline actions
 *      - optional trailing slot pinned to the right (e.g. view-mode toggles)
 *
 * Selection semantics use `aria-pressed` (toggle) on each chip and a
 * `role="group"` wrapper. This is intentionally minimal — visuals lean on the
 * existing Button primitive so design tweaks happen in one place.
 */
import type { ReactNode } from "react";
import { Button } from "@ui/components/Button";
import { SearchBar } from "@ui/components/SearchBar";
import { cn } from "@ui/cn";
import styles from "./FilterBar.module.css";

export interface FilterBarItem<TValue = string> {
  /** Value compared against `value` to determine the active item. */
  value: TValue;
  /** Display content (text or text + icon). */
  label: ReactNode;
  /** Custom aria-label override. */
  ariaLabel?: string;
  /** Disable an individual item. */
  disabled?: boolean;
}

interface FilterBarSearchProps {
  value: string;
  onValueChange: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  ariaLabel?: string;
}

interface FilterBarProps<TValue = string> {
  items: FilterBarItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  /** Optional search bar rendered above the chip row. */
  search?: FilterBarSearchProps;
  /** Element rendered to the LEFT of the search bar (same row). Use for
   *  primary actions like "Upload" that belong next to the search field. */
  searchLeading?: ReactNode;
  /** Element rendered to the RIGHT of the search bar (same row). Use for
   *  compact actions that should visually pair with filtering. */
  searchTrailing?: ReactNode;
  /** Inline action(s) appended after the chips (same row, e.g. "Add category"). */
  inlineActions?: ReactNode;
  /** Trailing slot pinned to the right of the row (e.g. view-mode toggles). */
  trailing?: ReactNode;
  /** Aria-label for the chip group container. */
  groupLabel?: string;
  className?: string;
}

export function FilterBar<TValue = string>({
  items,
  value,
  onValueChange,
  search,
  searchLeading,
  searchTrailing,
  inlineActions,
  trailing,
  groupLabel,
  className,
}: FilterBarProps<TValue>) {
  return (
    <div className={cn(styles.bar, className)}>
      {search && (
        searchLeading || searchTrailing ? (
          <div className={styles.searchRow}>
            {searchLeading && <div className={styles.searchAction}>{searchLeading}</div>}
            <SearchBar
              value={search.value}
              onValueChange={search.onValueChange}
              onClear={search.onClear}
              placeholder={search.placeholder}
              aria-label={search.ariaLabel}
              className={styles.searchFill}
            />
            {searchTrailing && <div className={styles.searchAction}>{searchTrailing}</div>}
          </div>
        ) : (
          <SearchBar
            value={search.value}
            onValueChange={search.onValueChange}
            onClear={search.onClear}
            placeholder={search.placeholder}
            aria-label={search.ariaLabel}
            className={styles.search}
          />
        )
      )}

      <div className={styles.row}>
        <div className={styles.chips} role="group" aria-label={groupLabel}>
          {items.map((item, index) => {
            const pressed = item.value === value;
            return (
              <Button
                key={typeof item.value === "string" ? item.value : index}
                variant={pressed ? "secondary" : "ghost"}
                size="xs"
                pressed={pressed}
                disabled={item.disabled}
                aria-label={item.ariaLabel}
                onClick={() => onValueChange(item.value)}
              >
                {item.label}
              </Button>
            );
          })}
          {inlineActions}
        </div>
        {trailing && <div className={styles.trailing}>{trailing}</div>}
      </div>
    </div>
  );
}

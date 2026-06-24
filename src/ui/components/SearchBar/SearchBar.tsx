import { type InputHTMLAttributes, type Ref } from "react";
import { Button } from "@ui/components/Button";
import { Input } from "@ui/components/Input";
import { CloseIcon } from "pixel-art-icons/icons/close";
import { SearchSolidIcon } from "pixel-art-icons/icons/search-solid";
import { cn } from "@ui/cn";
import styles from "./SearchBar.module.css";

interface SearchBarProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "size" | "value" | "onChange"
> {
  value: string;
  onValueChange: (value: string) => void;
  onClear?: () => void;
  clearLabel?: string;
  /** React 19: ref is a regular prop on function components. */
  ref?: Ref<HTMLInputElement>;
}

export function SearchBar({
  value,
  onValueChange,
  onClear,
  clearLabel = "Clear search",
  className,
  ref,
  ...inputProps
}: SearchBarProps) {
  function handleClear() {
    if (onClear) onClear();
    else onValueChange("");
  }

  return (
    <div className={cn(styles.searchBar, className)}>
      <SearchSolidIcon
        size={11}
        color="var(--text-subtle)"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        className={styles.input}
        {...inputProps}
      />
      {value && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={handleClear}
          aria-label={clearLabel}
        >
          <CloseIcon size={10} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

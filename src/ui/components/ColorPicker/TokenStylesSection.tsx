import { useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { safeCssColor } from './colorMath'
export interface ColorPickerToken {
  /** The CSS custom-property name, including the leading `--`. */
  name: string
  /** The resolved colour the swatch previews. */
  value: string
  /** Optional secondary label (e.g. a variant name). */
  meta?: string
  /** Stable list key when several tokens share a name. */
  key?: string
}
import styles from './ColorPicker.module.css'

type SwatchVars = CSSProperties & { '--color-picker-swatch'?: string }

interface TokenStylesSectionProps {
  tokens: readonly ColorPickerToken[]
  onSelectToken?: (reference: string) => void
}

export function TokenStylesSection({
  tokens,
  onSelectToken,
}: TokenStylesSectionProps) {
  const [search, setSearch] = useState('')
  const filteredTokens = filterTokens(tokens, search)

  return (
    <div className={styles.tokens}>
      <SearchBar
        value={search}
        onValueChange={setSearch}
        placeholder="Search styles"
        aria-label="Search colour styles"
      />
      <div className={styles.tokenList} role="listbox" aria-label="Colour styles">
        {filteredTokens.map((token) => (
          <Button
            key={token.key ?? token.name}
            variant="ghost"
            size="xs"
            menuItem
            align="start"
            role="option"
            aria-selected={false}
            className={styles.tokenRow}
            onClick={() => onSelectToken?.(`var(${token.name})`)}
          >
            <span
              className={styles.tokenSwatch}
              style={{ '--color-picker-swatch': safeCssColor(token.value) } as SwatchVars}
              aria-hidden="true"
            />
            <span className={styles.tokenName}>{token.name}</span>
            {token.meta && <span className={styles.tokenMeta}>{token.meta}</span>}
          </Button>
        ))}
        {filteredTokens.length === 0 && (
          <p className={styles.tokenEmpty}>No matching styles</p>
        )}
      </div>
    </div>
  )
}

function filterTokens(
  tokens: readonly ColorPickerToken[],
  search: string,
): ColorPickerToken[] {
  const query = search.trim().toLowerCase()
  if (!query) return [...tokens]
  return tokens.filter(
    (token) =>
      token.name.toLowerCase().includes(query) ||
      (token.meta?.toLowerCase().includes(query) ?? false),
  )
}

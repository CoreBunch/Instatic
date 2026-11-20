import { useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import styles from './ColorPicker.module.css'

export interface ColorPickerToken {
  /** The CSS custom-property name, including the leading `--`. */
  name: string
  /** The resolved colour the swatch previews. */
  value: string
}

type SwatchVars = CSSProperties & { '--color-picker-swatch'?: string }

interface TokenStylesSectionProps {
  tokens: readonly ColorPickerToken[]
  onSelectToken: (reference: string) => void
}

export function TokenStylesSection({
  tokens,
  onSelectToken,
}: TokenStylesSectionProps) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filteredTokens = tokens.filter((token) => token.name.toLowerCase().includes(query))

  return (
    <div className={styles.tokens}>
      <SearchBar
        value={search}
        onValueChange={setSearch}
        placeholder="Search styles"
        aria-label="Search colour styles"
      />
      <div className={styles.tokenList} role="group" aria-label="Colour styles">
        {filteredTokens.map((token) => (
          <Button
            key={token.name}
            variant="ghost"
            size="xs"
            menuItem
            align="start"
            className={styles.tokenRow}
            onClick={() => onSelectToken(`var(${token.name})`)}
          >
            <span
              className={styles.tokenSwatch}
              style={{ '--color-picker-swatch': window.CSS.supports('color', token.value) ? token.value : undefined } as SwatchVars}
              aria-hidden="true"
            />
            <span className={styles.tokenName}>{token.name}</span>
          </Button>
        ))}
        {filteredTokens.length === 0 && (
          <p className={styles.tokenEmpty}>No matching styles</p>
        )}
      </div>
    </div>
  )
}

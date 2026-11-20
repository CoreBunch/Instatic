import { useState, type CSSProperties } from 'react'
import type { ColorVariable } from '@ui/lib/colorVariable'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import styles from './ColorPicker.module.css'

type SwatchVars = CSSProperties & { '--color-picker-swatch'?: string }

interface TokenStylesSectionProps {
  assignedToken?: string
  tokens: readonly ColorVariable[]
  onSelectToken: (token: ColorVariable) => void
}

export function TokenStylesSection({
  tokens,
  assignedToken,
  onSelectToken,
}: TokenStylesSectionProps) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filteredTokens = tokens.filter((token) => token.name.toLowerCase().includes(query))

  return (
    <div className={styles.tokens}>
      {assignedToken && <Input fieldSize="xs" monospace readOnly aria-label="Assigned Framework color"
        value={`var(${assignedToken})`} />}
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
            pressed={token.name === assignedToken}
            menuItem
            align="start"
            className={styles.tokenRow}
            onClick={() => onSelectToken(token)}
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

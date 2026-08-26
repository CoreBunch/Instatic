/**
 * TokenStylesSection — the picker's searchable colour-token list plus the
 * "New Style" mint-a-token flow. Split from ColorPicker.tsx purely along the
 * responsibility seam: this section owns its own search / new-name state and
 * never touches the colour-editing surface above it.
 */

import { useState, type CSSProperties } from 'react'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { safeCssColor } from './colorMath'
import type { ColorPickerToken } from './ColorPicker'
import styles from './ColorPicker.module.css'

type SwatchVars = CSSProperties & { '--color-picker-swatch'?: string }

interface TokenStylesSectionProps {
  tokens: readonly ColorPickerToken[]
  onSelectToken?: (reference: string) => void
  /**
   * Mint a style with this name; the picker supplies the colour itself (read
   * through a ref at call time, so this section's props never change during
   * a colour drag and the compiler can skip re-rendering the list).
   */
  onCreateStyle?: (name: string) => void
}

export function TokenStylesSection({
  tokens,
  onSelectToken,
  onCreateStyle,
}: TokenStylesSectionProps) {
  const [search, setSearch] = useState('')
  const [newTokenName, setNewTokenName] = useState<string | null>(null)
  const filteredTokens = filterTokens(tokens, search)

  function submitNewToken() {
    const name = (newTokenName ?? '').trim()
    if (!name || !onCreateStyle) return
    onCreateStyle(name)
    setNewTokenName(null)
  }

  return (
    <>
      {tokens.length > 0 && (
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
      )}

      {onCreateStyle && (
        newTokenName === null ? (
          <Button
            variant="secondary"
            size="xs"
            fullWidth
            align="start"
            onClick={() => setNewTokenName('')}
          >
            <PlusIcon size={11} aria-hidden="true" />
            New Style
          </Button>
        ) : (
          <div className={styles.newStyle}>
            <Input
              fieldSize="xs"
              autoFocus
              prefix="--"
              value={newTokenName}
              aria-label="New style name"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setNewTokenName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submitNewToken()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setNewTokenName(null)
                }
              }}
            />
            <Button
              variant="primary"
              size="xs"
              iconOnly
              aria-label="Create style"
              disabled={newTokenName.trim() === ''}
              onClick={submitNewToken}
            >
              <CheckIcon size={11} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label="Cancel new style"
              onClick={() => setNewTokenName(null)}
            >
              <CloseIcon size={10} aria-hidden="true" />
            </Button>
          </div>
        )
      )}
    </>
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

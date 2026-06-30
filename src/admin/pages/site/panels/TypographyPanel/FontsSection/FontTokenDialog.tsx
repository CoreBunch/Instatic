import { useState, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import type { FontEntry, FontToken } from '@core/fonts'
import {
  defaultFontTokenFallback,
  resolveFontTokenStack,
  suggestFontTokenVariable,
} from '@core/fonts'
import { getErrorMessage } from '@core/utils/errorMessage'
import styles from './FontsSection.module.css'

interface FontTokenDialogProps {
  token?: FontToken
  fonts: FontEntry[]
  onCancel: () => void
  onSave: (input: {
    name: string
    variable: string
    familyId?: string | null
    fallback: string
  }) => void
}

export function FontTokenDialog({
  token,
  fonts,
  onCancel,
  onSave,
}: FontTokenDialogProps) {
  const firstFont = fonts[0]
  const [name, setName] = useState(token?.name ?? 'Primary')
  const [variable, setVariable] = useState(token?.variable ?? suggestFontTokenVariable(token?.name ?? 'Primary'))
  const [familyId, setFamilyId] = useState(token?.familyId ?? firstFont?.id ?? '')
  const [fallback, setFallback] = useState(token?.fallback ?? defaultFontTokenFallback(firstFont))
  const [error, setError] = useState<string | null>(null)
  const assigned = fonts.find((entry) => entry.id === familyId)
  const previewToken: FontToken = {
    id: token?.id ?? 'preview',
    name: name.trim() || 'Font token',
    variable,
    ...(familyId ? { familyId } : {}),
    fallback,
    order: token?.order ?? 0,
    createdAt: token?.createdAt ?? 0,
    updatedAt: token?.updatedAt ?? 0,
  }
  const previewFamily = resolveFontTokenStack(previewToken, { items: fonts, tokens: [previewToken] })
  const variableChanged = Boolean(token && variable.trim() !== token.variable)

  const handleSave = () => {
    setError(null)
    try {
      onSave({
        name,
        variable,
        familyId: familyId || null,
        fallback,
      })
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save font token'))
    }
  }

  return (
    <Dialog
      open
      title={token ? 'Edit font token' : 'Create font token'}
      size="lg"
      onClose={onCancel}
      bodyClassName={styles.tokenDialogBody}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={handleSave}>
            {token ? 'Save token' : 'Create token'}
          </Button>
        </>
      }
    >
      <div className={styles.preview}>
        <div className={styles.previewMeta}>
          <span className={styles.previewFamilyName}>
            {variable.trim() ? `--${variable.replace(/^-+/, '')}` : 'Font variable'}
          </span>
          <span className={styles.previewCategory}>
            {assigned?.family ?? 'Fallback'}
          </span>
        </div>
        <p
          className={styles.previewSample}
          style={{ fontFamily: previewFamily } as CSSProperties}
        >
          Typography lives here
        </p>
      </div>

      <label className={styles.tokenField}>
        <span className={styles.tokenFieldLabel}>Name</span>
        <Input
          type="text"
          fieldSize="md"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <label className={styles.tokenField}>
        <span className={styles.tokenFieldLabel}>Variable</span>
        <Input
          type="text"
          fieldSize="md"
          value={variable}
          prefix="--"
          monospace
          onChange={(event) => setVariable(event.target.value)}
          spellCheck={false}
        />
      </label>

      {variableChanged && (
        <p className={styles.tokenNotice}>
          Existing var(--{token?.variable}) references will be rewritten to this variable.
        </p>
      )}

      <label className={styles.tokenField}>
        <span className={styles.tokenFieldLabel}>Assigned font</span>
        <Select
          fieldSize="md"
          value={familyId}
          onChange={(event) => {
            const nextFamilyId = event.target.value
            setFamilyId(nextFamilyId)
            const nextFont = fonts.find((entry) => entry.id === nextFamilyId)
            if (nextFont) setFallback(defaultFontTokenFallback(nextFont))
          }}
        >
          <option value="">Fallback only</option>
          {fonts.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.family}
            </option>
          ))}
        </Select>
      </label>

      <label className={styles.tokenField}>
        <span className={styles.tokenFieldLabel}>Fallback</span>
        <Input
          type="text"
          fieldSize="md"
          value={fallback}
          onChange={(event) => setFallback(event.target.value)}
          spellCheck={false}
        />
      </label>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}
    </Dialog>
  )
}

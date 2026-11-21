/**
 * TagInput: a short list of text tags, edited as removable pills plus one
 * text field. Enter or a comma adds what is typed; Backspace on an empty
 * field removes the last tag. `validate` returns why a tag is not allowed,
 * shown under the field instead of adding it.
 */
import { useId, useState, type KeyboardEvent } from 'react'
import { Input } from '../Input'
import { TagPill } from '../TagPill'
import styles from './TagInput.module.css'

interface TagInputProps {
  value: readonly string[]
  onChange: (next: string[]) => void
  /** Names the field for assistive tech. */
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  /** Turn what was typed into a tag (trim, lower-case, …) before it is checked. */
  normalize?: (raw: string) => string
  /** Why this tag cannot be added, or null when it can. */
  validate?: (tag: string) => string | null
  maxTags?: number
}

export function TagInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  normalize = (raw) => raw.trim(),
  validate,
  maxTags,
}: TagInputProps) {
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const problemId = useId()
  const full = maxTags !== undefined && value.length >= maxTags

  function commit(): boolean {
    const tag = normalize(draft)
    if (tag === '') {
      setDraft('')
      return true
    }
    if (value.includes(tag)) {
      setDraft('')
      setProblem(null)
      return true
    }
    const reason = full ? `No more than ${maxTags} tags.` : (validate?.(tag) ?? null)
    if (reason) {
      setProblem(reason)
      return false
    }
    onChange([...value, tag])
    setDraft('')
    setProblem(null)
    return true
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter must not submit the surrounding form while a tag is being typed.
      if (draft.trim() !== '' || event.key === ',') event.preventDefault()
      commit()
      return
    }
    if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className={styles.root}>
      {value.length > 0 && (
        <div className={styles.tags}>
          {value.map((tag) => (
            <TagPill
              key={tag}
              label={tag}
              size="sm"
              monospace
              {...(disabled
                ? {}
                : { onRemove: () => onChange(value.filter((other) => other !== tag)), removeAriaLabel: `Remove ${tag}` })}
            />
          ))}
        </div>
      )}
      <Input
        fieldSize="sm"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setProblem(null)
        }}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={problem ? problemId : undefined}
        invalid={problem !== null}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {problem && <p id={problemId} role="alert" className={styles.problem}>{problem}</p>}
    </div>
  )
}

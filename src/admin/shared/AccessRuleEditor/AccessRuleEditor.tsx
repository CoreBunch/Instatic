/**
 * AccessRuleEditor: who may open a page or a table's entries. Used by the
 * page settings dialog and the table settings, so both read the same.
 */
import { useId } from 'react'
import type { AccessRule } from '@core/members'
import { Select } from '@ui/components/Select'
import { MemberTagsInput } from './MemberTagsInput'
import styles from './AccessRuleEditor.module.css'

type Level = AccessRule['level']
type OnDeny = 'login' | 'hide'

const LEVEL_OPTIONS: Array<{ value: Level; label: string }> = [
  { value: 'public', label: 'Anyone' },
  { value: 'members', label: 'Signed-in members' },
  { value: 'tags', label: 'Members with a tag' },
]

const ON_DENY_OPTIONS: Array<{ value: OnDeny; label: string }> = [
  { value: 'login', label: 'Send them to the sign-in page' },
  { value: 'hide', label: 'Answer "not found"' },
]

function isLevel(value: string): value is Level {
  return LEVEL_OPTIONS.some((option) => option.value === value)
}

/** The rule for a newly picked level, keeping what still applies from the old one. */
function withLevel(rule: AccessRule, level: Level): AccessRule {
  const onDeny: OnDeny = rule.level === 'public' ? 'login' : rule.onDeny
  if (level === 'public') return { level: 'public' }
  if (level === 'members') return { level: 'members', onDeny }
  return { level: 'tags', tags: rule.level === 'tags' ? rule.tags : [], onDeny }
}

export function AccessRuleEditor({
  value,
  onChange,
  disabled = false,
  /** What is being protected, as it reads in "Who can open this …". */
  subject,
}: {
  value: AccessRule
  onChange: (next: AccessRule) => void
  disabled?: boolean
  subject: string
}) {
  const levelId = useId()
  const denyId = useId()

  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <label htmlFor={levelId} className={styles.label}>Who can open {subject}</label>
        <Select
          id={levelId}
          fieldSize="sm"
          value={value.level}
          options={LEVEL_OPTIONS}
          disabled={disabled}
          onChange={(event) => {
            const level = event.currentTarget.value
            if (isLevel(level)) onChange(withLevel(value, level))
          }}
        />
      </div>

      {value.level === 'tags' && (
        <div className={styles.field}>
          <span className={styles.label}>Tags (a member needs any one)</span>
          <MemberTagsInput
            value={value.tags}
            disabled={disabled}
            onChange={(tags) => onChange({ ...value, tags })}
          />
        </div>
      )}

      {value.level !== 'public' && (
        <div className={styles.field}>
          <label htmlFor={denyId} className={styles.label}>When someone else tries to open it</label>
          <Select
            id={denyId}
            fieldSize="sm"
            value={value.onDeny}
            options={ON_DENY_OPTIONS}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...value, onDeny: event.currentTarget.value === 'hide' ? 'hide' : 'login' })
            }
          />
          {value.onDeny === 'login' && (
            <p className={styles.hint}>
              Uses the sign-in page set under Users, Site members, Member settings. With none set, the answer
              is "not found". A signed-in member who may not open it always gets "not found".
            </p>
          )}
        </div>
      )}
    </div>
  )
}

import { isGrantableMemberTag } from '@core/members'
import { TagInput } from '@ui/components/TagInput'

/** A tag as members hold it: lower-case, no spaces. */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-')
}

function tagProblem(tag: string): string | null {
  return isGrantableMemberTag(tag)
    ? null
    : 'Use lower-case letters, digits, and . _ : - (start with a letter or a digit).'
}

/** The member tags a rule asks for. A member needs any one of them. */
export function MemberTagsInput({
  value,
  onChange,
  disabled,
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  return (
    <TagInput
      value={value}
      onChange={onChange}
      ariaLabel="Member tags"
      placeholder={value.length === 0 ? 'Type a tag and press Enter' : 'Add another tag'}
      normalize={normalizeTag}
      validate={tagProblem}
      maxTags={20}
      disabled={disabled}
    />
  )
}

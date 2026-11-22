/**
 * ShowWhenControl: which visitors an element is rendered for.
 *
 * The rule lives on the node as the `showWhen` prop and is applied on the
 * server, so an element a visitor may not see is not in the page they get.
 * It hides one element; it does not protect a page (that is Page settings).
 */
import { useId } from 'react'
import { MemberTagsInput } from '@admin/shared/AccessRuleEditor'
import { readShowWhen, SHOW_WHEN_PROP_KEY, type ShowWhen } from '@core/members'
import { subtreeHasOutlet } from '@core/templates'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { Select } from '@ui/components/Select'
import styles from './ShowWhenControl.module.css'

type Audience = 'everyone' | ShowWhen['visitor']

const AUDIENCE_OPTIONS: Array<{ value: Audience; label: string }> = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'signedIn', label: 'Signed-in members' },
  { value: 'signedOut', label: 'Signed-out visitors' },
  { value: 'tags', label: 'Members with a tag' },
  { value: 'appAsking', label: 'Members an app is asking to sign in' },
  { value: 'noAppAsking', label: 'Members no app is asking for' },
]

const HINT: Record<Audience | 'nobody', string> = {
  everyone: 'Every visitor gets this element.',
  signedIn: 'Left out of the page for visitors who are not signed in.',
  signedOut: 'Left out of the page for signed-in members. Good for "Sign in" links.',
  tags: 'Only members holding one of these tags get this element.',
  appAsking: 'For the page where apps are approved: shown only when an app sent the member there.',
  noAppAsking: 'For the page where apps are approved: shown when a member opens it without an app asking.',
  nobody: 'This rule could not be read, so nobody gets the element. Pick an option to fix it.',
}

function isEmptyTagRule(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const rule = raw as { visitor?: unknown; tags?: unknown }
  return rule.visitor === 'tags' && Array.isArray(rule.tags) && rule.tags.length === 0
}

function isAudience(value: string): value is Audience {
  return AUDIENCE_OPTIONS.some((option) => option.value === value)
}

export function ShowWhenControl({
  nodeId,
  props,
  readOnly,
}: {
  nodeId: string
  props: Record<string, unknown>
  readOnly: boolean
}) {
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const selectId = useId()
  // The outlet is where a page or an entry is placed. Those are fetched on
  // their own, so a rule on an element around the outlet cannot be applied
  // to them: the element would simply come out empty. Limiting the content
  // is what page and table access are for.
  const holdsOutlet = useEditorStore((s) => {
    const page = selectActiveCanvasPage(s)
    return page ? subtreeHasOutlet(page.nodes, nodeId) : false
  })
  const rule = readShowWhen(props)
  // A tag rule with no tag yet is not a valid rule (nobody passes it), but
  // it is the state the author is in right after picking "Members with a tag".
  const pickingTags = rule === 'nobody' && isEmptyTagRule(props[SHOW_WHEN_PROP_KEY])
  const audience: Audience | 'nobody' = pickingTags
    ? 'tags'
    : rule === null ? 'everyone' : rule === 'nobody' ? 'nobody' : rule.visitor
  const tags = rule !== null && rule !== 'nobody' && rule.visitor === 'tags' ? rule.tags : []

  // `tags: []` is stored while the author is still typing the first tag; the
  // publisher reads it as "nobody", which is the safe side.
  function save(next: ShowWhen | { visitor: 'tags'; tags: string[] } | undefined) {
    updateNodeProps(nodeId, { [SHOW_WHEN_PROP_KEY]: next })
  }

  function pickAudience(next: Audience) {
    if (next === 'everyone') save(undefined)
    else if (next === 'tags') save({ visitor: 'tags', tags })
    else save({ visitor: next })
  }

  return (
    <section className={styles.root} aria-label="Visibility" data-testid="show-when-control">
      <label htmlFor={selectId} className={styles.label}>Show to</label>
      <Select
        id={selectId}
        fieldSize="sm"
        value={audience === 'nobody' ? '' : audience}
        options={AUDIENCE_OPTIONS}
        placeholder="Pick who sees this"
        disabled={readOnly || (holdsOutlet && rule === null)}
        onChange={(event) => {
          const next = event.currentTarget.value
          if (isAudience(next)) pickAudience(next)
        }}
      />
      {audience === 'tags' && (
        <MemberTagsInput
          value={tags}
          disabled={readOnly}
          onChange={(nextTags) => save({ visitor: 'tags', tags: nextTags })}
        />
      )}
      <p className={styles.hint} data-tone={audience === 'nobody' || (holdsOutlet && rule !== null) ? 'danger' : undefined}>
        {holdsOutlet
          ? rule === null
            ? 'This element holds the page content, so it cannot be limited here. To limit pages, use Access in page settings.'
            : 'This element holds the page content, which a rule here leaves out for every visitor. Set it back to Everyone and use Access in page settings.'
          : audience === 'tags' && tags.length === 0
            ? 'Add at least one tag. Until then nobody gets this element.'
            : HINT[audience]}
      </p>
    </section>
  )
}

import { expect, it } from 'bun:test'
import { editCornerRadii } from '@site/property-controls/cornerRadii'

it('edits a single corner without writing the other corners into the active context', () => {
  expect(editCornerRadii({}, '8px', 'nw')).toEqual({ borderTopLeftRadius: '8px' })
})

it('keeps a variable shorthand in the cascade when editing a single corner', () => {
  expect(editCornerRadii({ borderRadius: 'var(--card-radius)' }, '8px', 'ne'))
    .toEqual({ borderTopRightRadius: '8px' })
})

/**
 * The two gates a command can carry, and why they are not the same thing.
 *
 * `when` says "you have something to act on right now" — a selection, an
 * undoable edit. It hides the command when false AND scores +250 when true,
 * so a command that matches the moment beats one that merely matches the
 * query text.
 *
 * `available` says "this command exists in this environment at all" —
 * publishing on main, branch actions off main. It hides when false and
 * scores nothing. Using `when` for that kind of gate hands the command a
 * standing +250 wherever it applies, which outranks the +150 recency boost
 * and pins it to the top of an empty palette forever.
 */
import { describe, expect, it } from 'bun:test'
import { rankCommands } from '@admin/spotlight/matcher'
import type { Command, CommandContext } from '@admin/spotlight/types'

const ctx = {
  workspace: 'dashboard',
  pathname: '/admin/dashboard',
  user: { capabilities: [] },
} as unknown as CommandContext

function command(id: string, title: string, extra: Partial<Command> = {}): Command {
  return {
    id: id as Command['id'],
    title,
    group: 'navigation',
    run: () => {},
    ...extra,
  } as Command
}

describe('spotlight command gating', () => {
  it('lets a recently run command outrank an environment-gated one', () => {
    const recent = command('nav-content', 'Go to Content')
    const gated = command('editor-publish', 'Publish', { available: () => true })

    const ranked = rankCommands([gated, recent], '', ctx, ['nav-content'])

    expect(ranked[0]?.command.id).toBe('nav-content')
  })

  it('still lets a contextually relevant command outrank recency', () => {
    const recent = command('nav-content', 'Go to Content')
    // `when` is the "you have a selection right now" case: it should win.
    const contextual = command('layers-duplicate', 'Duplicate layer', { when: () => true })

    const ranked = rankCommands([recent, contextual], '', ctx, ['nav-content'])

    expect(ranked[0]?.command.id).toBe('layers-duplicate')
  })

  it('scores an available-gated command exactly like an ungated one', () => {
    const plain = command('a-plain', 'Same Title')
    const gated = command('b-gated', 'Same Title', { available: () => true })

    const ranked = rankCommands([plain, gated], 'same title', ctx, [])

    expect(ranked).toHaveLength(2)
    expect(ranked[0]?.score).toBe(ranked[1]!.score)
  })
})

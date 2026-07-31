import { describe, expect, it } from 'bun:test'
import { getToolCallDisplay } from '@site/panels/AgentPanel'

describe('site_apply_css tool-call display', () => {
  it('distinguishes each CSS mutation operation', () => {
    expect(getToolCallDisplay('site_apply_css', {
      operation: 'merge',
      css: '.card { color: red; }',
    })).toMatchObject({ title: 'Updating CSS', detail: '.card', tone: 'style' })

    expect(getToolCallDisplay('site_apply_css', {
      operation: 'replace',
      css: '.card { color: blue; }',
    })).toMatchObject({ title: 'Replacing CSS', detail: '.card', tone: 'style' })

    expect(getToolCallDisplay('site_apply_css', {
      operation: 'delete',
      selectors: ['.card', '.legacy'],
    })).toMatchObject({
      title: 'Deleting CSS rules',
      detail: '.card, .legacy',
      tone: 'danger',
    })

    expect(getToolCallDisplay('site_apply_css', {
      operation: 'remove-properties',
      selectors: ['.card'],
      properties: ['background', 'background-clip'],
    })).toMatchObject({
      title: 'Removing CSS properties',
      detail: '.card · background, background-clip',
      tone: 'danger',
    })
  })
})

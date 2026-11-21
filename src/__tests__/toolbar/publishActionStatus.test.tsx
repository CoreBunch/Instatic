/**
 * A blocked publish disables its button, so the status text beside it is the
 * only thing left to hover. It has to carry the explanation.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PublishActionGroup } from '@site/toolbar/PublishActionGroup'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'

afterEach(cleanup)

const baseProps = {
  publishLabel: 'Publish',
  publishAriaLabel: 'Cannot publish: 2 code errors',
  publishTitle: 'Cannot publish',
  publishIcon: CloudUploadSolidIcon,
  onPublish: () => {},
  menuItems: [],
}

describe('publish status text', () => {
  it('reveals the detail on hover when the publish button is disabled', async () => {
    render(
      <PublishActionGroup
        {...baseProps}
        publishDisabled
        statusLabel="2 code errors"
        statusTone="danger"
        statusTooltip={<p>src/scripts/broken.ts could not be built</p>}
      />,
    )

    const status = screen.getByRole('status')
    expect(status.getAttribute('data-has-detail')).toBe('true')
    fireEvent.mouseEnter(status)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip.textContent).toContain('src/scripts/broken.ts could not be built')
  })

  it('stays a plain label when there is nothing to explain', () => {
    render(<PublishActionGroup {...baseProps} statusLabel="Draft synced" />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('data-has-detail')).toBeNull()
    fireEvent.mouseEnter(status)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

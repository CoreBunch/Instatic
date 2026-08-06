import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { AppLoadingScreen } from '@admin/AppLoadingScreen'
import { I18nProvider } from '@admin/i18n'

afterEach(cleanup)

describe('AppLoadingScreen', () => {
  it('renders one accessible centered loader without visible raw loading text or skeleton chrome', () => {
    render(
      <I18nProvider initialLocale="en">
        <AppLoadingScreen />
      </I18nProvider>,
    )

    const status = screen.getByRole('status', { name: /loading instatic/i })
    expect(status.getAttribute('aria-busy')).toBe('true')
    expect(status.querySelector('[data-loader-spinner="true"]')).not.toBeNull()
    expect(status.querySelector('[data-editor-skeleton="true"]')).toBeNull()
    expect(screen.queryByText(/^Loading\.\.\.$/)).toBeNull()
  })
})

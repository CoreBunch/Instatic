import { beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'bun:test'
import { AdminPreAuthForm } from '@admin/preauth/AdminPreAuthForm'
import {
  ADMIN_LOCALE_STORAGE_KEY,
  I18nProvider,
  readAdminLocalePreference,
  resolveInitialAdminLocale,
  translate,
  writeAdminLocalePreference,
} from '@admin/i18n'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.lang = 'en'
})

afterEach(cleanup)

describe('admin i18n', () => {
  it('defaults to Simplified Chinese until the user chooses a locale', () => {
    expect(resolveInitialAdminLocale()).toBe('zh-CN')
    writeAdminLocalePreference('en')
    expect(resolveInitialAdminLocale()).toBe('en')
  })

  it('formats translated messages with parameters', () => {
    expect(translate('zh-CN', 'preauth.error.passwordTooShort', { min: 12 }))
      .toBe('密码至少需要 12 个字符')
  })

  it('validates persisted locale preferences', () => {
    writeAdminLocalePreference('zh-CN')
    expect(readAdminLocalePreference()).toBe('zh-CN')

    localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, JSON.stringify({ locale: 'de' }))
    expect(readAdminLocalePreference()).toBeNull()

    localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, '{invalid json')
    expect(readAdminLocalePreference()).toBeNull()
  })

  it('renders and switches the setup flow in place', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <AdminPreAuthForm
          phase="setup"
          publicSite={{ name: null, faviconUrl: null }}
          initialError={null}
          onPhaseChange={() => {}}
          onAuthenticated={() => {}}
        />
      </I18nProvider>,
    )

    expect(screen.getByRole('heading', { name: '初始化 CMS' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: '站点名称' }).getAttribute('value')).toBe('我的站点')
    expect(screen.getByRole('button', { name: '创建管理员' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('zh-CN')

    fireEvent.click(screen.getByRole('button', { name: '切换语言为English' }))

    expect(screen.getByRole('heading', { name: 'Set Up CMS' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create Admin' })).toBeTruthy()
    expect(readAdminLocalePreference()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})

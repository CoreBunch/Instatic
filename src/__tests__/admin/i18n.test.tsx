import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach } from 'bun:test'
import { AdminPreAuthForm } from '@admin/preauth/AdminPreAuthForm'
import {
  ADMIN_LOCALE_STORAGE_KEY,
  DEFAULT_ADMIN_LOCALE,
  I18nProvider,
  readAdminLocalePreference,
  resolveInitialAdminLocale,
  translate,
  writeAdminLocalePreference,
} from '@admin/i18n'
import { getActiveAdminLocale, localizeAdminLiteral, setActiveAdminLocale } from '@admin/i18n/runtime'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.lang = 'en'
  setActiveAdminLocale(DEFAULT_ADMIN_LOCALE)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  setActiveAdminLocale(DEFAULT_ADMIN_LOCALE)
})

function SetupForm() {
  return (
    <AdminPreAuthForm
      phase="setup"
      publicSite={{ name: null, faviconUrl: null }}
      initialError={null}
      onPhaseChange={() => {}}
      onAuthenticated={() => {}}
    />
  )
}

describe('admin i18n', () => {
  it('defaults to English and preserves an explicit Chinese preference', () => {
    expect(DEFAULT_ADMIN_LOCALE).toBe('en')
    expect(resolveInitialAdminLocale()).toBe('en')
    expect(localizeAdminLiteral('Checking code', '正在检查代码')).toBe('Checking code')
    writeAdminLocalePreference('zh-CN')
    expect(resolveInitialAdminLocale()).toBe('zh-CN')
    writeAdminLocalePreference('en')
    expect(resolveInitialAdminLocale()).toBe('en')
  })

  it('renders English for a fresh visitor, saves Chinese, and restores it on remount', () => {
    const view = render(<I18nProvider><SetupForm /></I18nProvider>)
    expect(screen.getByRole('heading', { name: 'Set Up CMS' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Site name' }).getAttribute('value')).toBe('My Site')
    expect(readAdminLocalePreference()).toBeNull()
    expect(document.documentElement.lang).toBe('en')

    fireEvent.click(screen.getByRole('button', { name: 'Switch language to 简体中文' }))
    expect(screen.getByRole('heading', { name: '初始化 CMS' })).toBeTruthy()
    expect(readAdminLocalePreference()).toBe('zh-CN')
    expect(getActiveAdminLocale()).toBe('zh-CN')
    expect(localizeAdminLiteral('Checking code', '正在检查代码')).toBe('正在检查代码')

    view.unmount()
    render(<I18nProvider><SetupForm /></I18nProvider>)
    expect(screen.getByRole('heading', { name: '初始化 CMS' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('synchronizes language changes and preference removal across tabs', () => {
    render(<I18nProvider><SetupForm /></I18nProvider>)
    act(() => {
      writeAdminLocalePreference('zh-CN')
      window.dispatchEvent(new window.StorageEvent('storage', { key: ADMIN_LOCALE_STORAGE_KEY }))
    })
    expect(screen.getByRole('heading', { name: '初始化 CMS' })).toBeTruthy()

    act(() => {
      localStorage.removeItem(ADMIN_LOCALE_STORAGE_KEY)
      window.dispatchEvent(new window.StorageEvent('storage', { key: ADMIN_LOCALE_STORAGE_KEY }))
    })
    expect(screen.getByRole('heading', { name: 'Set Up CMS' })).toBeTruthy()
    expect(getActiveAdminLocale()).toBe('en')
  })

  it('returns to English when another tab clears local storage', () => {
    writeAdminLocalePreference('zh-CN')
    render(<I18nProvider><SetupForm /></I18nProvider>)
    act(() => {
      localStorage.clear()
      window.dispatchEvent(new window.StorageEvent('storage', { key: null }))
    })
    expect(screen.getByRole('heading', { name: 'Set Up CMS' })).toBeTruthy()
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back safely when storage reads are blocked', () => {
    const read = spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    try {
      expect(readAdminLocalePreference()).toBeNull()
      expect(resolveInitialAdminLocale()).toBe('en')
    } finally {
      read.mockRestore()
    }
  })

  it('still switches the live UI when storage writes are blocked', () => {
    const write = spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    try {
      render(<I18nProvider><SetupForm /></I18nProvider>)
      fireEvent.click(screen.getByRole('button', { name: 'Switch language to 简体中文' }))
      expect(screen.getByRole('heading', { name: '初始化 CMS' })).toBeTruthy()
      expect(document.documentElement.lang).toBe('zh-CN')
    } finally {
      write.mockRestore()
    }
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
    expect(resolveInitialAdminLocale()).toBe('en')

    localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, '{invalid json')
    expect(readAdminLocalePreference()).toBeNull()
    expect(resolveInitialAdminLocale()).toBe('en')
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

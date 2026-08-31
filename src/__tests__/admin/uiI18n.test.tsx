import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@admin/i18n'
import { uiMessageCatalogs } from '@admin/i18n/uiMessages'
import { setActiveAdminLocale } from '@admin/i18n/runtime'
import { englishUiMessages, formatUiMessage, type UiMessageKey } from '@ui/i18n'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { ToastProvider, pushToast } from '@ui/components/Toast'

afterEach(() => {
  cleanup()
  setActiveAdminLocale('en')
})

describe('shared UI localization', () => {
  it('has complete translations with matching placeholders for every primitive message', () => {
    expect(Object.keys(uiMessageCatalogs['zh-CN']).sort()).toEqual(Object.keys(englishUiMessages).sort())
    for (const key of Object.keys(englishUiMessages) as UiMessageKey[]) {
      const english = englishUiMessages[key]
      const chinese = uiMessageCatalogs['zh-CN'][key]
      expect(chinese.length).toBeGreaterThan(0)
      expect(chinese.match(/\{\w+\}/g)?.sort() ?? []).toEqual(english.match(/\{\w+\}/g)?.sort() ?? [])
    }
    expect(formatUiMessage(uiMessageCatalogs['zh-CN'], 'removeItem', { label: 'Customer Name' }))
      .toBe('移除Customer Name')
  })

  it('keeps shared primitive defaults English outside the admin provider', () => {
    render(<SearchBar value="example" onValueChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeTruthy()
  })

  it('localizes primitive controls while leaving caller content untouched', () => {
    render(
      <I18nProvider initialLocale="zh-CN">
        <Dialog open title="Customer Name" onClose={() => {}}>
          <Input type="number" defaultValue={3} aria-label="Quantity" />
          <SearchBar value="Customer Name" onValueChange={() => {}} />
          <Select aria-label="Choose option" searchable options={[{ value: 'stable-id', label: 'Customer Name' }]} />
        </Dialog>
      </I18nProvider>,
    )
    expect(screen.getByRole('heading', { name: 'Customer Name' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭对话框' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清除搜索' })).toBeTruthy()
    // The spinner buttons are intentionally hidden from AT; the native input owns keyboard steps.
    expect(screen.getByLabelText('增加')).toBeTruthy()
    expect(screen.getByLabelText('减少')).toBeTruthy()
    fireEvent.click(screen.getByRole('combobox', { name: 'Choose option' }))
    expect(screen.getByRole('option', { name: 'Customer Name' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索…'), { target: { value: 'no-match-query' } })
    expect(screen.getByText('无匹配项')).toBeTruthy()
  })

  it('localizes notification chrome without rewriting an error message', () => {
    render(<I18nProvider initialLocale="zh-CN"><ToastProvider /></I18nProvider>)
    act(() => { pushToast({ kind: 'error', title: 'Provider error: Original details', durationMs: null }) })
    expect(screen.getByText('Provider error: Original details')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭通知' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

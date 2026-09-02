import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@admin/i18n'
import { setActiveAdminLocale } from '@admin/i18n/runtime'
import { SchedulePublishDialog } from '@admin/modals/SchedulePublishDialog'
import { DateTimePicker } from '@ui/components/DateTimePicker'
import { formatNumber } from '@admin/ai/usageFormat'
import { formatRelativeTime } from '@site/panels/AgentPanel/relativeTime'
import { formatCapabilitySummary, formatDateTime } from '@admin/pages/users/utils/format'
import { makeCmsRunProgress } from '@admin/modals/SiteImport/shared/importProgress'
import { formatDashboardGreeting } from '@admin/pages/dashboard/greeting'

beforeEach(() => setActiveAdminLocale('en'))
afterEach(() => {
  cleanup()
  setActiveAdminLocale('en')
})

describe('admin locale formatting', () => {
  it('formats whole greetings without English fragments or empty names', () => {
    const morning = new Date(2026, 7, 31, 9)
    expect(formatDashboardGreeting(null, morning)).toBe('Good morning.')
    expect(formatDashboardGreeting(' Alice Smith ', morning)).toBe('Good morning, Alice.')
    setActiveAdminLocale('zh-CN')
    expect(formatDashboardGreeting('', morning)).toBe('早上好。')
    expect(formatDashboardGreeting('王小明', morning)).toBe('王小明，早上好。')
    expect(formatDashboardGreeting(undefined, new Date(2026, 7, 31, 15))).toBe('下午好。')
    expect(formatDashboardGreeting('Alice', new Date(2026, 7, 31, 20))).toBe('Alice，晚上好。')
  })
  it('uses the selected locale for dates and numbers', () => {
    const timestamp = '2026-08-31T10:20:00Z'
    for (const locale of ['en', 'zh-CN'] as const) {
      setActiveAdminLocale(locale)
      expect(formatDateTime(timestamp)).toBe(new Date(timestamp).toLocaleString(locale))
      expect(formatNumber(12345.6)).toBe((12345.6).toLocaleString(locale, { maximumFractionDigits: 0 }))
    }
  })

  it('localizes helper messages that are not JSX literals', () => {
    expect(formatDateTime(null)).toBe('Never')
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5m')
    expect(formatCapabilitySummary(['one'])).toBe('1 capability')
    setActiveAdminLocale('zh-CN')
    expect(formatDateTime(null)).toBe('从未')
    expect(formatRelativeTime(Date.now())).toBe('刚刚')
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5分钟')
    expect(formatRelativeTime(Date.now() - 3 * 3_600_000)).toBe('3小时')
    expect(formatRelativeTime(Date.now() - 2 * 86_400_000)).toBe('2天')
    expect(formatCapabilitySummary([])).toBe('没有后台权限')
    expect(formatCapabilitySummary(['one'])).toBe('1 项权限')
    expect(formatCapabilitySummary(['one', 'two'])).toBe('2 项权限')
    expect(makeCmsRunProgress({ site: 1, rows: 0, media: 0, mediaFolders: 0, redirects: 0 }).currentItem)
      .toBe('正在导入站点数据包…')
  })

  it('keeps the standalone date picker English and confirms the same local datetime', () => {
    const date = new Date(2100, 7, 31, 14, 30)
    let confirmed: Date | null = null
    render(<DateTimePicker value={date} onCancel={() => {}} onConfirm={(next) => { confirmed = next }} />)
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Hours' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(confirmed).toEqual(date)
  })

  it('passes Chinese copy to the scheduling calendar and keeps its controls functional', () => {
    const date = new Date(2100, 7, 31, 14, 30)
    render(
      <I18nProvider initialLocale="zh-CN">
        <SchedulePublishDialog
          open
          rowId="local-test-row"
          currentScheduledAt={date.toISOString()}
          entityLabel="page"
          onClose={() => {}}
          onScheduled={() => {}}
        />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消', exact: true })).toBeTruthy()
    expect(screen.getByRole('grid', { name: '2100年8月的日期' })).toBeTruthy()
    expect(screen.getByRole('gridcell', { name: date.toLocaleDateString('zh-CN', { dateStyle: 'full' }) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下个月' }))
    expect(screen.getByRole('grid', { name: '2100年9月的日期' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '增加小时' }))
    expect((screen.getByRole('textbox', { name: '小时' }) as HTMLInputElement).value).toBe('15')
  })
})

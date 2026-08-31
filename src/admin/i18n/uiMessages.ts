import { englishUiMessages, type UiMessageCatalog } from '@ui/i18n'
import type { AdminLocale } from './catalog'

export const uiMessageCatalogs: Record<AdminLocale, UiMessageCatalog> = {
  en: englishUiMessages,
  'zh-CN': {
    selectOption: '选择选项',
    noMatches: '无匹配项',
    search: '搜索…',
    clearSearch: '清除搜索',
    clearItem: '清除{label}',
    removeItem: '移除{label}',
    close: '关闭',
    closeDialog: '关闭对话框',
    moreActions: '更多操作',
    notifications: '通知',
    dismissNotification: '关闭通知',
    increase: '增加',
    decrease: '减少',
    loadingWidget: '正在加载组件',
    widgetOptions: '{title}选项',
    renderFailed: '{location}渲染失败',
    copyDetails: '复制详情',
    loadFailed: '页面的这一部分加载失败。',
    retryHelp: '错误已记录。你可以重试或刷新页面。',
    componentStack: '组件堆栈',
    reset: '重试',
  },
}

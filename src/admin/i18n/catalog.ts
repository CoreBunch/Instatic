export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const

export type AdminLocale = (typeof SUPPORTED_LOCALES)[number]

export const DEFAULT_ADMIN_LOCALE: AdminLocale = 'en'

const en = {
  'dashboard.morning': 'Good morning.',
  'dashboard.morningNamed': 'Good morning, {name}.',
  'dashboard.afternoon': 'Good afternoon.',
  'dashboard.afternoonNamed': 'Good afternoon, {name}.',
  'dashboard.evening': 'Good evening.',
  'dashboard.eveningNamed': 'Good evening, {name}.',
  'time.now': 'now',
  'time.minutesShort': '{count}m',
  'time.hoursShort': '{count}h',
  'time.daysShort': '{count}d',
  'time.never': 'Never',
  'users.noCapabilities': 'No admin capabilities',
  'users.oneCapability': '1 capability',
  'users.capabilities': '{count} capabilities',
  'import.bundleProgress': 'Importing site bundle…',
  'datePicker.calendar': 'Calendar',
  'datePicker.picker': 'Date and time picker',
  'datePicker.previousMonth': 'Previous month',
  'datePicker.nextMonth': 'Next month',
  'datePicker.time': 'Time',
  'datePicker.hours': 'Hours',
  'datePicker.minutes': 'Minutes',
  'datePicker.timeHelp': '24-hour · local time',
  'datePicker.cancel': 'Cancel',
  'datePicker.confirm': 'Confirm',
  'datePicker.days': '{month} days',
  'datePicker.increase': 'Increase {unit}',
  'datePicker.decrease': 'Decrease {unit}',
  'app.loading': 'Loading Instatic',
  'language.switchTo': 'Switch language to {language}',
  'preauth.setup.title': 'Set Up CMS',
  'preauth.login.title': 'Admin Login',
  'preauth.mfa.title': 'Two-Factor Authentication',
  'preauth.setup.submit': 'Create Admin',
  'preauth.setup.submitPending': 'Setting up',
  'preauth.login.submit': 'Sign In',
  'preauth.login.submitPending': 'Signing in',
  'preauth.mfa.submit': 'Verify',
  'preauth.mfa.submitPending': 'Verifying',
  'preauth.field.authenticationCode': 'Authentication code',
  'preauth.field.siteName': 'Site name',
  'preauth.field.displayName': 'Your name',
  'preauth.field.displayNameHint': 'optional, shown on published pages',
  'preauth.field.email': 'Email',
  'preauth.field.password': 'Password',
  'preauth.setup.defaultSiteName': 'My Site',
  'preauth.error.passwordTooShort': 'Password must be at least {min} characters',
  'preauth.error.setupFailed': 'Setup failed',
  'preauth.error.loginFailed': 'Login failed',
  'preauth.error.mfaVerificationFailed': 'MFA verification failed',
} as const

export type MessageKey = keyof typeof en
export type MessageParams = Record<string, string | number>
export type TranslationCatalog = Record<MessageKey, string>

const zhCN: TranslationCatalog = {
  'dashboard.morning': '早上好。',
  'dashboard.morningNamed': '{name}，早上好。',
  'dashboard.afternoon': '下午好。',
  'dashboard.afternoonNamed': '{name}，下午好。',
  'dashboard.evening': '晚上好。',
  'dashboard.eveningNamed': '{name}，晚上好。',
  'time.now': '刚刚',
  'time.minutesShort': '{count}分钟',
  'time.hoursShort': '{count}小时',
  'time.daysShort': '{count}天',
  'time.never': '从未',
  'users.noCapabilities': '没有后台权限',
  'users.oneCapability': '1 项权限',
  'users.capabilities': '{count} 项权限',
  'import.bundleProgress': '正在导入站点数据包…',
  'datePicker.calendar': '日历',
  'datePicker.picker': '日期和时间选择器',
  'datePicker.previousMonth': '上个月',
  'datePicker.nextMonth': '下个月',
  'datePicker.time': '时间',
  'datePicker.hours': '小时',
  'datePicker.minutes': '分钟',
  'datePicker.timeHelp': '24 小时制 · 本地时间',
  'datePicker.cancel': '取消',
  'datePicker.confirm': '确认',
  'datePicker.days': '{month}的日期',
  'datePicker.increase': '增加{unit}',
  'datePicker.decrease': '减少{unit}',
  'app.loading': '正在加载 Instatic',
  'language.switchTo': '切换语言为{language}',
  'preauth.setup.title': '初始化 CMS',
  'preauth.login.title': '管理员登录',
  'preauth.mfa.title': '双重身份验证',
  'preauth.setup.submit': '创建管理员',
  'preauth.setup.submitPending': '正在初始化',
  'preauth.login.submit': '登录',
  'preauth.login.submitPending': '正在登录',
  'preauth.mfa.submit': '验证',
  'preauth.mfa.submitPending': '正在验证',
  'preauth.field.authenticationCode': '验证码',
  'preauth.field.siteName': '站点名称',
  'preauth.field.displayName': '你的名字',
  'preauth.field.displayNameHint': '可选，将显示在已发布的页面上',
  'preauth.field.email': '邮箱',
  'preauth.field.password': '密码',
  'preauth.setup.defaultSiteName': '我的站点',
  'preauth.error.passwordTooShort': '密码至少需要 {min} 个字符',
  'preauth.error.setupFailed': '初始化失败',
  'preauth.error.loginFailed': '登录失败',
  'preauth.error.mfaVerificationFailed': '双重身份验证失败',
}

const CATALOGS: Record<AdminLocale, TranslationCatalog> = {
  en,
  'zh-CN': zhCN,
}

export const LOCALE_NATIVE_NAMES: Record<AdminLocale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

export function translate(
  locale: AdminLocale,
  key: MessageKey,
  params: MessageParams = {},
): string {
  return CATALOGS[locale][key].replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined ? placeholder : String(value)
  })
}

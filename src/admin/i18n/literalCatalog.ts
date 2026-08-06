import { accountZhCN } from './locales/zh-CN/account'
import { aiZhCN } from './locales/zh-CN/ai'
import { contentZhCN } from './locales/zh-CN/content'
import { dataZhCN } from './locales/zh-CN/data'
import { mediaZhCN } from './locales/zh-CN/media'
import { modalsZhCN } from './locales/zh-CN/modals'
import { dashboardZhCN } from './locales/zh-CN/dashboard'
import { pluginsZhCN } from './locales/zh-CN/plugins'
import { sharedZhCN } from './locales/zh-CN/shared'
import { spotlightZhCN } from './locales/zh-CN/spotlight'
import { siteAZhCN } from './locales/zh-CN/site-a'
import { siteBZhCN } from './locales/zh-CN/site-b'
import { siteCZhCN } from './locales/zh-CN/site-c'
import { siteDZhCN } from './locales/zh-CN/site-d'
import { usersZhCN } from './locales/zh-CN/users'

export const adminLiteralZhCN = {
  ...sharedZhCN,
  ...dashboardZhCN,
  ...pluginsZhCN,
  ...usersZhCN,
  ...accountZhCN,
  ...aiZhCN,
  ...contentZhCN,
  ...dataZhCN,
  ...mediaZhCN,
  ...modalsZhCN,
  ...spotlightZhCN,
  ...siteAZhCN,
  ...siteBZhCN,
  ...siteCZhCN,
  ...siteDZhCN,
} as const satisfies Record<string, string>

import { MEMBER_FORM_ACTIONS, memberPageState } from '@core/members'
import type { DbClient } from '../db/client'
import { getMemberSettings } from '../members/repository'
import { memberSettingsView } from '../members/settingsView'
import { cmsOperations, describeOperation } from './catalog'
import type { Operation } from './catalog/operation'

export async function membershipGuide(req: Request, db: DbClient, available: Operation[]) {
  function instructions(method: string, path: string) {
    const matches = (operation: Operation) => operation.method === method && operation.path === path
    const operation = available.find(matches)
    if (operation) return { command: describeOperation(operation).command, describe: 'instatic api describe ' + method + ' ' + path }
    return { unavailable: true, requiredPermissions: cmsOperations.find(matches)?.permissions }
  }

  const canReadSettings = !instructions('GET', 'members/settings').unavailable
  const view = canReadSettings ? await memberSettingsView(req, db, await getMemberSettings(db)) : null
  const settings = view?.settings
  const read = instructions('GET', 'canvas/pages')
  const save = instructions('PUT', 'site-document')
  const edit = instructions('PATCH', 'canvas/pages/:id')
  const configure = instructions('PUT', 'members/settings')
  const forms = MEMBER_FORM_ACTIONS.map(({ action, label, fields, linkParam, successMessage }) => ({
    action, label, fields: fields.map(field => field.name), linkParam, successMessage,
  }))
  return {
    task: 'Build and verify a public membership site',
    state: view && {
      ...view,
      login: memberPageState('login', view.settings.pages, view.pageOptions).kind,
      verify: memberPageState('verify', view.settings.pages, view.pageOptions).kind,
    },
    steps: [
      {
        goal: 'Read pages by ID or /slug. One snapshot includes the shell, base sequences and revisions.',
        ...read,
        example: read.command && 'instatic canvas read / --branch main',
      },
      {
        goal: 'Create or update pages together. Start with the document from canvas read and keep its base sequences. Save the page revisions returned by this write.',
        ...save,
        newPage: save.command && {
          id: 'members-dashboard', slug: 'dashboard', title: 'Dashboard', access: { level: 'members', onDeny: 'login' },
          rootNodeId: 'body', nodes: { body: { id: 'body', moduleId: 'base.body', props: {}, children: [], breakpointOverrides: {} } },
        },
      },
      {
        goal: 'Design with insertHtml and add native forms with memberForm. The CMS creates labeled fields, feedback, submit controls and token inputs. Editing shared styles changes the revision of every page. Refresh revisions together with canvas read.',
        ...edit,
        example: edit.command && 'instatic canvas edit /signup --branch main --revision REV --json \'[{"op":"memberForm","parent":"PARENT_NODE_ID","action":"signup"}]\'',
        forms,
      },
      { goal: 'After signup, show an inbox-confirmation message or a receipt page. Send verified and returning members to the protected dashboard. Include a logout form there.' },
      { goal: 'Publish main. Confirm the landing page links to signup and login.', ...instructions('POST', 'publish') },
      {
        goal: 'Enable signup and assign published page IDs to login, verify and afterLogin. Preserve profile fields and unrelated assignments. This setting takes effect immediately across branches.',
        ...configure,
        example: configure.command && settings ? {
          ...settings, signupMode: 'open', pages: { ...settings.pages, login: 'LOGIN_PAGE_ID', verify: 'VERIFY_PAGE_ID', afterLogin: 'DASHBOARD_PAGE_ID' },
        } : undefined,
      },
      {
        goal: 'Check published wiring and anonymous access. On a disposable loopback demo with a local test inbox, add --live to exercise signup through returning login.',
        ...(canReadSettings ? { command: 'instatic check membership' } : instructions('GET', 'members/settings')),
      },
    ],
  }
}

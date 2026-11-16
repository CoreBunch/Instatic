/**
 * Settings scope — navigate settings sections.
 *
 * Returns commands for opening each section of the Settings modal.
 */

import type { Scope, Command } from '../types'

const SETTINGS_COMMANDS: Command[] = [
  {
    id: 'scope.settings.general',
    title: 'General',
    subtitle: 'Site name, description, and general settings',
    group: 'settings',
    iconName: 'settings-cog-solid',
    keywords: ['general', 'site', 'name', 'description'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('general')
    },
  },
  {
    id: 'scope.settings.publishing',
    title: 'Publishing',
    subtitle: 'Configure publishing and deployment settings',
    group: 'settings',
    iconName: 'send-solid',
    keywords: ['publishing', 'deploy', 'production', 'domain'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('publishing')
    },
  },
  {
    id: 'scope.settings.email',
    title: 'Email',
    subtitle: 'The SMTP account the site sends email through',
    group: 'settings',
    iconName: 'mail-solid',
    keywords: ['email', 'mail', 'smtp', 'sender', 'outbox'],
    workspaces: ['site'],
    capability: 'mail.manage',
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('email')
    },
  },
  {
    id: 'scope.settings.preferences',
    title: 'Preferences',
    subtitle: 'Editor preferences and auto-save settings',
    group: 'settings',
    iconName: 'sliders-horizontal',
    keywords: ['preferences', 'autosave', 'editor', 'behavior'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('preferences')
    },
  },
  {
    id: 'scope.settings.shortcuts',
    title: 'Keyboard Shortcuts',
    subtitle: 'View and customize keyboard shortcuts',
    group: 'settings',
    iconName: 'command',
    keywords: ['shortcuts', 'keyboard', 'hotkeys', 'keybindings'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('shortcuts')
    },
  },
]

export const settingsScope: Scope = {
  id: 'settings',
  title: 'Settings',
  placeholder: 'Search settings sections…',
  commands: () => SETTINGS_COMMANDS,
}

/**
 * Help commands — §4.15 of the Command Spotlight master plan.
 *
 * - Show keyboard shortcuts
 * - Open documentation
 * - Report an issue
 * - About Instatic
 * - Copy environment info (for bug reports)
 */

import type { Command } from '../types'
import { copyToClipboard } from '@admin/lib/clipboard'

export function getHelpCommands(): Command[] {
  return [
    {
      id: 'help.shortcuts',
      title: 'Show keyboard shortcuts',
      subtitle: 'Browse all keyboard shortcuts',
      group: 'help',
      iconName: 'command',
      keywords: ['shortcuts', 'keyboard', 'hotkeys', 'keybindings', 'help', 'cheatsheet'],
      workspaces: ['site'],
      run: async (ctx) => {
        ctx.closeSpotlight()
        const { useEditorStore } = await import('@site/store/store')
        useEditorStore.getState().openSettings('shortcuts')
      },
    },

    {
      id: 'help.documentation',
      title: 'Open documentation',
      subtitle: 'View the Instatic docs',
      group: 'help',
      iconName: 'book-open-solid',
      keywords: ['docs', 'documentation', 'help', 'guide', 'reference'],
      workspaces: ['any'],
      run: (ctx) => {
        ctx.closeSpotlight()
        window.open('https://github.com/corebunch/instatic/blob/main/docs/', '_blank', 'noopener,noreferrer')
      },
    },

    {
      id: 'help.reportIssue',
      title: 'Report an issue',
      subtitle: 'Open GitHub Issues to report a bug or request a feature',
      group: 'help',
      iconName: 'circle-alert-solid',
      keywords: ['report', 'issue', 'bug', 'feedback', 'github'],
      workspaces: ['any'],
      run: (ctx) => {
        ctx.closeSpotlight()
        window.open('https://github.com/corebunch/instatic/issues/new', '_blank', 'noopener,noreferrer')
      },
    },

    {
      id: 'help.about',
      title: 'About Instatic',
      subtitle: 'Version information and license',
      group: 'help',
      iconName: 'book-open-solid',
      keywords: ['about', 'version', 'license', 'info'],
      workspaces: ['any'],
      run: (ctx) => {
        ctx.closeSpotlight()
        // Navigate to About section in settings when available, else open docs
        window.open('https://github.com/corebunch/instatic', '_blank', 'noopener,noreferrer')
      },
    },

    {
      id: 'help.copyEnvInfo',
      title: 'Copy environment info',
      subtitle: 'Copy browser, OS, and version info for bug reports',
      group: 'help',
      iconName: 'copy-solid',
      keywords: ['copy', 'environment', 'info', 'debug', 'browser', 'version', 'bug report'],
      workspaces: ['any'],
      run: (ctx) => {
        ctx.closeSpotlight()
        const info = [
          `Instatic`,
          `Browser: ${navigator.userAgent}`,
          `Platform: ${navigator.platform}`,
          `URL: ${window.location.href}`,
          `Date: ${new Date().toISOString()}`,
        ].join('\n')
        void copyToClipboard(info)
      },
    },
  ]
}

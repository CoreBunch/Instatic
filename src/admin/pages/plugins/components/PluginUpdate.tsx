import { useEffect, useState } from 'react'
import type { InstalledPlugin } from '@core/plugin-sdk'
import { checkPluginUpdate, verifiedUpdate, type PluginUpdateOffer } from '@core/plugins/updates'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'

export function PluginUpdate({ plugin, onReview }: {
  plugin: InstalledPlugin
  onReview: (file: File, expected: { id: string; version: string }) => Promise<void>
}) {
  const [offer, setOffer] = useState<PluginUpdateOffer | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void checkPluginUpdate(plugin, controller.signal).then(result => {
      if (!controller.signal.aborted) setOffer(result.status === 'available' ? result : null)
    }).catch(() => { /* Keep the manual check available if background discovery fails. */ })
    return () => controller.abort()
  }, [plugin])

  async function check() {
    setBusy(true)
    try {
      const result = await checkPluginUpdate(plugin)
      setOffer(result.status === 'available' ? result : null)
      if (result.status === 'available') {
        if (offer?.version === result.version) await onReview(await verifiedUpdate(plugin, result), { id: plugin.id, version: result.version })
      } else if (result.status === 'current') {
        pushToast({ kind: 'info', title: plugin.name + ' is up to date' })
      } else {
        throw new Error('Check your membership and reconnect the plugin to enable updates.')
      }
    } catch (error) {
      pushToast({ kind: 'error', title: 'Could not update ' + plugin.name, body: getErrorMessage(error, 'Try again.') })
    } finally {
      setBusy(false)
    }
  }

  return <Button size="sm" variant={offer ? 'primary' : 'secondary'} disabled={busy} tooltip={offer?.notes} onClick={() => void check()}>
    {offer ? 'Update to ' + offer.version : 'Check for updates'}
  </Button>
}

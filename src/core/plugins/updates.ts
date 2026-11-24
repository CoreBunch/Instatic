import { Type, type Static } from '@sinclair/typebox'
import gt from 'semver/functions/gt'
import valid from 'semver/functions/valid'
import { apiRequest } from '@core/http'
import type { InstalledPlugin } from '@core/plugin-sdk'

const Offer = Type.Object({
  status: Type.Literal('available'), version: Type.String(), notes: Type.String(),
  url: Type.String(), signature: Type.String({ pattern: '^[A-Za-z0-9+/]{86}==$' }),
})
const Update = Type.Union([Offer, Type.Object({ status: Type.Union([
  Type.Literal('current'), Type.Literal('denied'), Type.Literal('disconnected'),
]) })])
export type PluginUpdateOffer = Static<typeof Offer>

export async function checkPluginUpdate(plugin: InstalledPlugin, signal?: AbortSignal) {
  const result = await apiRequest('/admin/api/cms/plugins/' + encodeURIComponent(plugin.id) + '/runtime/updates/check', { schema: Update, signal })
  if (result.status === 'available' && (!valid(result.version) || !valid(plugin.version) || !gt(result.version, plugin.version))) {
    throw new Error('Invalid plugin update version.')
  }
  return result
}

export async function verifiedUpdate(plugin: InstalledPlugin, offer: PluginUpdateOffer): Promise<File> {
  const url = new URL(offer.url)
  if (url.protocol !== 'https:' || url.username || url.password || !plugin.manifest.networkAllowedHosts?.includes(url.hostname)) {
    throw new Error('The update address is outside the plugin’s approved hosts.')
  }
  const key = plugin.manifest.updatePublicKey
  if (!key) throw new Error('Missing publisher key.')
  // An external binary download must never receive the editor's ambient headers or cookies.
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error('The update download failed.')
  const bytes = await response.arrayBuffer()
  const decode = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
  const publisher = await crypto.subtle.importKey('raw', decode(key), 'Ed25519', false, ['verify'])
  if (!await crypto.subtle.verify('Ed25519', publisher, decode(offer.signature), bytes)) {
    throw new Error('The package signature does not match the installed publisher key.')
  }
  return new File([bytes], plugin.id + '.zip', { type: 'application/zip' })
}

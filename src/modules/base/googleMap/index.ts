/**
 * base.google-map — a first-party, CSP-aware Google Maps Embed module.
 *
 * This is intentionally limited to official https://www.google.com/maps/embed
 * URLs. The fixed provider validation lets render() declare the exact
 * frame-src origin required by the publisher without accepting arbitrary
 * third-party iframe origins from page content.
 */
import { registry } from '@core/module-engine'
import type { CspSourceRequirement, ModuleDefinition } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { safeUrl } from '@modules/base/utils/escape'
import { GoogleMapEditor } from './GoogleMapEditor'
import { GoogleMapPropsSchema, type GoogleMapStoredProps } from './props'
import { googleMapsEmbedUrl } from './url'

const GOOGLE_MAPS_CSP_SOURCES: CspSourceRequirement[] = [
  { directive: 'frame-src', sources: ['https://www.google.com'] },
]

const GOOGLE_MAP_CSS = `
.base-google-map__frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
}
`.trim()

export const GoogleMapModule: ModuleDefinition<GoogleMapStoredProps> = {
  id: 'base.google-map',
  name: 'Google Map',
  description: 'Embed an official Google Maps location with a strict, page-scoped CSP allowance.',
  category: 'Media',
  version: '1.0.0',
  icon: GlobeSolidIcon,
  trusted: true,
  canHaveChildren: false,
  propsSchema: GoogleMapPropsSchema,
  defaults: Value.Create(GoogleMapPropsSchema),
  schema: {
    embedUrl: {
      type: 'url',
      label: 'Google Maps Embed URL',
      description: 'Paste the official Google Maps Embed URL (https://www.google.com/maps/embed?...).',
    },
    title: {
      type: 'text',
      label: 'Accessible map title',
      description: 'Describe the location shown in the embedded Google Map.',
    },
  },
  component: GoogleMapEditor,
  htmlTag: (props) => (googleMapsEmbedUrl(props.embedUrl) ? 'iframe' : 'div'),
  render: (props) => {
    const canonicalUrl = googleMapsEmbedUrl(props.embedUrl)
    const embedUrl = canonicalUrl ? safeUrl(canonicalUrl) : null
    if (!embedUrl) {
      return {
        html: '<div class="base-google-map__placeholder" role="status">Google Maps embed URL required.</div>',
        css: GOOGLE_MAP_CSS,
      }
    }

    const title = props.title || 'Google Maps location'
    return {
      html: `<iframe class="base-google-map__frame" src="${embedUrl}" title="${title}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" frameborder="0" allowfullscreen></iframe>`,
      css: GOOGLE_MAP_CSS,
      cspSources: GOOGLE_MAPS_CSP_SOURCES,
    }
  },
}

registry.registerOrReplace(GoogleMapModule)

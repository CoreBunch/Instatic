import { VISITOR_PREFERENCES_CONFIG_ATTRIBUTE } from './browserAsset'

const configured = 'html[' + VISITOR_PREFERENCES_CONFIG_ATTRIBUTE + ']'
const reduced = 'animation-duration:0.01ms!important;animation-iteration-count:1!important;transition-duration:0.01ms!important;scroll-behavior:auto!important'
/** Native browser controls follow the framework's light/default and dark/alt palettes. */
export const VISITOR_PREFERENCES_DOCUMENT_CSS =
  ':where(' + configured + '.theme-default){color-scheme:light}\n' +
  ':where(' + configured + '.theme-alt){color-scheme:dark}\n' +
  ':where(html[data-instatic-motion="reduced"],html[data-instatic-motion="reduced"] *){' + reduced + '}\n' +
  '@media(prefers-reduced-motion:reduce){:where(' + configured + ',' + configured + ' *){' + reduced + '}}'

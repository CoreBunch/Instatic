/**
 * paramTypeCompat — mapping between PropertyControl types and VCParamTypes.
 *
 * Architecture source: Contribution #619 Phase 2 §B.3
 *
 * Constraint #269: This file may import from core/ (it lives in editor/).
 */

import type { PropertyControl } from '@core/module-engine'
import type { VCParamType } from '@core/visualComponents'

/**
 * Return the canonical VCParamType for a given PropertyControl.
 * Used when creating a new param from a property.
 */
export function paramTypeForControl(control: PropertyControl): VCParamType {
  switch (control.type) {
    case 'text':
    case 'textarea':
      return 'string'
    case 'number':
      return 'number'
    case 'toggle':
      return 'boolean'
    case 'color':
      return 'color'
    case 'select':
      return 'enum'
    case 'image':
      return 'image'
    case 'media':
      return control.mediaKind === 'image' ? 'image' : 'string'
    case 'url':
      return 'url'
    case 'richtext':
      return 'richText'
    case 'group':
    default:
      return 'string'
  }
}

/**
 * Return the set of VCParamTypes compatible with a given PropertyControl.
 * Used to filter existing params when offering "bind to existing param".
 */
export function paramTypesCompatibleWithControl(control: PropertyControl): VCParamType[] {
  switch (control.type) {
    case 'condition':
      return []
    case 'text':
    case 'textarea':
      return ['string', 'url', 'enum']
    case 'number':
      return ['number']
    case 'toggle':
      return ['boolean']
    case 'color':
      return ['color', 'string']
    case 'select':
      return ['enum', 'string']
    case 'image':
      return ['image', 'string']
    case 'media':
      return control.mediaKind === 'image' ? ['image', 'string'] : ['string']
    case 'url':
      return ['url', 'string']
    case 'richtext':
      return ['richText', 'string']
    case 'group':
    default:
      return ['string']
  }
}

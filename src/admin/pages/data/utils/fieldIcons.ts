import type { IconComponent } from 'pixel-art-icons/types'
import type { DataFieldType } from '@core/data/schemas'

import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
// NOTE: the filename is "text-colums" (sic) — that is the actual upstream filename.
import { TextColumsIcon } from 'pixel-art-icons/icons/text-colums'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { RulerDimensionSolidIcon } from 'pixel-art-icons/icons/ruler-dimension-solid'
import { CheckboxSolidIcon } from 'pixel-art-icons/icons/checkbox-solid'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { SearchSolidIcon } from 'pixel-art-icons/icons/search-solid'

const FIELD_ICONS: Record<DataFieldType, IconComponent> = {
  text: TextStartTIcon,
  url: TextStartTIcon,
  email: TextStartTIcon,
  longText: TextColumsIcon,
  richText: HeadingIcon,
  number: RulerDimensionSolidIcon,
  boolean: CheckboxSolidIcon,
  date: CalendarSolidIcon,
  dateTime: CalendarSolidIcon,
  select: ListBoxSolidIcon,
  multiSelect: BulletlistSolidIcon,
  media: ImageSolidIcon,
  relation: LinkIcon,
  // Structural field types: visual page-node tree and component parameter schema.
  pageTree: LayoutSolidIcon,
  fieldSchema: BracesIcon,
  seoMetadata: SearchSolidIcon,
}

export function getFieldIcon(type: DataFieldType): IconComponent {
  return FIELD_ICONS[type]
}

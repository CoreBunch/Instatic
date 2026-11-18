import { Type, type Static } from '@core/utils/typeboxHelpers'
import { memberSignOutHref } from '@core/members'
import { AnchorTargetSchema } from '@core/htmlAttributes'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const LinkPropsSchema = Type.Object({
  /** What a click does: open `href`, or sign the member out and open `signOutRedirect`. */
  action: Type.Union([Type.Literal('url'), Type.Literal('memberSignOut')], { default: 'url' }),
  href: Type.String({ default: '#' }),
  signOutRedirect: Type.String({ default: '/' }),
  text: Type.String({ default: 'Click here' }),
  target: AnchorTargetSchema,
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type LinkStoredProps = Static<typeof LinkPropsSchema>

/** The address the link opens, for the canvas and the published page alike. */
export function linkHref(props: Pick<LinkStoredProps, 'action' | 'href' | 'signOutRedirect'>): string {
  return props.action === 'memberSignOut' ? memberSignOutHref(props.signOutRedirect ?? '/') : props.href
}

import { control, defineModule, html } from '@core/plugin-sdk'

export default defineModule({
  id: 'local.smoke-test.hello',
  name: 'Hello',
  description: 'Sample canvas module emitted by the scaffolded plugin.',
  category: 'Smoke Test',
  htmlTag: 'div',
  defaults: {
    message: 'Hello from your new plugin.',
  },
  schema: {
    message: control.text('Message'),
  },
  render: ({ props }) => ({
    html: html`<div class="hello">${props.message}</div>`,
    css: `.hello { padding: 12px; border: 1px dashed currentColor; border-radius: 6px; }`,
  }),
})

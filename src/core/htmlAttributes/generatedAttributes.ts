const controlWiring = ['name', 'id', 'required', 'disabled', 'form', 'formaction', 'formmethod', 'formenctype', 'formnovalidate']
const choiceAttributes = [...controlWiring, 'type', 'value', 'checked']

/** Names owned by native module props, shared by HTML import, render and authoring. */
export const MODULE_GENERATED_ATTRIBUTE_NAMES: Readonly<Record<string, readonly string[]>> = {
  'base.button': ['aria-disabled', 'disabled', 'href', 'rel', 'target', 'type'],
  'base.form': ['action', 'method'],
  'base.input': [...controlWiring, 'type', 'value', 'placeholder', 'readonly', 'autocomplete', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern'],
  'base.textarea': [...controlWiring, 'value', 'placeholder', 'readonly', 'rows', 'minlength', 'maxlength'],
  'base.select': [...controlWiring, 'value', 'multiple'],
  'base.checkbox': choiceAttributes,
  'base.radio': choiceAttributes,
  'base.image': ['alt', 'decoding', 'fetchpriority', 'height', 'loading', 'sizes', 'src', 'srcset', 'style', 'width'],
  'base.link': ['href', 'rel', 'target'],
}

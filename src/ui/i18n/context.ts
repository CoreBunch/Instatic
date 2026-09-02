import { createContext, useContext } from 'react'
import { englishUiMessages, formatUiMessage, type UiMessageCatalog, type UiMessageKey, type UiMessageParams } from './catalog'

export const UiMessagesContext = createContext<UiMessageCatalog>(englishUiMessages)

export function useUiMessages() {
  const catalog = useContext(UiMessagesContext)
  return (key: UiMessageKey, params?: UiMessageParams): string => formatUiMessage(catalog, key, params)
}

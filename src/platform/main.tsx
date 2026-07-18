import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { ToastProvider } from '@ui/components/Toast'
import { PlatformApp } from './PlatformApp'
import '../styles/globals.css'
import './platform.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary location="platform-shell">
      <PlatformApp />
    </ErrorBoundary>
    <ToastProvider />
  </StrictMode>,
)

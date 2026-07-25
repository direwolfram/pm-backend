import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { ConvexProvider } from 'convex/react'
import './index.css'
import App from './App.tsx'
import SetupScreen from './components/SetupScreen'
import { convexClient, isConvexConfigured } from './lib/convexClient'

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    {isConvexConfigured && convexClient ? (
      <ConvexProvider client={convexClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexProvider>
    ) : (
      <SetupScreen />
    )}
  </StrictMode>,
)

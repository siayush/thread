import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installAutoHideScrollbars } from './lib/autoHideScrollbars'
import '@fontsource-variable/dm-sans/index.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles.css'

installAutoHideScrollbars()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

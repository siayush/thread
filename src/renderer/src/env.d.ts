/// <reference types="vite/client" />
import type { NativeApi } from '../../preload/index'

declare global {
  interface Window {
    native: NativeApi
  }
}

export {}

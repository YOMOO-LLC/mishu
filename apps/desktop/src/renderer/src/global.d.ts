import type { LivePhoneApi } from '../../shared/contracts'

declare global {
  interface Window {
    livePhone: LivePhoneApi
  }
}

export {}

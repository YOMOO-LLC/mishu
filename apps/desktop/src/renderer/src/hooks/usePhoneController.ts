import { useEffect, useSyncExternalStore } from 'react'
import { phoneController } from '../services/phone-controller'

export function usePhoneController() {
  const state = useSyncExternalStore(phoneController.subscribe, phoneController.getState)

  useEffect(() => {
    void phoneController.initialize()
  }, [])

  return {
    state,
    initialize: phoneController.initialize,
    setCallProfile: phoneController.setCallProfile,
    setCampaignSnapshot: phoneController.setCampaignSnapshot,
    dial: phoneController.dial,
    answer: phoneController.answer,
    reject: phoneController.reject,
    hangup: phoneController.hangup,
    setControlMode: phoneController.setControlMode,
    simulateIncoming: phoneController.simulateIncoming
  }
}

export type PhoneControllerHook = ReturnType<typeof usePhoneController>

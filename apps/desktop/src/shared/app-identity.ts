/**
 * Private-build identity strings.
 *
 * These values must stay stable in this repository: changing them would move
 * the user's data folder and break Twilio client routing (`client:mishu`).
 * Snapshot export rewrites each constant's value to `mishu` in the public tree only.
 */
export const APP_USER_DATA_DIR_NAME = 'mishu'
export const APP_TWILIO_CLIENT_IDENTITY = 'mishu'
export const APP_TWILIO_FUNCTIONS_SERVICE_NAME = 'mishu'

/** Snapshot export rewrites the webhook dual-send flag to false. */
export const WEBHOOK_SEND_LEGACY_HEADERS = false

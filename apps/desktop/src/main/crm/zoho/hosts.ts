export const ZOHO_DATA_CENTERS = ['com', 'com.au', 'eu', 'in', 'com.cn', 'jp', 'sa', 'ca'] as const

export type ZohoDataCenter = (typeof ZOHO_DATA_CENTERS)[number]

const HOSTS: Record<ZohoDataCenter, { accounts: string; api: string }> = {
  com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  'com.cn': { accounts: 'https://accounts.zoho.com.cn', api: 'https://www.zohoapis.com.cn' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca' }
}

export function normalizeZohoDataCenter(value: unknown): ZohoDataCenter {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'com'
  if (!ZOHO_DATA_CENTERS.includes(normalized as ZohoDataCenter)) {
    throw new Error('Zoho data center is invalid')
  }
  return normalized as ZohoDataCenter
}

export function zohoHosts(dataCenter: ZohoDataCenter): { accounts: string; api: string } {
  return HOSTS[dataCenter]
}

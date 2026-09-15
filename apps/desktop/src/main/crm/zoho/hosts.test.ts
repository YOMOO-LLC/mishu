import { describe, expect, it } from 'vitest'
import { normalizeZohoDataCenter, zohoHosts } from './hosts'

describe('Zoho host mapping', () => {
  it('maps every supported data center to matching accounts and API hosts', () => {
    expect(zohoHosts('com')).toEqual({
      accounts: 'https://accounts.zoho.com',
      api: 'https://www.zohoapis.com'
    })
    expect(zohoHosts('eu')).toEqual({
      accounts: 'https://accounts.zoho.eu',
      api: 'https://www.zohoapis.eu'
    })
    expect(zohoHosts('ca')).toEqual({
      accounts: 'https://accounts.zohocloud.ca',
      api: 'https://www.zohoapis.ca'
    })
    expect(normalizeZohoDataCenter('COM.AU')).toBe('com.au')
  })
})

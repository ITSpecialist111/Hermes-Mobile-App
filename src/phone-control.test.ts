import { afterEach, describe, expect, it } from 'vitest'

import { hermesMcpSnippet, parsePhoneControlStatus, phoneControlAvailable, readPhoneControlStatus } from './phone-control'

const raw = JSON.stringify({ enabled: true, running: true, address: '192.168.68.82', port: 8765, url: 'http://192.168.68.82:8765/mcp', token: 'abc123def456' })

describe('phone control status', () => {
  afterEach(() => { delete (globalThis as { HermesPhoneControl?: unknown }).HermesPhoneControl })

  it('parses the native status', () => {
    expect(parsePhoneControlStatus(raw)).toEqual({ enabled: true, running: true, address: '192.168.68.82', port: 8765, url: 'http://192.168.68.82:8765/mcp', token: 'abc123def456' })
  })

  it('rejects malformed payloads', () => {
    expect(parsePhoneControlStatus('nope')).toBeNull()
    expect(parsePhoneControlStatus(JSON.stringify({ enabled: true }))).toBeNull()
    expect(parsePhoneControlStatus(42)).toBeNull()
  })

  it('reports an off-network phone without a URL', () => {
    const status = parsePhoneControlStatus(JSON.stringify({ enabled: false, running: false, address: null, port: 8765, url: null, token: 't' }))
    expect(status?.url).toBeNull()
    expect(hermesMcpSnippet(status!)).toContain('http://<phone-ip>:8765/mcp')
  })

  it('is unavailable without the Android bridge and reads through it when present', () => {
    expect(phoneControlAvailable()).toBe(false)
    expect(readPhoneControlStatus()).toBeNull()
    ;(globalThis as { HermesPhoneControl?: unknown }).HermesPhoneControl = { status: () => raw, openAccessibilitySettings() {}, rotateToken: () => 'x' }
    expect(phoneControlAvailable()).toBe(true)
    expect(readPhoneControlStatus()?.running).toBe(true)
  })

  it('keeps the token out of config.yaml and in the profile .env', () => {
    const snippet = hermesMcpSnippet(parsePhoneControlStatus(raw)!)
    expect(snippet).toContain('url: http://192.168.68.82:8765/mcp')
    expect(snippet).toContain('Authorization: "Bearer ${HERMES_PHONE_TOKEN}"')
    expect(snippet.split('\n').filter(line => line.includes('abc123def456'))).toEqual(['# .env of the same profile:  HERMES_PHONE_TOKEN=abc123def456'])
  })
})

import { afterEach, describe, expect, it } from 'vitest'

import { hermesMcpSnippet, parsePhoneAudit, parsePhoneControlStatus, parsePhonePolicy, parseReplyDrafts, phoneControlAvailable, phoneControlSummary, readPhoneControlStatus, setPhoneControlAskFirst } from './phone-control'

const raw = JSON.stringify({ enabled: true, running: true, address: '192.168.68.82', port: 8765, url: 'http://192.168.68.82:8765/mcp', token: 'abc123def456' })

describe('phone control status', () => {
  afterEach(() => { delete (globalThis as { HermesPhoneControl?: unknown }).HermesPhoneControl })

  it('parses the native status', () => {
    expect(parsePhoneControlStatus(raw)).toEqual({ enabled: true, running: true, address: '192.168.68.82', port: 8765, url: 'http://192.168.68.82:8765/mcp', token: 'abc123def456', askFirst: true })
  })

  it('keeps Ask first on unless the phone explicitly reports it off', () => {
    const base = { enabled: true, running: true, address: null, port: 8765, url: null, token: 't' }
    expect(parsePhoneControlStatus(JSON.stringify(base))?.askFirst).toBe(true)
    expect(parsePhoneControlStatus(JSON.stringify({ ...base, askFirst: 'no' }))?.askFirst).toBe(true)
    expect(parsePhoneControlStatus(JSON.stringify({ ...base, askFirst: false }))?.askFirst).toBe(false)
  })

  it('switches Ask first through the bridge, and refuses without it', () => {
    expect(setPhoneControlAskFirst(false)).toBe(false)
    const calls: boolean[] = []
    ;(globalThis as { HermesPhoneControl?: unknown }).HermesPhoneControl = { status: () => raw, openAccessibilitySettings() {}, rotateToken: () => 'x', setAskFirst: (value: boolean) => calls.push(value) }
    expect(setPhoneControlAskFirst(false)).toBe(true)
    expect(calls).toEqual([false])
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

  it('summarises the mode for the Settings list', () => {
    const status = parsePhoneControlStatus(raw)!
    expect(phoneControlSummary(null)).toBe('Off')
    expect(phoneControlSummary({ ...status, running: false })).toBe('Off')
    expect(phoneControlSummary({ ...status, askFirst: true })).toBe('On · Ask first')
    expect(phoneControlSummary({ ...status, askFirst: false })).toBe('On · Autopilot')
  })
})

describe('phone rules, activity and reply drafts', () => {
  it('reads app rules and Bots, treating anything unknown as the safe choice', () => {
    const policy = parsePhonePolicy(JSON.stringify({
      apps: [
        { package: 'com.whatsapp', label: 'WhatsApp', mode: 'ask', source: 'default', messaging: true },
        { package: 'co.uk.getmondo', label: 'Monzo', mode: 'block', source: 'default' },
        { package: 'com.example', label: 'Example', mode: 'weird', source: '???' },
        { label: 'no package' },
      ],
      bots: [{ name: 'scout', allowed: false }, { name: 'pilot' }, { allowed: true }],
    }))
    expect(policy.apps.map(app => [app.label, app.mode, app.source])).toEqual([['WhatsApp', 'ask', 'default'], ['Monzo', 'block', 'default'], ['Example', 'ask', 'global']])
    expect(policy.apps[0].messaging).toBe(true)
    expect(policy.bots).toEqual([{ name: 'scout', allowed: false }, { name: 'pilot', allowed: true }])
    expect(parsePhonePolicy('not json')).toEqual({ apps: [], bots: [] })
  })

  it('reads the activity timeline', () => {
    const entries = parsePhoneAudit(JSON.stringify([
      { id: 2, at: 2000, bot: 'Scout', tool: 'phone_tap', app: 'com.whatsapp', appLabel: 'WhatsApp', summary: 'tapped “Send”', outcome: 'declined', before: true, after: false },
      { id: 1, at: 1000, tool: 'phone_screen', app: null, summary: 'read the screen', outcome: 'mystery', count: 3 },
      { at: 5 },
    ]))
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ bot: 'Scout', outcome: 'declined', before: true, after: false, count: 1 })
    expect(entries[1]).toMatchObject({ bot: 'Hermes', app: null, outcome: 'done', count: 3 })
  })

  it('reads reply-draft status', () => {
    const status = parseReplyDrafts(JSON.stringify({ access: true, apps: ['com.whatsapp', 7], lastIncomingAt: 9, available: [{ package: 'com.whatsapp', label: 'WhatsApp', enabled: true }] }))
    expect(status).toEqual({ access: true, apps: ['com.whatsapp'], lastIncomingAt: 9, available: [{ package: 'com.whatsapp', label: 'WhatsApp', enabled: true }] })
    expect(parseReplyDrafts(null)).toBeNull()
  })
})

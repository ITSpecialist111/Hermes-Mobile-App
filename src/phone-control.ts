/**
 * Phone control: the Android accessibility service that lets Hermes Bots operate this phone,
 * served to Hermes as an MCP endpoint on the LAN. This module only reads its state through the
 * `HermesPhoneControl` JavascriptInterface that MainActivity installs; it is absent elsewhere.
 */
export type PhoneControlStatus = {
  /** The user switched the service on in Android's Accessibility settings. */
  enabled: boolean
  /** The service is bound and its MCP endpoint is listening. */
  running: boolean
  address: string | null
  port: number
  url: string | null
  token: string
  /** Ask on the phone before risky taps (default). Off = autopilot. */
  askFirst: boolean
}

type Bridge = { status(): string; openAccessibilitySettings(): void; rotateToken(): string; setAskFirst?(value: boolean): void }

const bridge = (): Bridge | null => {
  const candidate = (globalThis as { HermesPhoneControl?: Bridge }).HermesPhoneControl
  return candidate && typeof candidate.status === 'function' ? candidate : null
}

export function phoneControlAvailable(): boolean {
  return bridge() !== null
}

export function parsePhoneControlStatus(raw: unknown): PhoneControlStatus | null {
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value.token !== 'string' || typeof value.port !== 'number') return null
    return {
      enabled: value.enabled === true,
      running: value.running === true,
      address: typeof value.address === 'string' ? value.address : null,
      port: value.port,
      url: typeof value.url === 'string' ? value.url : null,
      token: value.token,
      // Safe default: anything but an explicit false keeps Ask first on.
      askFirst: value.askFirst !== false,
    }
  } catch {
    return null
  }
}

export function readPhoneControlStatus(): PhoneControlStatus | null {
  const native = bridge()
  if (!native) return null
  try { return parsePhoneControlStatus(native.status()) } catch { return null }
}

export function openAccessibilitySettings(): void {
  bridge()?.openAccessibilitySettings()
}

export function rotatePhoneControlToken(): string | null {
  try { return bridge()?.rotateToken() ?? null } catch { return null }
}

export function setPhoneControlAskFirst(value: boolean): boolean {
  const native = bridge()
  if (!native?.setAskFirst) return false
  try { native.setAskFirst(value); return true } catch { return false }
}

/** One-line state for the Settings list, e.g. "On · Ask first". */
export function phoneControlSummary(status: PhoneControlStatus | null): string {
  if (!status?.running) return 'Off'
  return `On · ${status.askFirst ? 'Ask first' : 'Autopilot'}`
}

// ── Rules, Bots, Activity and Reply drafts ──────────────────────────────────

export type PhoneRuleMode = 'auto' | 'ask' | 'block'
export type PhoneAppRule = { package: string; label: string; mode: PhoneRuleMode; source: 'custom' | 'default' | 'global'; messaging: boolean }
export type PhoneBotRule = { name: string; allowed: boolean }
export type PhoneAuditEntry = {
  id: number
  at: number
  bot: string
  tool: string
  app: string | null
  appLabel: string | null
  summary: string
  outcome: 'done' | 'declined' | 'blocked' | 'failed'
  before: boolean
  after: boolean
  count: number
}
export type ReplyDraftStatus = { access: boolean; apps: string[]; lastIncomingAt: number; available: { package: string; label: string; enabled: boolean }[] }

type PolicyBridge = {
  policy?(): string
  setAppRule?(pkg: string, mode: string): void
  setBotAllowed?(name: string, allowed: boolean): void
  audit?(limit: number): string
  auditImage?(id: string, which: string): string
  clearAudit?(): void
  drafts?(): string
  setDraftApp?(pkg: string, enabled: boolean): void
  openNotificationAccess?(): void
}

const policyBridge = (): PolicyBridge | null => (bridge() as PolicyBridge | null)

const asArray = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
const parseJson = (raw: unknown): unknown => { if (typeof raw !== 'string') return null; try { return JSON.parse(raw) } catch { return null } }
const MODES: PhoneRuleMode[] = ['auto', 'ask', 'block']
const OUTCOMES: PhoneAuditEntry['outcome'][] = ['done', 'declined', 'blocked', 'failed']

export function parsePhonePolicy(raw: unknown): { apps: PhoneAppRule[]; bots: PhoneBotRule[] } {
  const value = parseJson(raw) as { apps?: unknown; bots?: unknown } | null
  const apps = asArray(value?.apps).flatMap(item => typeof item.package === 'string' ? [{
    package: item.package,
    label: typeof item.label === 'string' ? item.label : item.package,
    // Unknown modes fall back to the safe side: ask.
    mode: MODES.includes(item.mode as PhoneRuleMode) ? item.mode as PhoneRuleMode : 'ask',
    source: item.source === 'custom' || item.source === 'default' ? item.source : 'global',
    messaging: item.messaging === true,
  } satisfies PhoneAppRule] : [])
  const bots = asArray(value?.bots).flatMap(item => typeof item.name === 'string' ? [{ name: item.name, allowed: item.allowed !== false }] : [])
  return { apps, bots }
}

export function parsePhoneAudit(raw: unknown): PhoneAuditEntry[] {
  return asArray(parseJson(raw)).flatMap(item => typeof item.id === 'number' && typeof item.at === 'number' ? [{
    id: item.id,
    at: item.at,
    bot: typeof item.bot === 'string' ? item.bot : 'Hermes',
    tool: typeof item.tool === 'string' ? item.tool : '',
    app: typeof item.app === 'string' ? item.app : null,
    appLabel: typeof item.appLabel === 'string' ? item.appLabel : null,
    summary: typeof item.summary === 'string' ? item.summary : '',
    outcome: OUTCOMES.includes(item.outcome as PhoneAuditEntry['outcome']) ? item.outcome as PhoneAuditEntry['outcome'] : 'done',
    before: item.before === true,
    after: item.after === true,
    count: typeof item.count === 'number' ? item.count : 1,
  }] : [])
}

export function parseReplyDrafts(raw: unknown): ReplyDraftStatus | null {
  const value = parseJson(raw) as Record<string, unknown> | null
  if (!value) return null
  return {
    access: value.access === true,
    apps: Array.isArray(value.apps) ? value.apps.filter((item): item is string => typeof item === 'string') : [],
    lastIncomingAt: typeof value.lastIncomingAt === 'number' ? value.lastIncomingAt : 0,
    available: asArray(value.available).flatMap(item => typeof item.package === 'string' ? [{ package: item.package, label: typeof item.label === 'string' ? item.label : item.package, enabled: item.enabled === true }] : []),
  }
}

const call = <T>(fn: (native: PolicyBridge) => T, fallback: T): T => {
  const native = policyBridge()
  if (!native) return fallback
  try { return fn(native) } catch { return fallback }
}

export const readPhonePolicy = () => call(native => parsePhonePolicy(native.policy?.()), { apps: [], bots: [] })
export const setPhoneAppRule = (pkg: string, mode: PhoneRuleMode | null) => call(native => { native.setAppRule?.(pkg, mode ?? ''); return true }, false)
export const setPhoneBotAllowed = (name: string, allowed: boolean) => call(native => { native.setBotAllowed?.(name, allowed); return true }, false)
export const readPhoneAudit = (limit = 200) => call(native => parsePhoneAudit(native.audit?.(limit)), [] as PhoneAuditEntry[])
export const readPhoneAuditImage = (id: number, which: 'before' | 'after') => call(native => native.auditImage?.(String(id), which) || null, null as string | null)
export const clearPhoneAudit = () => call(native => { native.clearAudit?.(); return true }, false)
export const readReplyDrafts = () => call(native => parseReplyDrafts(native.drafts?.()), null as ReplyDraftStatus | null)
export const setReplyDraftApp = (pkg: string, enabled: boolean) => call(native => { native.setDraftApp?.(pkg, enabled); return true }, false)
export const openNotificationAccess = () => call(native => { native.openNotificationAccess?.(); return true }, false)

/** The Hermes config a host needs to reach this phone; the token belongs in the profile's .env. */
export function hermesMcpSnippet(status: PhoneControlStatus, server = 'phone'): string {
  return [
    'mcp_servers:',
    `  ${server}:`,
    `    url: ${status.url ?? `http://<phone-ip>:${status.port}/mcp`}`,
    '    headers:',
    '      Authorization: "Bearer ${HERMES_PHONE_TOKEN}"',
    '',
    `# .env of the same profile:  HERMES_PHONE_TOKEN=${status.token}`,
  ].join('\n')
}

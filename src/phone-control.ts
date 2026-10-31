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

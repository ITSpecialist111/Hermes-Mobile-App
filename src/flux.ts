/**
 * Flux on the phone: the Live Map link (stored on this device) and Graham's approval queue.
 *
 * The link printed by the host's install.sh looks like http://host:18791/?key=VIEW&approve=APPROVE.
 * With an approve key, the app polls Flux for pending approvals and posts each one as an Allow/Deny
 * notification (the same native card as command approvals); a tap is sent straight back to Flux.
 */
const KEY = 'hermes.flux.liveMapUrl'

export const readFluxLiveMapUrl = () => {
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}

export const writeFluxLiveMapUrl = (value: string) => {
  try { localStorage.setItem(KEY, value) } catch { /* private mode: keep it for this visit */ }
}

export type FluxApproval = { id: string; status: 'pending' | 'approved' | 'denied' | 'expired'; title: string; summary: string; requester: string; createdAt: string }

/** The approvals endpoint for the saved link, or null when the link has no approve key. */
export function fluxApprovalsUrl(link = readFluxLiveMapUrl()): string | null {
  try {
    const url = new URL(link)
    if (!url.searchParams.get('approve')) return null
    return `${url.origin}/api/approvals${url.search}`
  } catch { return null }
}

export async function fetchFluxApprovals(): Promise<FluxApproval[]> {
  const url = fluxApprovalsUrl()
  if (!url) return []
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) return []
  return ((await response.json()) as { approvals?: FluxApproval[] }).approvals || []
}

export async function decideFluxApproval(id: string, decision: 'approved' | 'denied'): Promise<boolean> {
  const url = fluxApprovalsUrl()
  if (!url) return false
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, decision, via: 'phone' }) })
  return response.ok
}

export const FLUX_REQUEST_PREFIX = 'flux:'

type Notifier = {
  post: (approval: { requestId: string; bot: string; command: string; description: string }) => unknown
  clear: (requestId: string) => unknown
}

/** Polls Flux every `intervalMs` and keeps one notification per pending approval. Returns a stop function. */
export function watchFluxApprovals({ post, clear }: Notifier, intervalMs = 20_000): () => void {
  const shown = new Set<string>()
  let stopped = false
  const sync = async () => {
    if (stopped || !fluxApprovalsUrl()) return
    try {
      const pending = (await fetchFluxApprovals()).filter(item => item.status === 'pending')
      const live = new Set(pending.map(item => item.id))
      for (const id of [...shown]) if (!live.has(id)) { shown.delete(id); void clear(FLUX_REQUEST_PREFIX + id) }
      for (const item of pending) {
        if (shown.has(item.id)) continue
        shown.add(item.id)
        void post({ requestId: FLUX_REQUEST_PREFIX + item.id, bot: `Flux · ${item.requester.replace(/^bot:/, '')}`, command: item.title, description: item.summary.slice(0, 400) })
      }
    } catch { /* host unreachable (away from home without WireGuard): try again next tick */ }
  }
  void sync()
  const timer = window.setInterval(() => void sync(), intervalMs)
  return () => { stopped = true; window.clearInterval(timer) }
}

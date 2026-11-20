import { useRef, useState } from 'react'
import { ArrowLeft, Link2, Orbit, RefreshCw } from 'lucide-react'

import { useEdgeSwipeBack } from '../edge-swipe'
import { readFluxLiveMapUrl, writeFluxLiveMapUrl } from '../flux'

export { readFluxLiveMapUrl }

const validLink = (value: string) => {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.searchParams.has('key')
  } catch { return false }
}

/**
 * Settings → Flux agents. Shows the host's Flux Live Map (read-only metadata: which specialist agents
 * exist, their lifecycle, TTL, tokens and shadow cost) inside the app. The link carries the view key
 * printed by the host's install.sh; it is stored on this device only.
 */
export function FluxSettings({ back }: { back: () => void }) {
  const shellRef = useRef<HTMLElement>(null)
  useEdgeSwipeBack(shellRef, back)
  const [link, setLink] = useState(readFluxLiveMapUrl)
  const [draft, setDraft] = useState(link)
  const [frameKey, setFrameKey] = useState(0)

  const save = () => {
    const value = draft.trim()
    if (!validLink(value)) return
    writeFluxLiveMapUrl(value)
    setLink(value)
  }

  return <main ref={shellRef} className="app panel notifications-screen flux-screen">
    <header className="panel-head">
      <button className="back-button" onClick={back} aria-label="Back"><ArrowLeft size={19}/></button>
      <div><h2>Flux agents</h2><p>Governed specialists your Bots can call on</p></div>
      {link && <button className="back-button" onClick={() => setFrameKey(value => value + 1)} aria-label="Reload"><RefreshCw size={17}/></button>}
      {link && <button className="back-button" onClick={() => { setDraft(link); setLink('') }} aria-label="Change link"><Link2 size={17}/></button>}
    </header>
    {link
      ? <iframe key={frameKey} className="flux-live-map" src={link} title="Flux Live Map"/>
      : <>
        <section className="notification-hero">
          <Orbit size={17}/>
          <div>
            <b>Connect the Live Map</b>
            <span>Paste the Live Map link that the Flux installer printed on your Hermes host (it ends in ?key=…&amp;approve=…). With the approve part, Flux decisions also arrive here as Allow / Deny notifications. Over WireGuard the same link works away from home.</span>
          </div>
        </section>
        <section className="flux-link">
          <input value={draft} onChange={event => setDraft(event.target.value)} placeholder="http://192.168.68.10:18791/?key=…" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}/>
          <button className="primary wide" disabled={!validLink(draft)} onClick={save}>Save link</button>
        </section>
      </>}
  </main>
}

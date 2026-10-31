import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, RefreshCw, Smartphone, SmartphoneNfc } from 'lucide-react'

import { useEdgeSwipeBack } from '../edge-swipe'
import { hermesMcpSnippet, openAccessibilitySettings, phoneControlAvailable, readPhoneControlStatus, rotatePhoneControlToken, type PhoneControlStatus } from '../phone-control'

/**
 * Settings → Phone control. Android only lets the user switch an accessibility service on, so
 * this screen explains what it grants, opens the right system page, and shows the address and
 * token a Hermes host needs. Status is re-read whenever the app returns to the foreground.
 */
export function PhoneControlSettings({ back }: { back: () => void }) {
  const shellRef = useRef<HTMLElement>(null)
  useEdgeSwipeBack(shellRef, back)
  const [status, setStatus] = useState<PhoneControlStatus | null>(() => readPhoneControlStatus())
  const [hint, setHint] = useState('')

  useEffect(() => {
    const read = () => setStatus(readPhoneControlStatus())
    const timer = window.setInterval(read, 2000)
    document.addEventListener('visibilitychange', read)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', read) }
  }, [])

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setHint(`${what} copied.`) } catch { setHint('Copy is not available here.') }
  }

  const available = phoneControlAvailable()
  const on = !!status?.enabled && !!status?.running

  return <main ref={shellRef} className="app panel notifications-screen phone-control-screen">
    <header className="panel-head"><button className="back-button" onClick={back} aria-label="Back"><ArrowLeft size={19}/></button><div><h2>Phone control</h2><p>Let your Bots use apps on this phone</p></div></header>

    <section className="notification-hero">
      {on ? <SmartphoneNfc size={17}/> : <Smartphone size={17}/>}
      <div>
        <b>{!available ? 'Not available on this device' : on ? 'Bots can operate this phone' : 'Phone control is off'}</b>
        <span>{on
          ? 'A notification shows each action and has a Stop button. Typing into password fields is always blocked.'
          : 'When on, Bots on your Hermes host can read the screen, tap, type, swipe and open apps or links here — only from your private network, with this phone\u2019s token.'}</span>
      </div>
    </section>

    {available && <section className="menu-list">
      <button onClick={() => openAccessibilitySettings()}>{status?.enabled ? 'Turn off in Accessibility settings' : 'Turn on in Accessibility settings'} <span>›</span></button>
    </section>}

    {available && status && <section className="phone-control-details">
      <h3>Connect a Hermes Bot</h3>
      <p>Add this phone as an MCP server on the Bot that should use it. Address: <code>{status.url ?? 'not on a Wi-Fi network'}</code></p>
      <pre>{hermesMcpSnippet({ ...status, token: '••••' + status.token.slice(-6) })}</pre>
      <div className="phone-control-actions">
        <button className="secondary" onClick={() => void copy(hermesMcpSnippet(status), 'Setup')}><Copy size={15}/> Copy setup</button>
        <button className="secondary" onClick={() => { rotatePhoneControlToken(); setStatus(readPhoneControlStatus()); setHint('New token created. Update it on your Hermes host.') }}><RefreshCw size={15}/> New token</button>
      </div>
      {hint && <p className="phone-control-hint" role="status">{hint}</p>}
    </section>}
  </main>
}

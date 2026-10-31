import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { ArrowLeft, Ban, Check, ChevronDown, ChevronUp, Hand, Search, ShieldAlert, Trash2, X, Zap } from 'lucide-react'

import { useEdgeSwipeBack } from '../edge-swipe'
import type { LiveProfile } from '../hermes'
import {
  clearPhoneAudit, openNotificationAccess, readPhoneAudit, readPhoneAuditImage, readPhonePolicy, readReplyDrafts,
  setPhoneAppRule, setPhoneBotAllowed, setReplyDraftApp,
  type PhoneAppRule, type PhoneAuditEntry, type PhoneRuleMode, type ReplyDraftStatus,
} from '../phone-control'
import { BotAvatar } from './BotAvatar'

type PageProps = { back: () => void; profiles: LiveProfile[] }

function Page({ title, subtitle, back, children }: { title: string; subtitle: string; back: () => void; children: ReactNode }) {
  const shellRef = useRef<HTMLElement>(null)
  useEdgeSwipeBack(shellRef, back)
  return <main ref={shellRef} className="app panel notifications-screen phone-control-screen">
    <header className="panel-head"><button className="back-button" onClick={back} aria-label="Back"><ArrowLeft size={19}/></button><div><h2>{title}</h2><p>{subtitle}</p></div></header>
    {children}
  </main>
}

const MODE_LABEL: Record<PhoneRuleMode, string> = { auto: 'Autopilot', ask: 'Ask', block: 'Block' }
const MODE_ICON: Record<PhoneRuleMode, ReactElement> = { auto: <Zap size={13}/>, ask: <Hand size={13}/>, block: <Ban size={13}/> }

const titleize = (name: string) => name.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())

/** Per-app rules and which Bots may use the phone. */
export function PhoneRulesPage({ back, profiles }: PageProps) {
  const [policy, setPolicy] = useState(() => readPhonePolicy())
  const [query, setQuery] = useState('')
  const reload = () => setPolicy(readPhonePolicy())

  // Every Bot on the host, plus any that have used the phone but are not in the roster.
  const bots = useMemo(() => {
    const allowed = new Map(policy.bots.map(bot => [bot.name.toLowerCase(), bot.allowed]))
    const names = new Map<string, string>()
    for (const profile of profiles) names.set(profile.name.toLowerCase(), profile.display_name || titleize(profile.name))
    for (const bot of policy.bots) if (!names.has(bot.name.toLowerCase())) names.set(bot.name.toLowerCase(), bot.name)
    return [...names].map(([key, label]) => ({ key, label, profile: profiles.find(item => item.name.toLowerCase() === key), allowed: allowed.get(key) ?? true }))
  }, [policy.bots, profiles])

  const apps = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const order: Record<PhoneRuleMode, number> = { block: 0, ask: 1, auto: 2 }
    return policy.apps
      .filter(app => !needle || app.label.toLowerCase().includes(needle) || app.package.toLowerCase().includes(needle))
      .sort((a, b) => needle ? a.label.localeCompare(b.label) : (order[a.mode] - order[b.mode]) || a.label.localeCompare(b.label))
  }, [policy.apps, query])

  const choose = (app: PhoneAppRule, mode: PhoneRuleMode) => { setPhoneAppRule(app.package, mode); reload() }

  return <Page title="Rules" subtitle="What Bots may do on this phone" back={back}>
    <p className="phone-control-mode">The phone enforces these itself, so no Bot can talk its way past them. <b>Autopilot</b> acts without asking, <b>Ask</b> shows an Allow / Deny card before anything that sends, posts, pays or deletes, and <b>Block</b> keeps Bots out completely: they can't open the app, read its screen or act in it.</p>

    <h3 className="phone-rules-heading">Bots</h3>
    <section className="menu-list phone-rule-bots">
      {bots.map(bot => <button key={bot.key} className="settings-toggle-row" aria-pressed={bot.allowed} onClick={() => { setPhoneBotAllowed(bot.key, !bot.allowed); reload() }}>
        <span className="phone-rule-bot">{bot.profile ? <BotAvatar profile={bot.profile} fallbackName={bot.key} variant="mention"/> : null}{bot.label}</span>
        <span className={`capability-toggle ${bot.allowed ? 'on' : ''}`}><i/>{bot.allowed ? 'ON' : 'OFF'}</span>
      </button>)}
    </section>

    <h3 className="phone-rules-heading">Apps</h3>
    <label className="phone-rule-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps"/>{query && <button onClick={() => setQuery('')} aria-label="Clear search"><X size={14}/></button>}</label>
    <section className="phone-rule-list">
      {apps.map(app => <div className={`phone-rule-row mode-${app.mode}`} key={app.package}>
        <span className="phone-rule-app"><b>{app.label}</b><small>{app.source === 'custom' ? 'Your choice' : app.source === 'default' ? (app.mode === 'block' ? 'Blocked by default (sensitive)' : 'Asks by default (messaging)') : 'Follows Ask first'}</small></span>
        <span className="phone-rule-modes" role="radiogroup" aria-label={`${app.label} rule`}>
          {(['auto', 'ask', 'block'] as PhoneRuleMode[]).map(mode => <button key={mode} role="radio" aria-checked={app.mode === mode} className={app.mode === mode ? 'selected' : ''} onClick={() => choose(app, mode)} title={MODE_LABEL[mode]}>{MODE_ICON[mode]}<span>{MODE_LABEL[mode]}</span></button>)}
        </span>
        {app.source === 'custom' && <button className="phone-rule-reset" onClick={() => { setPhoneAppRule(app.package, null); reload() }}>Reset</button>}
      </div>)}
      {!apps.length && <p className="phone-control-hint">No apps match.</p>}
    </section>
  </Page>
}

/** Turn reply drafts on per messaging app, and grant Notification access. */
export function ReplyDraftsPage({ back }: PageProps) {
  const [status, setStatus] = useState<ReplyDraftStatus | null>(() => readReplyDrafts())
  useEffect(() => {
    const read = () => setStatus(readReplyDrafts())
    const timer = window.setInterval(read, 2000)
    document.addEventListener('visibilitychange', read)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', read) }
  }, [])

  return <Page title="Reply drafts" subtitle="Bots draft, you decide" back={back}>
    <section className="notification-hero">
      <ShieldAlert size={17}/>
      <div>
        <b>{status?.access ? (status.apps.length ? 'Drafting is on' : 'Pick the apps to draft for') : 'Needs notification access'}</b>
        <span>When a message arrives in an app you turn on below, a Bot on your Hermes host drafts a reply in your voice. It appears as a notification, on the cover screen too, with <strong>Send</strong>, <strong>Edit</strong> and <strong>Ignore</strong>. Nothing is sent unless you send it.</span>
      </div>
    </section>
    {status && !status.access && <section className="menu-list"><button onClick={() => openNotificationAccess()}>Allow notification access <span>›</span></button></section>}
    {status && !status.access && <p className="phone-control-hint">Sideloaded app? If Android greys the switch out, open App info → ⋮ → Allow restricted settings for Hermes Mobile first.</p>}
    {status?.access && <>
      <h3 className="phone-rules-heading">Draft replies for</h3>
      <section className="menu-list">
        {status.available.map(app => <button key={app.package} className="settings-toggle-row" aria-pressed={app.enabled} onClick={() => { setReplyDraftApp(app.package, !app.enabled); setStatus(readReplyDrafts()) }}>
          {app.label} <span className={`capability-toggle ${app.enabled ? 'on' : ''}`}><i/>{app.enabled ? 'ON' : 'OFF'}</span>
        </button>)}
        {!status.available.length && <p className="phone-control-hint">No supported messaging apps are installed.</p>}
      </section>
      <p className="phone-control-mode">Messages are read from the notification only, kept in memory on the phone, and sent to your own Hermes host for drafting. Group chats, codes and automated messages are skipped. Blocked apps are never read.</p>
    </>}
  </Page>
}

const OUTCOME_LABEL: Record<PhoneAuditEntry['outcome'], string> = { done: 'Done', declined: 'You declined', blocked: 'Blocked', failed: 'Failed' }

function dayLabel(at: number): string {
  const day = new Date(at); const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (day.toDateString() === today.toDateString()) return 'Today'
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

function Thumbnails({ entry }: { entry: PhoneAuditEntry }) {
  const [images, setImages] = useState<{ before: string | null; after: string | null }>({ before: null, after: null })
  useEffect(() => {
    setImages({ before: entry.before ? readPhoneAuditImage(entry.id, 'before') : null, after: entry.after ? readPhoneAuditImage(entry.id, 'after') : null })
  }, [entry.id, entry.before, entry.after])
  if (!images.before && !images.after) return <p className="phone-control-hint">No screenshots for this step{entry.outcome === 'blocked' ? ' (blocked apps are never captured)' : ''}.</p>
  return <div className="phone-audit-shots">
    {images.before && <figure><img src={images.before} alt="Screen before the action"/><figcaption>Before</figcaption></figure>}
    {images.after && <figure><img src={images.after} alt="Screen after the action"/><figcaption>After</figcaption></figure>}
  </div>
}

/** Everything Bots did on the phone, newest first, with before/after screenshots. */
export function PhoneActivityPage({ back, profiles }: PageProps) {
  const [entries, setEntries] = useState<PhoneAuditEntry[]>(() => readPhoneAudit())
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setEntries(readPhoneAudit()), 3000)
    return () => window.clearInterval(timer)
  }, [])
  const profileFor = (bot: string) => profiles.find(profile => profile.name.toLowerCase() === bot.toLowerCase())
  const groups = useMemo(() => {
    const result: { day: string; items: PhoneAuditEntry[] }[] = []
    for (const entry of entries) {
      const day = dayLabel(entry.at)
      if (result.at(-1)?.day !== day) result.push({ day, items: [] })
      result.at(-1)!.items.push(entry)
    }
    return result
  }, [entries])

  return <Page title="Activity" subtitle="Everything Bots did on this phone" back={back}>
    {!entries.length && <p className="phone-control-mode">Nothing yet. Every action a Bot takes here — taps, typing, replies, and anything a rule stopped — will be listed with before and after screenshots.</p>}
    {groups.map(group => <section key={group.day} className="phone-audit-day">
      <h3 className="phone-rules-heading">{group.day}</h3>
      {group.items.map(entry => <article key={entry.id} className={`phone-audit-row outcome-${entry.outcome}`}>
        <button className="phone-audit-main" onClick={() => setOpen(open === entry.id ? null : entry.id)} aria-expanded={open === entry.id}>
          <BotAvatar profile={profileFor(entry.bot)} fallbackName={entry.bot} variant="mention"/>
          <span className="phone-audit-copy">
            <b>{profileFor(entry.bot)?.display_name || entry.bot}</b> {entry.summary}{entry.count > 1 ? ` (×${entry.count})` : ''}
            <small>{new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}{entry.appLabel ? ` · ${entry.appLabel}` : ''}</small>
          </span>
          <span className={`phone-audit-badge outcome-${entry.outcome}`}>{entry.outcome === 'done' ? <Check size={12}/> : null}{OUTCOME_LABEL[entry.outcome]}</span>
          {(entry.before || entry.after) && (open === entry.id ? <ChevronUp size={15}/> : <ChevronDown size={15}/>)}
        </button>
        {open === entry.id && <Thumbnails entry={entry}/>}
      </article>)}
    </section>)}
    {!!entries.length && <div className="phone-control-actions"><button className="secondary" onClick={() => { clearPhoneAudit(); setEntries([]) }}><Trash2 size={15}/> Clear activity</button></div>}
  </Page>
}

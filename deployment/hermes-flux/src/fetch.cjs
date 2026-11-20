'use strict';
// flux_fetch: a read-only page reader for Flux agents whose role has web access. The host's Hermes web
// backend (ddgs) can search but not open pages. Only public internet addresses are allowed: the
// household LAN, loopback and link-local ranges are refused at every redirect hop, so an agent cannot
// reach Home Assistant, the phone, or this service.
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 16000;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublic(url, lookup = dns.lookup) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Flux: only http and https URLs can be fetched');
  if (url.username || url.password) throw new Error('Flux: URLs with credentials are refused');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new Error(`Flux: ${host} is not a public internet address`);
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title: title.replace(/\s+/g, ' ').trim(), text: body };
}

async function fetchPage(raw, { fetchImpl = globalThis.fetch, lookup } = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('Flux: invalid URL'); }
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url, lookup);
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HermesFlux/0.1; read-only research)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url);
      continue;
    }
    if (!response.ok) throw new Error(`Flux: ${url.href} returned HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (/pdf|octet-stream|image|video|audio|zip/i.test(type)) throw new Error(`Flux: ${type.split(';')[0]} is not readable here; use a web page instead`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const page = /html/i.test(type) ? htmlToText(body) : { title: '', text: body.trim() };
    return { url: url.href, title: page.title, text: page.text.slice(0, MAX_CHARS), truncated: page.text.length > MAX_CHARS };
  }
  throw new Error('Flux: too many redirects');
}

module.exports = { fetchPage, privateAddress, htmlToText };

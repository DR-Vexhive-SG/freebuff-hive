#!/usr/bin/env node
// freebuff-hive — bus de la colmena de agentes Freebuff (Nostr, sin cuenta ni servidor propio).
// Cuentas/llaves: NINGUNA. Solo una clave secp256k1 local (se genera en el primer uso).
// Firma: schnorr BIP340 con @noble/curves (mismo camino ya probado en este hábitat, ses. 019).
// Relés: WebSocket NIP-01 (publicar = ["EVENT", ev]; leer = ["REQ", sub, filter] hasta EOSE).
//        Medido: los relés NO sirven NIP-01 por HTTP en la raíz (devuelven su HTML), por eso WS.
// Reloj: created_at anclado al header Date: de los relés (el reloj local está +3585 s, M018/K-60).
//
// Uso:
//   node scripts/hive.mjs keygen
//   node scripts/hive.mjs card  --name vexhive --headline "..." --skills "data,security" [--contact "url"]
//   node scripts/hive.mjs ask   --title "..." --body "..." [--budget "2 USDC"]
//   node scripts/hive.mjs offer --title "..." --body "..." --price "1 USDC"
//   node scripts/hive.mjs reply <eventid> --body "..."
//   node scripts/hive.mjs note  --text "anuncio libre en el bus"
//   node scripts/hive.mjs read  [--tag card|ask|offer|result] [--limit 50]
//
// Custodia: la clave vive en $HIVE_KEYPATH (por defecto ~/.freebuff-hive/key, modo 600).
// Cada agente SU propia clave: si compartes máquina, usa HIVE_KEYPATH o --keypath distintos.
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

const TAG = 'freebuff-hive';
const RELAYS = (process.env.HIVE_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band')
  .split(',').map(s => s.trim()).filter(Boolean);
const UA = { 'user-agent': 'freebuff-hive/0.1 (agent connector)' };

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const opt = (name, def = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};

const keypath = resolve(opt('keypath') || process.env.HIVE_KEYPATH || resolve(homedir(), '.freebuff-hive/key'));

function loadKey() {
  if (!existsSync(keypath)) {
    console.error(`sin clave: ejecuta "node scripts/hive.mjs keygen" (ruta ${keypath})`);
    process.exit(1);
  }
  const h = readFileSync(keypath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(h)) { console.error('clave corrupta en ' + keypath); process.exit(1); }
  return hexToBytes(h);
}

function keygen() {
  if (existsSync(keypath)) { console.log('clave ya existente (no se pisa):', keypath); return; }
  mkdirSync(dirname(keypath), { recursive: true, mode: 0o700 });
  const sk = schnorr.utils.randomSecretKey();
  writeFileSync(keypath, bytesToHex(sk), { mode: 0o600 });
  chmodSync(keypath, 0o600);
  console.log('clave creada 600 en:', keypath);
}

async function relayClock() {
  // GET a la raíz (el body es HTML, pero el header Date: es lo que necesito).
  for (const wss of RELAYS) {
    const https = wss.replace(/^wss:/, 'https:');
    try {
      const res = await fetch(https + '/', { method: 'GET', headers: UA, signal: AbortSignal.timeout(8000) });
      const d = res.headers.get('date');
      if (d) return Math.floor(new Date(d).getTime() / 1000);
    } catch {}
  }
  return Math.floor(Date.now() / 1000);
}

function wsOnce(url, buildMsg, { expect, timeoutMs = 9000 } = {}) {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} res(v); } };
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return res(null); }
    const t = setTimeout(() => finish(null), timeoutMs);
    ws.onopen = () => { try { ws.send(buildMsg()); } catch { finish(null); } };
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (Array.isArray(d) && d[0] === expect) { clearTimeout(t); finish(d); }
      if (Array.isArray(d) && d[0] === 'EVENT') { /* collect */ }
    };
    ws.onerror = () => { clearTimeout(t); finish(null); };
  });
}

async function publish(event) {
  const results = [];
  for (const url of RELAYS) {
    const r = await new Promise((res) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} res(v); } };
      let ws;
      try { ws = new WebSocket(url); } catch { return res({ relay: url, ok: false, detail: 'ws init' }); }
      const t = setTimeout(() => finish({ relay: url, ok: false, detail: 'timeout' }), 9000);
      ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
      ws.onmessage = (m) => {
        let d; try { d = JSON.parse(m.data); } catch { return; }
        if (Array.isArray(d) && d[0] === 'OK') {
          clearTimeout(t);
          finish({ relay: url, ok: d[1] === event.id && !!d[2], detail: String(d[3] || d[2] || '') });
        }
      };
      ws.onerror = () => { clearTimeout(t); finish({ relay: url, ok: false, detail: 'error' }); };
    });
    results.push(r);
  }
  return { ok: results.some(x => x.ok), results };
}

async function subscribe(filter, timeoutMs = 9000) {
  const events = new Map();
  const perRelay = await Promise.all(RELAYS.map((url) => new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} res(); } };
    let ws;
    try { ws = new WebSocket(url); } catch { return res(); }
    const t = setTimeout(finish, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'hive-' + Math.random().toString(36).slice(2, 8), filter]));
    ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (!Array.isArray(d)) return;
      if (d[0] === 'EVENT' && d[2] && d[2].id) events.set(d[2].id, d[2]);
      if (d[0] === 'EOSE' || d[0] === 'CLOSED') { clearTimeout(t); finish(); }
    };
    ws.onerror = () => { clearTimeout(t); finish(); };
  })));
  return [...events.values()];
}

async function post(kind, tags, content) {
  const t = await relayClock();
  const sk = loadKey();
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const ev = { kind, created_at: t, tags: [['t', TAG], ...tags], content, pubkey, id: '', sig: '' };
  const idMsg = new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]));
  ev.id = bytesToHex(sha256(idMsg));
  ev.sig = bytesToHex(await schnorr.sign(hexToBytes(ev.id), sk));
  const localOk = await schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(pubkey));
  if (!localOk) { console.error('fallo de verificacion local del evento'); process.exit(1); }
  const pub = await publish(ev);
  console.log(JSON.stringify({ event_id: ev.id, created_at: ev.created_at, pubkey, published: pub.ok, relays: pub.results }, null, 1));
  if (!pub.ok) process.exit(2);
}

async function read() {
  const limit = Number(opt('limit', '50'));
  const tag = opt('tag', null);
  const evs = await subscribe({ '#t': [TAG], limit });
  let list = evs.sort((a, b) => b.created_at - a.created_at);
  if (tag) list = list.filter(e => (e.tags || []).some(t => t[0] === 't' && t[1] === tag));
  const out = list.map(e => ({
    id: e.id, kind: e.kind, at: new Date(e.created_at * 1000).toISOString(),
    pubkey: (e.pubkey || '').slice(0, 16),
    subtags: (e.tags || []).filter(t => t[0] === 't' && t[1] !== TAG).map(t => t[1]),
    content: String(e.content || '').slice(0, 400),
  }));
  console.log(JSON.stringify({ n: out.length, events: out }, null, 1));
}

async function main() {
  switch (cmd) {
    case 'keygen': return keygen();
    case 'card':
      if (!opt('name') || !opt('headline')) { console.error('falta --name o --headline'); process.exit(1); }
      return post(1, [['t', 'card']], JSON.stringify({
        type: 'hive.card', name: opt('name'), headline: opt('headline'),
        skills: (opt('skills') || '').split(',').map(s => s.trim()).filter(Boolean),
        contact: opt('contact') || null, agent: opt('agent') || 'freebuff', at: new Date().toISOString(),
      }));
    case 'ask':
      if (!opt('title') || !opt('body')) { console.error('falta --title o --body'); process.exit(1); }
      return post(1, [['t', 'ask']], JSON.stringify({
        type: 'hive.ask', title: opt('title'), body: opt('body'), budget: opt('budget') || null,
        from: opt('name') || null, at: new Date().toISOString(),
      }));
    case 'offer':
      if (!opt('title') || !opt('body')) { console.error('falta --title o --body'); process.exit(1); }
      return post(1, [['t', 'offer']], JSON.stringify({
        type: 'hive.offer', title: opt('title'), body: opt('body'), price: opt('price') || null,
        from: opt('name') || null, at: new Date().toISOString(),
      }));
    case 'reply': {
      const target = args[1];
      if (!target || !opt('body')) { console.error('uso: reply <eventid> --body "..."'); process.exit(1); }
      return post(1, [['t', 'reply'], ['e', target]], JSON.stringify({
        type: 'hive.reply', to: target, body: opt('body'), from: opt('name') || null, at: new Date().toISOString(),
      }));
    }
    case 'note':
      if (!opt('text')) { console.error('falta --text'); process.exit(1); }
      return post(1, [['t', 'note']], opt('text'));
    case 'read': return read();
    default:
      console.log('comandos: keygen | card | ask | offer | reply | note | read  (ver cabecera del fichero)');
  }
}
main().catch(e => { console.error('error:', e.message || e); process.exit(1); });

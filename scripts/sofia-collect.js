#!/usr/bin/env node
// Ефирът на София – събирач. Пуска се от GitHub Actions на всеки ~5 мин.
// Чете sofia/stations.json, пита стрийм сървърите (Icecast / SHOUTcast) и записва в папката OUT:
//   stats.json              – последното състояние + днешен пик за всяко радио
//   history/ГГГГ-ММ-ДД.csv  – по един ред на радио при всяка проверка (час, радио, слушатели)
// Употреба:  node scripts/sofia-collect.js <OUT>      (Node 18+)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || 'data');
const TIMEOUT = 8000;
const TZ = 'Europe/Sofia';

async function get(url, asJson) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'alma-sofia-collector/1.0', 'Icy-MetaData': '0' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return asJson ? res.json() : res.text();
}

const cache = new Map(); // един сървър се пита веднъж за обиколката
function cachedGet(url, asJson) {
  const k = (asJson ? 'j:' : 't:') + url;
  if (!cache.has(k)) cache.set(k, get(url, asJson));
  return cache.get(k);
}

function parts(stream) {
  const u = new URL(stream);
  return { base: u.origin, mount: u.pathname.replace(/\/$/, '') || '/', u };
}

const METHODS = {
  async icecast(stream) {
    const { base, mount } = parts(stream);
    const j = await cachedGet(base + '/status-json.xsl', true);
    let src = j && j.icestats && j.icestats.source;
    if (!src) throw new Error('няма Icecast източници');
    if (!Array.isArray(src)) src = [src];
    const m = src.find(x => x.listenurl && new URL(x.listenurl, base).pathname === mount) || (src.length === 1 ? src[0] : null);
    if (!m) throw new Error('mount ' + mount + ' не е намерен');
    return { listeners: +m.listeners || 0, peak: +m.listener_peak || 0 };
  },
  async xspf(stream) {
    const { base, mount } = parts(stream);
    const t = await get(base + mount + '.xspf', false);
    const cur = t.match(/Current Listeners:\s*(\d+)/i);
    if (!cur) throw new Error('няма XSPF статистика');
    const pk = t.match(/Peak Listeners:\s*(\d+)/i);
    return { listeners: +cur[1], peak: pk ? +pk[1] : 0 };
  },
  async shoutcast(stream) {
    const { base, u } = parts(stream);
    const sid = u.searchParams.get('sid') || '1';
    const j = await cachedGet(base + '/stats?sid=' + sid + '&json=1', true);
    if (j.currentlisteners == null) throw new Error('не е SHOUTcast');
    return { listeners: +j.currentlisteners, peak: +j.peaklisteners || 0 };
  },
};

async function readStream(stream) {
  if (/\.m3u8/i.test(stream)) throw new Error('HLS поток (CDN) – без публичен брояч');
  const errors = [];
  for (const fn of Object.values(METHODS)) {
    try { return await fn(stream); } catch (e) { errors.push(e.message); }
  }
  throw new Error('сървърът не показва статистика (' + errors[0] + ')');
}

async function readStation(s) {
  if (s.noStats) return { status: 'hidden', note: s.noStats };
  const streams = s.streams || [];
  if (!streams.length) return { status: 'nostream', note: 'Няма стрийм адрес' };
  const res = await Promise.allSettled(streams.map(readStream));
  const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) return { status: 'hidden', note: res[0].reason.message };
  const failed = res.length - ok.length;
  return {
    status: 'ok',
    listeners: ok.reduce((a, r) => a + r.listeners, 0),
    peak: ok.reduce((a, r) => a + r.peak, 0),
    streamCount: ok.length,
    note: failed ? failed + ' от ' + res.length + ' потока без данни' : '',
  };
}

function sofiaDate(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d); }            // ГГГГ-ММ-ДД
function sofiaTime(d) { return new Intl.DateTimeFormat('bg-BG', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); }

(async () => {
  const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'sofia', 'stations.json'), 'utf8'));
  const now = new Date();
  const today = sofiaDate(now);
  fs.mkdirSync(path.join(OUT, 'history'), { recursive: true });

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT, 'stats.json'), 'utf8')); } catch (e) {}
  const prevPeak = {};
  if (prev.date === today) for (const s of prev.stations || []) if (s.dayPeak) prevPeak[s.name] = s.dayPeak;

  const results = await Promise.all(stations.map(readStation));
  const out = stations.map((s, i) => {
    const r = results[i];
    let dayPeak = prevPeak[s.name] || null;
    if (r.status === 'ok' && (!dayPeak || r.listeners > dayPeak.value)) dayPeak = { value: r.listeners, at: now.toISOString() };
    return { name: s.name, freq: s.freq || '', ...r, dayPeak };
  });

  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ updated: now.toISOString(), date: today, stations: out }, null, 1));

  const csv = path.join(OUT, 'history', today + '.csv');
  const head = fs.existsSync(csv) ? '' : 'час,радио,слушатели,пик на сървъра\n';
  const rows = out.filter(s => s.status === 'ok')
    .map(s => [sofiaTime(now), '"' + s.name.replace(/"/g, '""') + '"', s.listeners, s.peak].join(',')).join('\n');
  fs.appendFileSync(csv, head + rows + '\n');

  // пазим историята само за последните KEEP_DAYS дни (по подразбиране 90)
  const keep = +(process.env.KEEP_DAYS || 90);
  const oldest = sofiaDate(new Date(now - keep * 864e5));
  for (const f of fs.readdirSync(path.join(OUT, 'history'))) {
    if (/^\d{4}-\d{2}-\d{2}\.csv$/.test(f) && f.slice(0, 10) < oldest) fs.unlinkSync(path.join(OUT, 'history', f));
  }

  const ok = out.filter(s => s.status === 'ok');
  console.log(`${ok.length}/${out.length} радиа с данни, общо ${ok.reduce((a, s) => a + s.listeners, 0)} слушатели`);
})().catch(e => { console.error(e); process.exit(1); });

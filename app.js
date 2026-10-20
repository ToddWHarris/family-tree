'use strict';
const APP_VERSION = 'v1.0.0';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CONF = ['PROVEN','STRONG','LIKELY','POSSIBLE','UNPROVEN'];
const CONF_HELP = {PROVEN:'Documented by an original record', STRONG:'Strong evidence, several sources agree', LIKELY:'Supported, but not fully proven', POSSIBLE:'A lead worth checking', UNPROVEN:'From a family tree or story only'};

/* ---------- IndexedDB ---------- */
const DB = {
  db: null,
  open() { return this.db ? Promise.resolve(this.db) : new Promise((res, rej) => {
    const r = indexedDB.open('family-tree', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('images'); };
    r.onsuccess = () => { this.db = r.result; res(this.db); }; r.onerror = () => rej(r.error); }); },
  async tx(store, mode, fn) { const d = await this.open(); return new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store); let out; const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); },
  get(store, k) { return this.tx(store, 'readonly', s => s.get(k)); },
  put(store, k, v) { return this.tx(store, 'readwrite', s => s.put(v, k)); },
  clear(store) { return this.tx(store, 'readwrite', s => s.clear()); },
  keys(store) { return this.tx(store, 'readonly', s => s.getAllKeys()); },
};

/* ---------- ZIP reader (stored + deflate via DecompressionStream) ---------- */
async function readZip(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf); let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like a valid .zip file.');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true); const out = {};
  const td = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Zip directory is damaged.');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true); const name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
    const ds = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = u8.slice(ds, ds + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This iPhone is too old to unzip. Update iOS, or import the .json file.');
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    } else throw new Error('Unsupported zip compression in ' + name);
    out[name] = data;
  }
  return out;
}
const mimeOf = n => /\.png$/i.test(n) ? 'image/png' : /\.webp$/i.test(n) ? 'image/webp' : /\.gif$/i.test(n) ? 'image/gif' : 'image/jpeg';

async function importFile(file) {
  let json, images = {};
  if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
    const files = await readZip(await file.arrayBuffer());
    const jn = Object.keys(files).find(n => /\.json$/i.test(n) && !n.split('/').pop().startsWith('.'));
    if (!jn) throw new Error('No .json data file found inside the zip.');
    json = new TextDecoder().decode(files[jn]);
    const base = jn.includes('/') ? jn.slice(0, jn.lastIndexOf('/') + 1) : '';
    for (const [n, d] of Object.entries(files)) if (/\.(jpe?g|png|webp|gif)$/i.test(n)) images[base && n.startsWith(base) ? n.slice(base.length) : n] = new Blob([d], {type: mimeOf(n)});
  } else json = await file.text();
  let data; try { data = JSON.parse(json); } catch (e) { throw new Error('The data file is not valid JSON.'); }
  if (!data || !Array.isArray(data.people)) throw new Error('This file has no "people" list.');
  await DB.clear('images');
  for (const [k, b] of Object.entries(images)) await DB.put('images', k, b);
  await DB.put('kv', 'data', data);
  await DB.put('kv', 'importedAt', new Date().toISOString());
  await DB.put('kv', 'importedName', file.name);
  return data;
}

/* ---------- state ---------- */
const S = { data: null, P: {}, settings: { showLiving: false, fontScale: 1 }, urls: {}, imgKeys: new Set() };
function index(data) {
  S.data = data; S.P = {};
  for (const p of data.people) S.P[p.id] = p;
  S.src = {}; for (const s of (data.sources || [])) S.src[s.id] = s;
  S.photoMeta = {}; for (const ph of (data.photos || [])) S.photoMeta[ph.file] = ph;
}
async function loadAll() {
  const d = await DB.get('kv', 'data'); const st = await DB.get('kv', 'settings');
  if (st) Object.assign(S.settings, st);
  applyFont();
  if (d) { index(d); S.imgKeys = new Set(await DB.keys('images')); }
}
function applyFont() { document.documentElement.style.setProperty('--fs', Math.round(19 * S.settings.fontScale) + 'px'); }
async function imgURL(file) {
  if (S.urls[file]) return S.urls[file];
  const b = await DB.get('images', file); if (!b) return null;
  return (S.urls[file] = URL.createObjectURL(b));
}

/* ---------- person helpers ---------- */
const hidden = p => p && p.isLiving && !S.settings.showLiving;
const ev = (p, t) => (p.events || []).find(e => e.type === t);
const yearOf = s => { const m = String(s || '').match(/\b(1[5-9]\d\d|20\d\d)\b/); return m ? m[1] : ''; };
function years(p) {
  if (!p) return '';
  if (hidden(p)) return 'Living';
  const b = yearOf((ev(p, 'Birth') || {}).date), d = yearOf((ev(p, 'Death') || {}).date);
  if (!b && !d) return p.isLiving ? 'Living' : '';
  return (b || '?') + ' – ' + (d || (p.isLiving ? '' : '?'));
}
const badge = c => c ? `<span class="badge b-${esc(c)}" title="${esc(CONF_HELP[c] || '')}">${esc(c)}</span>` : '';
const initials = p => (p.name || '?').replace(/["(].*?[")]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
function prow(p, extra = '') {
  if (!p) return '';
  const ph = !hidden(p) && (p.photos || []).find(f => S.imgKeys.has(f));
  return `<a class="prow ${esc(p.sex)}" href="#/person/${encodeURIComponent(p.id)}">
    <span class="av" ${ph ? `data-img="${esc(ph)}"` : ''}>${esc(initials(p))}</span>
    <span><span class="nm">${esc(p.name)}</span> ${extra}<br><span class="yr">${esc(years(p))}</span></span><span class="chev">&#8250;</span></a>`;
}
const parentsOf = p => (p.parents || []).map(i => S.P[i]).filter(Boolean);
const childrenOf = p => (p.children || []).map(i => S.P[i]).filter(Boolean).sort((a, b) => (yearOf((ev(a, 'Birth') || {}).date) || 9999) - (yearOf((ev(b, 'Birth') || {}).date) || 9999));
function siblingsOf(p) {
  const ids = new Set(); for (const par of parentsOf(p)) for (const c of par.children || []) if (c !== p.id) ids.add(c);
  return [...ids].map(i => S.P[i]).filter(Boolean);
}
const father = p => parentsOf(p).find(x => x.sex === 'M') || null;
const mother = p => parentsOf(p).find(x => x.sex !== 'M') || null;
async function hydrateImgs(root) {
  for (const el of root.querySelectorAll('[data-img]')) {
    const u = await imgURL(el.dataset.img); if (!u) continue;
    if (el.tagName === 'IMG') el.src = u; else el.innerHTML = `<img alt="" src="${u}">`;
  }
}

/* ---------- views ---------- */
const V = {};
let navStack = [];
function setTitle(t) { $('#title').textContent = t; document.title = t + ' · Family Tree'; }

V.welcome = () => { setTitle('Family Tree'); return `
  <div class="hero"><img src="./icons/icon-192.png" width="96" height="96" alt="" style="border-radius:22px"><div class="big">Welcome</div>
  <p class="sub">This app keeps your family tree on this iPhone. To begin, import your family data file
  (<b>.zip</b> with photos, or <b>.json</b>).</p></div>
  <button class="btn" data-act="import">Import data</button>
  <p class="muted small">Tip: save the file to the Files app (for example from email or AirDrop), then tap Import data and choose it.
  Your data stays on this phone. It is not uploaded anywhere.</p>
  <p class="muted small">Version <span class="version">${APP_VERSION}</span></p>`; };

V.home = () => {
  const r = S.P[S.data.rootPersonId] || S.data.people[0];
  setTitle('Family Tree');
  const f = father(r), m = mother(r);
  const open = (S.data.research || []).filter(x => !/^(answered|resolved|closed)/i.test(x.status || '')).length;
  return `<div class="hero"><div class="big">${esc(r.name)}</div><div class="sub">${esc(S.data.people.length)} people · ${(S.data.sources || []).length} sources · ${(S.data.photos || []).length} photos</div></div>
  <input type="search" id="homeSearch" placeholder="Search names, places, years…" enterkeyhint="search">
  ${prow(r, '<span class="muted small">(you)</span>')}
  <div class="chips" style="margin:12px 0">
    <a class="chip" href="#/pedigree/${encodeURIComponent(r.id)}">&#9783; Pedigree chart</a>
    <a class="chip" href="#/family/${encodeURIComponent(r.id)}">&#128106; Family view</a>
    <a class="chip" href="#/research">&#10067; Research (${open})</a>
    <a class="chip" href="#/photos">&#128247; Photos</a>
  </div>
  <h2>Parents</h2>${[f, m].filter(Boolean).map(p => prow(p)).join('') || '<p class="muted">None recorded</p>'}
  <h2>Grandparents</h2>${[f, m].filter(Boolean).flatMap(p => parentsOf(p)).map(p => prow(p)).join('') || '<p class="muted">None recorded</p>'}
  <h2>Earliest paternal-line ancestor</h2>${(() => { let p = r; while (father(p)) p = father(p); return p !== r ? `<a class="btn secondary" href="#/descendants/${encodeURIComponent(p.id)}">Descendants of ${esc(p.name)}</a>` : ''; })()}
  <h2>Confidence labels</h2><div class="card">${CONF.map(c => `<div style="margin:6px 0">${badge(c)} <span class="small">${esc(CONF_HELP[c])}</span></div>`).join('')}</div>`;
};

V.pedigree = id => {
  const root = S.P[id] || S.P[S.data.rootPersonId];
  setTitle('Pedigree');
  const G = 4; const gens = [[root]];
  for (let g = 1; g < G; g++) gens.push(gens[g - 1].flatMap(p => p ? [father(p), mother(p)] : [null, null]));
  const box = (p, g, i) => {
    if (!p) return `<div class="slot"><span class="pbox empty">${g ? (i % 2 ? 'Mother' : 'Father') + '<br>unknown' : ''}</span></div>`;
    const pc = !hidden(p) && p.parentConfidence && p.parentConfidence !== 'PROVEN' && (p.parents || []).length ? '' : '';
    const kidC = g > 0 ? gens[g - 1][i >> 1] : null;
    const lc = kidC && kidC.parentConfidence && kidC.parentConfidence !== 'UNPROVEN' ? badge(kidC.parentConfidence) : (kidC && kidC.curated ? badge(kidC.parentConfidence || 'UNPROVEN') : '');
    return `<div class="slot"><a class="pbox ${esc(p.sex)} ${g ? '' : 'root'}" href="#/person/${encodeURIComponent(p.id)}"><b>${esc(p.name)}</b><span class="yr">${esc(years(p))}</span>${pc}${lc ? '<br>' + lc : ''}</a></div>`;
  };
  return `  <div class="pedwrap"><div class="ped" style="height:${2 ** (G - 1) * 76}px">
  ${gens.map((col, g) => `<div class="gen">${col.map((p, i) => box(p, g, i)).join('')}</div>`).join('')}
  </div></div><div class="pedctl"><span class="muted small">Swipe sideways to see older generations. Tap a person to open them.</span></div>
  <div class="chips"><a class="chip" href="#/pedigree/${encodeURIComponent(S.data.rootPersonId)}">Start at ${esc((S.P[S.data.rootPersonId] || {}).name || 'home')}</a>
  ${father(root) ? `<a class="chip" href="#/pedigree/${encodeURIComponent(father(root).id)}">Father's side &#8250;</a>` : ''}
  ${mother(root) ? `<a class="chip" href="#/pedigree/${encodeURIComponent(mother(root).id)}">Mother's side &#8250;</a>` : ''}</div><p class="muted small">Badges on a box show how sure we are that this person is the parent of the person to the left.</p>`;
};

V.family = id => {
  const p = S.P[id]; if (!p) return notFound();
  setTitle('Family');
  const sp = (p.spouses || []).map(s => ({s, q: S.P[s.id]})).filter(x => x.q);
  return `${prow(p)}
  <h2>Parents ${p.parentConfidence && (p.parents || []).length ? badge(p.parentConfidence) : ''}</h2>${parentsOf(p).map(x => prow(x)).join('') || '<p class="muted">Not recorded</p>'}
  <h2>Spouses</h2>${sp.map(({s, q}) => prow(q, hidden(q) ? '' : `<br><span class="small muted">${s.marriageDate ? 'Married ' + esc(s.marriageDate) : ''}${s.place ? ', ' + esc(s.place) : ''}</span>`)).join('') || '<p class="muted">None recorded</p>'}
  <h2>Children</h2>${childrenOf(p).map(x => prow(x)).join('') || '<p class="muted">None recorded</p>'}
  <h2>Brothers &amp; sisters</h2>${siblingsOf(p).map(x => prow(x)).join('') || '<p class="muted">None recorded</p>'}
  <a class="btn secondary" href="#/pedigree/${encodeURIComponent(p.id)}">Pedigree chart from here</a>
  <a class="btn secondary" href="#/descendants/${encodeURIComponent(p.id)}">Descendants</a>`;
};

function srcLinks(ids) {
  return (ids || []).map(i => S.src[i]).filter(Boolean).map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)).join('; ');
}
V.person = id => {
  const p = S.P[id]; if (!p) return notFound();
  setTitle(p.name);
  const hid = hidden(p);
  const head = `<div class="hero"><div class="big">${esc(p.name)}</div>
    ${!hid && p.nickname ? `<div class="sub">“${esc(p.nickname)}”</div>` : ''}
    ${!hid && (p.altNames || []).length ? `<div class="alt">Also: ${p.altNames.map(esc).join(' · ')}</div>` : ''}
    ${!hid && p.maiden ? `<div class="alt">Maiden name: ${esc(p.maiden)}</div>` : ''}
    <div class="sub">${esc(years(p))}</div>${!hid && p.confidence ? `<div style="margin-top:6px">${badge(p.confidence)}</div>` : ''}</div>`;
  const rel = `<div class="chips"><a class="chip" href="#/family/${encodeURIComponent(p.id)}">&#128106; Family</a><a class="chip" href="#/pedigree/${encodeURIComponent(p.id)}">&#9783; Pedigree</a><a class="chip" href="#/descendants/${encodeURIComponent(p.id)}">&#8615; Descendants</a></div>`;
  const quick = `<h3>Parents ${p.parentConfidence && (p.parents || []).length ? badge(p.parentConfidence) : ''}</h3>${parentsOf(p).map(x => prow(x)).join('') || '<p class="muted">Not recorded</p>'}`;
  const cand = (p.candidateParents || []).length ? `<div class="card"><h3 style="margin-top:0">Possible parents (research)</h3>${p.candidateParents.map(c =>
    `<div style="margin:10px 0">${badge(c.confidence)} ${c.ids.map(i => S.P[i]).filter(Boolean).map(q => `<a href="#/person/${encodeURIComponent(q.id)}">${esc(q.name)}</a>`).join(' &amp; ')}<div class="small muted">${esc(c.note)}</div></div>`).join('')}</div>` : '';
  if (hid) return head + `<div class="card muted">Details are hidden for living people. You can show them in Settings.</div>` + rel + quick;
  const KEY = ['Birth', 'Marriage', 'Death', 'Burial'];
  const marr = (p.spouses || []).filter(s => s.marriageDate || s.place).map(s => ({type: 'Marriage', date: s.marriageDate, place: [S.P[s.id] && !hidden(S.P[s.id]) ? 'to ' + S.P[s.id].name : '', s.place].filter(Boolean).join(', '), confidence: s.confidence, sourceIds: []}));
  const evs = p.events || [];
  const keyEvs = KEY.flatMap(t => { const e = evs.filter(x => x.type === t); return e.length ? e : (t === 'Marriage' ? marr : []); });
  const evHTML = e => `<div class="evt"><div class="t">${esc(e.type)}</div><div><div>${esc(e.date || 'Date unknown')} ${badge(e.confidence)}</div>${e.place ? `<div>${esc(e.place)}</div>` : ''}${(e.sourceIds || []).length ? `<div class="src">Source: ${srcLinks(e.sourceIds)}</div>` : ''}</div></div>`;
  const tl = evs.slice().sort((a, b) => (yearOf(a.date) || 9999) - (yearOf(b.date) || 9999));
  const sids = [...new Set(evs.flatMap(e => e.sourceIds || []))];
  const photos = (p.photos || []).filter(f => S.imgKeys.has(f));
  return head + rel + `<div class="card">${keyEvs.map(evHTML).join('') || '<p class="muted">No vital events recorded</p>'}</div>` + quick + cand +
    `<h3>Spouses</h3>${(p.spouses || []).map(s => S.P[s.id]).filter(Boolean).map(q => prow(q)).join('') || '<p class="muted">None recorded</p>'}
    <h3>Children</h3>${childrenOf(p).map(x => prow(x)).join('') || '<p class="muted">None recorded</p>'}
    ${photos.length ? `<h2>Photos &amp; records</h2><div class="photos">${photos.map((f, i) => `<img data-img="${esc(f)}" data-photo="${i}" alt="${esc((S.photoMeta[f] || {}).caption || '')}">`).join('')}</div>` : ''}
    ${p.notes ? `<h2>Notes</h2><div class="card notes">${esc(p.notes)}</div>` : ''}
    <h2>Timeline</h2><div class="timeline">${tl.map(e => `<div class="ti"><b>${esc(e.date || '?')}</b> · ${esc(e.type)} ${badge(e.confidence)}<div class="small">${esc(e.place || '')}</div></div>`).join('') || '<p class="muted">No facts</p>'}</div>
    <h2>Sources</h2><div class="card">${sids.map(i => S.src[i]).filter(Boolean).map(s => `<div class="srcitem"><b>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</b>${s.citation ? `<div class="muted small">${esc(s.citation)}</div>` : ''}</div>`).join('') || '<p class="muted">No sources</p>'}</div>`;
};
V.person.after = (id) => {
  const p = S.P[id]; if (!p) return;
  const photos = (p.photos || []).filter(f => S.imgKeys.has(f));
  document.querySelectorAll('[data-photo]').forEach(el => el.onclick = () => openViewer(photos, +el.dataset.photo));
};

V.search = q => {
  setTitle('Search'); q = q || '';
  return `<input type="search" id="q" value="${esc(q)}" placeholder="Name, place or year" enterkeyhint="search" autocomplete="off">
  <p class="muted small">Examples: a surname, a town such as <i>Ohio</i>, or a year such as <i>1900</i></p>
  <div id="results">${searchResults(q)}</div>`;
};
function searchResults(q) {
  q = (q || '').trim().toLowerCase(); if (q.length < 2) return '<p class="muted">Type at least 2 letters.</p>';
  const terms = q.split(/\s+/); const hits = [];
  for (const p of S.data.people) {
    const nameTxt = [p.name, p.given, p.surname, p.maiden, p.nickname, ...(p.altNames || [])].join(' ').toLowerCase();
    const detTxt = hidden(p) ? '' : (p.events || []).map(e => e.date + ' ' + e.place).join(' ').toLowerCase();
    if (!terms.every(t => nameTxt.includes(t) || detTxt.includes(t))) continue;
    const byName = terms.every(t => nameTxt.includes(t));
    let why = '';
    if (!byName) { const e = (p.events || []).find(e => terms.some(t => (e.date + ' ' + e.place).toLowerCase().includes(t))); if (e) why = `<br><span class="small muted">${esc(e.type)}: ${esc([e.date, e.place].filter(Boolean).join(', '))}</span>`; }
    hits.push({p, score: (byName ? 0 : 1) + (p.curated ? 0 : 0.5), why});
  }
  hits.sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name));
  return `<p class="muted">${hits.length} found</p>` + hits.slice(0, 200).map(h => prow(h.p, h.why)).join('') + (hits.length > 200 ? '<p class="muted">Showing first 200 — add more words to narrow it down.</p>' : '');
}
V.search.after = () => {
  const i = $('#q'); let t;
  i.oninput = () => { clearTimeout(t); t = setTimeout(() => { $('#results').innerHTML = searchResults(i.value); hydrateImgs($('#results')); history.replaceState(null, '', '#/search/' + encodeURIComponent(i.value)); }, 200); };
  if (!i.value) i.focus();
};

V.research = () => {
  setTitle('Research');
  const mary = S.data.people.find(p => (p.candidateParents || []).length);
  return `<p class="muted">Open questions in the family research. Tap a question to read more.</p>
  ${mary ? `<a class="btn secondary" href="#/person/${encodeURIComponent(mary.id)}">Possible parents of ${esc(mary.name)}</a>` : ''}
  ${(S.data.research || []).map((r, i) => `<details class="card" ${i === 0 ? 'open' : ''}><summary>${esc(r.title)}</summary><div class="status">${esc(r.status || '')}</div><div class="notes">${linkify(r.body)}</div></details>`).join('') || '<p class="muted">No research notes.</p>'}`;
};
function linkify(t) { return esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>'); }

V.descendants = id => {
  const p = S.P[id] || S.P[S.data.rootPersonId]; setTitle('Descendants');
  let count = 0;
  const node = (q, d, seen) => {
    if (seen.has(q.id) || d > 10) return ''; seen.add(q.id); count++;
    const sp = (q.spouses || []).map(s => S.P[s.id]).filter(Boolean).map(s => esc(s.name)).join(', ');
    const kids = childrenOf(q);
    return `<li><a href="#/person/${encodeURIComponent(q.id)}"><b>${esc(q.name)}</b> <span class="muted small">${esc(years(q))}</span></a>${sp ? `<div class="sp">m. ${sp}</div>` : ''}${kids.length ? `<ul>${kids.map(k => node(k, d + 1, seen)).join('')}</ul>` : ''}</li>`;
  };
  const tree = node(p, 0, new Set());
  return `<p class="muted">Everyone descended from <b>${esc(p.name)}</b> (${count - 1} people). Tap a name to open it.</p><div class="desc card"><ul style="border:0;padding:0">${tree}</ul></div>`;
};

V.photos = () => {
  setTitle('Photos');
  const list = (S.data.photos || []).filter(ph => S.imgKeys.has(ph.file));
  return list.length ? `<div class="photos">${list.map((ph, i) => `<img data-img="${esc(ph.file)}" data-photo="${i}" alt="${esc(ph.caption)}">`).join('')}</div>` : '<p class="muted">No photos were imported. Import the .zip file to include photos.</p>';
};
V.photos.after = () => {
  const list = (S.data.photos || []).filter(ph => S.imgKeys.has(ph.file)).map(ph => ph.file);
  document.querySelectorAll('[data-photo]').forEach(el => el.onclick = () => openViewer(list, +el.dataset.photo));
};

V.settings = async () => {
  setTitle('Settings');
  const at = await DB.get('kv', 'importedAt'), nm = await DB.get('kv', 'importedName');
  return `<div class="card"><div class="toggle"><label for="showLiving"><b>Show living people's details</b><br><span class="small muted">Off: living people show their name only.</span></label><input type="checkbox" id="showLiving" ${S.settings.showLiving ? 'checked' : ''}></div></div>
  <div class="card"><b>Text size</b><div class="chips">${[[0.9, 'Smaller'], [1, 'Normal'], [1.15, 'Larger'], [1.3, 'Largest']].map(([v, l]) => `<button class="chip ${S.settings.fontScale === v ? 'on' : ''}" data-font="${v}">${l}</button>`).join('')}</div></div>
  <div class="card"><b>Your data</b><p class="small muted">${S.data ? `${S.data.people.length} people, ${S.imgKeys.size} photos.<br>Imported ${at ? new Date(at).toLocaleString() : ''} from ${esc(nm || 'file')}.<br>Data generated ${esc(S.data.generated || '')}.` : 'No data imported.'}</p>
  <button class="btn" data-act="import">Re-import data file</button>
  ${S.data ? '<button class="btn secondary" data-act="export">Export backup (.zip)</button>' : ''}
  <button class="btn danger" data-act="clear">Clear all data</button></div>
  <div class="card small"><b>Important:</b> your family data is stored only inside this app on this iPhone. If you delete the app from your Home Screen (or clear Safari website data), the data is erased. Keep the original data file (or an exported backup) somewhere safe, like the Files app or iCloud Drive.</div>
  <div class="card"><b>Version</b> <span class="version" id="ver">${APP_VERSION}</span><p class="small muted">The app checks for updates each time it opens.</p><button class="btn secondary" data-act="update">Check for update now</button></div>`;
};
V.settings.after = () => {
  $('#showLiving').onchange = async e => { S.settings.showLiving = e.target.checked; await DB.put('kv', 'settings', S.settings); };
  document.querySelectorAll('[data-font]').forEach(b => b.onclick = async () => { S.settings.fontScale = +b.dataset.font; applyFont(); await DB.put('kv', 'settings', S.settings); route(); });
};

/* ---------- zip writer for backup (stored, no compression) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(); const parts = [], cen = []; let off = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(h.buffer, nb, data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    cen.push(c.buffer, nb); off += 30 + nb.length + data.length;
  }
  const cs = cen.reduce((a, b) => a + b.byteLength, 0);
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, e.buffer], {type: 'application/zip'});
}
async function exportBackup() {
  const files = [['family-tree-data.json', new TextEncoder().encode(JSON.stringify(S.data))]];
  for (const k of await DB.keys('images')) { const b = await DB.get('images', k); files.push([k, new Uint8Array(await b.arrayBuffer())]); }
  const blob = makeZip(files); const name = 'family-tree-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
  const file = new File([blob], name, {type: 'application/zip'});
  if (navigator.canShare && navigator.canShare({files: [file]})) { try { await navigator.share({files: [file], title: 'Family tree backup'}); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- viewer ---------- */
let VW = {list: [], i: 0};
async function showV() {
  const f = VW.list[VW.i]; $('#viewerImg').src = (await imgURL(f)) || '';
  const m = S.photoMeta[f] || {};
  $('#viewerCap').innerHTML = esc(m.caption || '') + (m.people || []).map(i => S.P[i]).filter(Boolean).map(p => ` · <a style="color:#ffd58a" href="#/person/${encodeURIComponent(p.id)}">${esc(p.name)}</a>`).join('');
  $('#vCount').textContent = (VW.i + 1) + ' of ' + VW.list.length;
  $('#vPrev').disabled = VW.i === 0; $('#vNext').disabled = VW.i === VW.list.length - 1;
}
function openViewer(list, i) { VW = {list, i}; $('#viewer').hidden = false; document.body.style.overflow = 'hidden'; showV(); }
function closeViewer() { $('#viewer').hidden = true; document.body.style.overflow = ''; }
$('#viewerClose').onclick = closeViewer;
$('#vPrev').onclick = () => { if (VW.i > 0) { VW.i--; showV(); } };
$('#vNext').onclick = () => { if (VW.i < VW.list.length - 1) { VW.i++; showV(); } };
$('#viewerCap').addEventListener('click', e => { if (e.target.tagName === 'A') closeViewer(); });
let tx0 = null;
$('#viewerImgWrap').addEventListener('touchstart', e => { tx0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, {passive: true});
$('#viewerImgWrap').addEventListener('touchend', e => { if (tx0 == null) return; const dx = e.changedTouches[0].clientX - tx0; if (Math.abs(dx) > 60) (dx < 0 ? $('#vNext') : $('#vPrev')).click(); tx0 = null; });

/* ---------- router ---------- */
function notFound() { setTitle('Not found'); return '<p>That person was not found. <a href="#/home">Go home</a></p>'; }
async function route() {
  closeViewer();
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')); const [name, ...rest] = h.split('/'); const arg = rest.join('/');
  let v = name || 'home';
  if (!S.data && v !== 'settings') v = 'welcome';
  if (!V[v]) v = 'home';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === v || (v === 'pedigree' && a.dataset.tab === 'pedigree')));
  $('#tabs').style.display = S.data ? '' : 'none';
  $('#view').innerHTML = await V[v](arg);
  if (V[v].after) V[v].after(arg);
  if (v === 'home') { const i = $('#homeSearch'); i.onkeydown = e => { if (e.key === 'Enter') location.hash = '#/search/' + encodeURIComponent(i.value); }; }
  hydrateImgs($('#view'));
  if (!S.noScroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
$('#backBtn').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/home');
$('#homeBtn').onclick = () => location.hash = '#/home';
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'import') $('#fileInput').click();
  if (a === 'export') exportBackup().catch(err => alert('Export failed: ' + err.message));
  if (a === 'update') { const r = await navigator.serviceWorker?.getRegistration(); if (r) await r.update(); alert('Checked for updates. If one was found, the app will reload.'); }
  if (a === 'clear' && confirm('Erase all family data and photos from this app? You can import the file again later.')) {
    await DB.clear('kv'); await DB.clear('images'); Object.values(S.urls).forEach(u => URL.revokeObjectURL(u));
    S.data = null; S.urls = {}; S.imgKeys = new Set(); S.settings = {showLiving: false, fontScale: 1}; applyFont(); location.hash = '#/home'; route();
  }
});
$('#fileInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  $('#view').innerHTML = '<div class="hero"><div class="big">Importing…</div><p class="sub">Please wait, this can take a few seconds.</p></div>';
  try {
    const d = await importFile(f); Object.values(S.urls).forEach(u => URL.revokeObjectURL(u)); S.urls = {};
    index(d); S.imgKeys = new Set(await DB.keys('images'));
    alert(`Imported ${d.people.length} people and ${S.imgKeys.size} photos.`);
    location.hash = '#/home'; route();
  } catch (err) { alert('Import failed: ' + err.message); route(); }
};

/* ---------- service worker (iOS-friendly update flow) ---------- */
if ('serviceWorker' in navigator) {
  let reloaded = false; const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded || !hadController) return; reloaded = true; location.reload(); });
  navigator.serviceWorker.register('./sw.js', {scope: './', updateViaCache: 'none'}).then(reg => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

loadAll().then(route).catch(err => { $('#view').innerHTML = '<p>Could not open storage: ' + esc(err.message) + '</p>'; });

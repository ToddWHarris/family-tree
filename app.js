'use strict';
const APP_VERSION = 'v1.3.0';
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
  S.data = data; S._lines = null; S._dist = null; S.trail = []; S.trailPos = -1; S.P = {};
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
const STATUS = {
  'VERIFIED': {i: '✓', c: 'st-ver', h: '2 or more independent original records agree on who this is and on the parent link.'},
  'SUPPORTED': {i: '◐', c: 'st-sup', h: 'One record, or strong indirect evidence. Not fully proven yet.'},
  'LEAD': {i: '?', c: 'st-lead', h: 'A hypothesis we are testing. Treat with caution.'},
  'TREE ONLY': {i: '–', c: 'st-tree', h: 'Copied from the Ancestry tree. No record has been checked by us.'}};
const ST_ORDER = ['VERIFIED', 'SUPPORTED', 'LEAD', 'TREE ONLY'];
const sbadge = (st, label = true) => st && STATUS[st] ? `<span class="sb ${STATUS[st].c}" title="${esc(st + ': ' + STATUS[st].h)}"><span class="sbi">${STATUS[st].i}</span>${label ? `<span class="sbl">${esc(st)}</span>` : ''}</span>` : '';
const badge = c => c ? `<span class="badge b-${esc(c)}" title="${esc(CONF_HELP[c] || '')}">${esc(c)}</span>` : '';
const initials = p => (p.name || '?').replace(/["(].*?[")]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
function prow(p, extra = '') {
  if (!p) return '';
  const ph = !hidden(p) && (p.photos || []).find(f => S.imgKeys.has(f));
  return `<a class="prow ${esc(p.sex)}" href="#/person/${encodeURIComponent(p.id)}">
    <span class="av" ${ph ? `data-img="${esc(ph)}"` : ''}>${esc(initials(p))}</span>
    <span><span class="nm">${esc(p.name)}</span> ${sbadge(p.status)} ${extra}<br><span class="yr">${esc(years(p))}</span></span><span class="chev">&#8250;</span></a>`;
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
    <button class="chip" data-act="share" style="border:0;font:inherit;cursor:pointer">&#128228; Share</button>
    <a class="chip" href="#/tree/${encodeURIComponent(r.id)}">&#127795; Family tree</a><a class="chip" href="#/pedigree/${encodeURIComponent(r.id)}">&#9783; Pedigree chart</a>
    <a class="chip" href="#/family/${encodeURIComponent(r.id)}">&#128106; Family view</a>
    <a class="chip" href="#/research">&#10067; Research (${open})</a>
    <a class="chip" href="#/photos">&#128247; Photos</a>
  </div>
  <h2>Parents</h2>${[f, m].filter(Boolean).map(p => prow(p)).join('') || '<p class="muted">None recorded</p>'}
  <h2>Grandparents</h2>${[f, m].filter(Boolean).flatMap(p => parentsOf(p)).map(p => prow(p)).join('') || '<p class="muted">None recorded</p>'}
  <h2>Earliest paternal-line ancestor</h2>${(() => { let p = r; while (father(p)) p = father(p); return p !== r ? `<a class="btn secondary" href="#/descendants/${encodeURIComponent(p.id)}">Descendants of ${esc(p.name)}</a>` : ''; })()}
  <h2>How much is verified? <button class="qbtn" data-act="legend" aria-label="Legend">?</button></h2><div class="card">${ST_ORDER.map(k => `<div class="cntrow">${sbadge(k)}<b>${S.data.people.filter(p => (p.status || 'TREE ONLY') === k).length}</b></div>`).join('')}<p class="small muted">Out of ${S.data.people.length} people.</p></div>
  <h2>Fact confidence labels</h2><div class="card">${CONF.map(c => `<div style="margin:6px 0">${badge(c)} <span class="small">${esc(CONF_HELP[c])}</span></div>`).join('')}</div>`;
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
    <div class="sub">${esc(years(p))}</div>${S.data && relLabel(p) ? `<div class="trel">${esc(relLabel(p))}</div>` : ''}<div style="margin-top:8px">${sbadge(p.status)} <button class="qbtn" data-act="legend" aria-label="What do these labels mean?">?</button></div></div>`;
  const rel = `<div class="chips"><a class="chip" href="#/tree/${encodeURIComponent(p.id)}">&#127795; Tree</a><a class="chip" href="#/family/${encodeURIComponent(p.id)}">&#128106; Family</a><a class="chip" href="#/pedigree/${encodeURIComponent(p.id)}">&#9783; Pedigree</a><a class="chip" href="#/descendants/${encodeURIComponent(p.id)}">&#8615; Descendants</a></div>`;
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
    ${whyHTML(p)}
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
  <h2>Needs proof — closest relatives first</h2>${needsProof()}
  <h2>Open questions</h2>
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
  <button class="btn" data-act="share">&#128228; Share family tree</button>
  ${S.data ? '<button class="btn secondary" data-act="export">Export backup (.zip)</button>' : ''}
  <button class="btn danger" data-act="clear">Clear all data</button></div>
  <div class="card small"><b>Important:</b> your family data is stored only inside this app on this iPhone. If you delete the app from your Home Screen (or clear Safari website data), the data is erased. Keep the original data file (or an exported backup) somewhere safe, like the Files app or iCloud Drive.</div>
  <div class="card about" id="about"><h3 style="margin-top:0">About</h3><p><b>Family Tree</b><br>Created by Todd W Harris, Hamler, Ohio<br>Version ${APP_VERSION}<br>© 2026 Todd W Harris</p><p class="small muted">Your family data stays on this device. It is not part of the app and is never uploaded.</p></div>
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
async function buildZip() {
  const files = [['family-tree-data.json', new TextEncoder().encode(JSON.stringify(S.data))]];
  for (const k of await DB.keys('images')) { const b = await DB.get('images', k); files.push([k, new Uint8Array(await b.arrayBuffer())]); }
  return makeZip(files);
}
const SHARE_URL = 'https://toddwharris.github.io/family-tree/';
const SHARE_NAME = 'harris-family-data.zip';
const SHARE_TEXT = "Here's our family tree: " + SHARE_URL + " \n\nThe attached file is " + SHARE_NAME + " with all the photos. Save it to your Files app, then open the link in Safari, go to Settings, choose Import, and select that zip file. The tree loads right in. Tip: use Safari's share button and Add to Home Screen so it works like an app. Your data stays on your phone.";
function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
async function shareTree() {
  const base = {title: 'Family Tree', text: SHARE_TEXT, url: SHARE_URL};
  const quiet = e => { if (e && e.name === 'AbortError') return true; throw e; };
  if (!S.data) {
    if (navigator.share) { try { await navigator.share(base); } catch (e) { quiet(e); } return; }
    try { await navigator.clipboard.writeText(SHARE_TEXT); } catch (e) {}
    alert('Sharing is not available here. The link and instructions were copied to the clipboard:\n\n' + SHARE_URL); return;
  }
  const blob = await buildZip(); const file = new File([blob], SHARE_NAME, {type: 'application/zip'});
  if (navigator.share) {
    if (navigator.canShare && navigator.canShare({files: [file]})) { try { await navigator.share({...base, files: [file]}); } catch (e) { quiet(e); } return; }
    try { await navigator.share(base); } catch (e) { if (quiet(e)) return; }
    downloadBlob(blob, SHARE_NAME);
    alert('This device cannot attach files when sharing, so ' + SHARE_NAME + ' was downloaded instead. Attach it to your message so they can import it.'); return;
  }
  try { await navigator.clipboard.writeText(SHARE_TEXT); } catch (e) {}
  downloadBlob(blob, SHARE_NAME);
  alert('Sharing is not available here. The link and instructions were copied to the clipboard, and ' + SHARE_NAME + ' was downloaded. Paste the text into an email and attach the downloaded zip file.');
}
async function exportBackup() {
  const blob = await buildZip(); const name = 'family-tree-backup-' + new Date().toISOString().slice(0, 10) + '.zip';
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

/* ---------- relationship to root ---------- */
function ancDepths(id) {
  const d = new Map([[id, 0]]), q = [id];
  while (q.length) { const x = q.shift(); const p = S.P[x]; if (!p) continue;
    for (const par of p.parents || []) if (!d.has(par) && S.P[par]) { d.set(par, d.get(x) + 1); q.push(par); } }
  return d;
}
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const greats = n => n <= 0 ? '' : n === 1 ? 'great-' : ord(n) + ' great-';
function sx(p, m, f, u) { return p.sex === 'M' ? m : p.sex === 'F' ? f : u; }
function bloodRel(rootId, p) {
  if (p.id === rootId) return 'You';
  const A = ancDepths(rootId), B = ancDepths(p.id);
  let best = null;
  for (const [id, dt] of B) if (A.has(id)) { const dr = A.get(id); if (!best || dr + dt < best[0] + best[1]) best = [dr, dt]; }
  if (!best) return '';
  const [dr, dt] = best;
  if (dt === 0) return dr === 1 ? sx(p, 'father', 'mother', 'parent') : dr === 2 ? sx(p, 'grandfather', 'grandmother', 'grandparent') : greats(dr - 2) + sx(p, 'grandfather', 'grandmother', 'grandparent');
  if (dr === 0) return dt === 1 ? sx(p, 'son', 'daughter', 'child') : dt === 2 ? sx(p, 'grandson', 'granddaughter', 'grandchild') : greats(dt - 2) + sx(p, 'grandson', 'granddaughter', 'grandchild');
  if (dr === 1 && dt === 1) return sx(p, 'brother', 'sister', 'sibling');
  if (dr === 1) return (dt === 2 ? '' : dt === 3 ? 'grand-' : greats(dt - 3) + 'grand-') + sx(p, 'nephew', 'niece', 'niece/nephew');
  if (dt === 1) return (dr === 2 ? '' : dr === 3 ? 'great-' : greats(dr - 2)) + sx(p, 'uncle', 'aunt', 'aunt/uncle');
  const deg = Math.min(dr, dt) - 1, rem = Math.abs(dr - dt);
  return ord(deg) + ' cousin' + (rem ? ' ' + (rem === 1 ? 'once' : rem === 2 ? 'twice' : rem + ' times') + ' removed' : '');
}
function relLabel(p) {
  const root = S.data.rootPersonId; const r = bloodRel(root, p);
  if (r === 'You') return 'You';
  if (r) return 'Your ' + r;
  for (const s of p.spouses || []) { const q = S.P[s.id]; if (!q) continue; const r2 = bloodRel(root, q);
    if (r2) return r2 === 'You' ? 'Your ' + sx(p, 'husband', 'wife', 'spouse') : `Spouse of your ${r2}`; }
  return '';
}
function lineOf(id) {
  const root = S.P[S.data.rootPersonId]; if (!root) return '';
  if (!S._lines) { S._lines = {}; const f = father(root), m = mother(root);
    if (f) for (const k of ancDepths(f.id).keys()) S._lines[k] = 'pat';
    if (m) for (const k of ancDepths(m.id).keys()) if (!S._lines[k]) S._lines[k] = 'mat'; }
  return S._lines[id] || '';
}

/* ---------- Tree (person-centred) ---------- */
S.trail = []; S.trailPos = -1; S.showSibs = false;
function tcard(p, role, linkConf) {
  if (!p) return '';
  const hid = hidden(p);
  const ph = !hid && (p.photos || []).find(f => S.imgKeys.has(f));
  const lc = linkConf && linkConf !== 'VERIFIED' ? `<span class="lnk">link ${sbadge(linkConf)}</span>` : '';
  return `<div class="tc ${esc(p.sex)} ${lineOf(p.id)} tc-${role}" data-id="${esc(p.id)}" role="button" tabindex="0">
    <span class="tav" ${ph ? `data-img="${esc(ph)}"` : ''}>${esc(initials(p))}</span>
    <span class="tct"><b>${esc(p.name)}</b><span class="yr">${esc(years(p))}</span>${sbadge(p.status)}${lc}</span>
    <button class="tinfo" data-info="${esc(p.id)}" aria-label="Open details for ${esc(p.name)}">i</button></div>`;
}
V.tree = id => {
  const p = S.P[id] || S.P[S.data.rootPersonId]; if (!p) return notFound();
  if (S.trail[S.trailPos] !== p.id) { S.trail = S.trail.slice(0, S.trailPos + 1); S.trail.push(p.id); if (S.trail.length > 30) S.trail.shift(); S.trailPos = S.trail.length - 1; }
  setTitle('Family Tree');
  const f = father(p), m = mother(p);
  const keep = q => { const f = S.settings.treeFilter || 'all'; if (f === 'all') return true; const r = ST_ORDER.indexOf(q.status || 'TREE ONLY'); return f === 'ver' ? r === 0 : r <= 1; };
  let nHidden = 0; const flt = arr => { const o = arr.filter(keep); nHidden += arr.length - o.length; return o; };
  const pars = flt(parentsOf(p));
  const sps = flt((p.spouses || []).map(s => S.P[s.id]).filter(Boolean));
  const kids = flt(childrenOf(p)), sibs = flt(siblingsOf(p));
  const rl = relLabel(p);
  const trail = S.trail.map((t, i) => S.P[t] ? `<button class="crumb ${i === S.trailPos ? 'on' : ''}" data-crumb="${i}">${esc(S.P[t].name.replace(/\s*\(.*?\)\s*/g, ' ').split(' ').filter(Boolean).slice(0, 2).join(' '))}</button>` : '').join('<span class="sep">›</span>');
  return `<div class="tsearch"><input type="search" id="tq" placeholder="Jump to a person…" autocomplete="off" enterkeyhint="search"><div id="tqr"></div></div>
  <div class="crumbs" id="crumbs">${trail}</div>
  <div class="tfilter"><div class="seg">${[['all', 'All'], ['sup', '✓ ◐ Supported+'], ['ver', '✓ Verified only']].map(([k, l]) => `<button data-tf="${k}" class="${(S.settings.treeFilter || 'all') === k ? 'on' : ''}">${l}</button>`).join('')}</div><button class="qbtn" data-act="legend" aria-label="Legend">?</button></div>
  ${nHidden ? `<div class="small muted" style="margin-bottom:6px">${nHidden} relative${nHidden > 1 ? 's' : ''} hidden by the filter.</div>` : ''}
  <div class="tstage" id="tstage">
    <svg id="tlines" aria-hidden="true"></svg>
    <div class="trow trow-par">${pars.length ? pars.map(q => tcard(q, 'par', p.parentStatus)).join('') : `<div class="tc tc-empty">${parentsOf(p).length ? 'Parents hidden by filter' : 'Parents not recorded'}</div>`}</div>
    <div class="trow trow-focus">
      <div class="tfocuswrap">${tcard(p, 'focus', null)}<div class="trel">${esc(rl)}${p.parentStatus && pars.length ? `<div class="small">Parent link: ${sbadge(p.parentStatus)}</div>` : ''}</div></div>
      ${sps.length ? `<div class="tsps"><div class="tlabel">Spouse${sps.length > 1 ? 's' : ''}</div>${sps.map(q => tcard(q, 'sp')).join('')}</div>` : ''}
    </div>
    ${S.showSibs ? `<div class="tlabel tkl" style="margin-top:14px">${sibs.length ? `Brothers &amp; sisters (${sibs.length})` : 'No brothers or sisters recorded'}</div><div class="trow trow-kids trow-sibs">${sibs.map(q => tcard(q, 'sib')).join('')}</div>` : ''}
    <div class="tlabel tkl">${kids.length ? `Children (${kids.length})${kids.length > 2 ? ' — swipe ›' : ''}` : 'No children recorded'}</div>
    <div class="trow trow-kids" id="tkids">${kids.map(q => tcard(q, 'kid')).join('')}</div>
  </div>
  <label class="sibtoggle"><input type="checkbox" id="sibT" ${S.showSibs ? 'checked' : ''}> Show brothers &amp; sisters (${sibs.length})</label>
  <div class="tbar">
    <button data-tnav="back" ${S.trailPos > 0 ? '' : 'disabled'} aria-label="Back">‹<small>Back</small></button>
    <button data-tnav="fwd" ${S.trailPos < S.trail.length - 1 ? '' : 'disabled'} aria-label="Forward">›<small>Fwd</small></button>
    <button data-tnav="up-f" ${f ? '' : 'disabled'}>↑<small>Father</small></button>
    <button data-tnav="up-m" ${m ? '' : 'disabled'}>↑<small>Mother</small></button>
    <button data-tnav="home">⌂<small>${esc(((S.P[S.data.rootPersonId] || {}).name || 'Home').split(' ')[0])}</small></button>
  </div>`;
};
function goTree(id, anim) { S.treeAnim = anim || 'fade'; location.hash = '#/tree/' + encodeURIComponent(id); }
function drawLines() {
  const st = $('#tstage'), svg = $('#tlines'); if (!st || !svg) return;
  const R = st.getBoundingClientRect(); svg.setAttribute('width', R.width); svg.setAttribute('height', st.scrollHeight);
  const foc = st.querySelector('.tc-focus'); if (!foc) return;
  const box = el => { const r = el.getBoundingClientRect(); return {x: r.left - R.left + r.width / 2, t: r.top - R.top, b: r.bottom - R.top, l: r.left - R.left, r: r.right - R.left, m: r.top - R.top + r.height / 2}; };
  const F = box(foc); let d = '';
  const pars = [...st.querySelectorAll('.tc-par')].map(box);
  if (pars.length) { const y = (pars[0].b + F.t) / 2; d += `M${F.x},${F.t}V${y}`; for (const P2 of pars) d += `M${P2.x},${P2.b}V${y}`; d += `M${Math.min(F.x, ...pars.map(q => q.x))},${y}H${Math.max(F.x, ...pars.map(q => q.x))}`; }
  const kids = [...st.querySelectorAll('.tc-kid')].map(box).filter(k => k.r > 0 && k.l < R.width);
  if (kids.length) { const y = (F.b + kids[0].t) / 2 + 6; d += `M${F.x},${F.b}V${y}`; for (const K of kids) d += `M${K.x},${y}V${K.t}`; d += `M${Math.max(0, Math.min(F.x, ...kids.map(k => k.x)))},${y}H${Math.min(R.width, Math.max(F.x, ...kids.map(k => k.x)))}`; }
  for (const s of st.querySelectorAll('.tc-sp')) { const Sb = box(s); d += `M${F.r},${F.m}H${Sb.l}`; }
  svg.innerHTML = `<path d="${d}" fill="none" stroke="#b9a68e" stroke-width="2.5" stroke-linecap="round"/>`;
}
V.tree.after = () => {
  const st = $('#tstage');
  st.classList.add('anim-' + (S.treeAnim || 'fade')); S.treeAnim = null;
  requestAnimationFrame(() => requestAnimationFrame(() => st.classList.add('in')));
  setTimeout(drawLines, 30); setTimeout(drawLines, 400);
  $('#tkids').addEventListener('scroll', () => requestAnimationFrame(drawLines), {passive: true});
  window.onresize = drawLines;
  const c = $('#crumbs'); c.scrollLeft = c.scrollWidth;
  let lp = null, lpFired = false;
  st.addEventListener('pointerdown', e => { const card = e.target.closest('.tc[data-id]'); if (!card || e.target.closest('.tinfo')) return;
    lpFired = false; lp = setTimeout(() => { lpFired = true; if (navigator.vibrate) navigator.vibrate(15); location.hash = '#/person/' + encodeURIComponent(card.dataset.id); }, 550); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => st.addEventListener(t, () => clearTimeout(lp)));
  st.addEventListener('scroll', () => clearTimeout(lp), true);
  st.addEventListener('contextmenu', e => e.preventDefault());
  st.addEventListener('click', e => {
    const info = e.target.closest('.tinfo'); if (info) { e.stopPropagation(); location.hash = '#/person/' + encodeURIComponent(info.dataset.info); return; }
    const card = e.target.closest('.tc[data-id]'); if (!card || lpFired) return;
    const role = [...card.classList].find(k => k.startsWith('tc-'));
    if (role === 'tc-focus') { location.hash = '#/person/' + encodeURIComponent(card.dataset.id); return; }
    card.classList.add('tapped');
    setTimeout(() => goTree(card.dataset.id, role === 'tc-par' ? 'down' : role === 'tc-kid' ? 'up' : 'side'), 120);
  });
  c.onclick = e => { const b = e.target.closest('[data-crumb]'); if (!b) return; S.trailPos = +b.dataset.crumb; goTree(S.trail[S.trailPos], 'fade'); };
  document.querySelector('.tbar').onclick = e => {
    const b = e.target.closest('[data-tnav]'); if (!b || b.disabled) return; const p = S.P[S.trail[S.trailPos]];
    const a = b.dataset.tnav;
    if (a === 'back') { S.trailPos--; goTree(S.trail[S.trailPos], 'side'); }
    if (a === 'fwd') { S.trailPos++; goTree(S.trail[S.trailPos], 'side'); }
    if (a === 'up-f' && father(p)) goTree(father(p).id, 'down');
    if (a === 'up-m' && mother(p)) goTree(mother(p).id, 'down');
    if (a === 'home') goTree(S.data.rootPersonId, 'fade');
  };
  document.querySelector('.tfilter .seg').onclick = async e => { const b = e.target.closest('[data-tf]'); if (!b) return; S.settings.treeFilter = b.dataset.tf; await DB.put('kv', 'settings', S.settings); S.noScroll = true; await route(); S.noScroll = false; };
  $('#sibT').onchange = e => { S.showSibs = e.target.checked; S.noScroll = true; route().then(() => S.noScroll = false); };
  const q = $('#tq'), out = $('#tqr'); let t;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    const v = q.value.trim().toLowerCase(); if (v.length < 2) { out.innerHTML = ''; return; }
    const terms = v.split(/\s+/);
    const hits = S.data.people.filter(p => { const s = [p.name, p.maiden, p.nickname, ...(p.altNames || [])].join(' ').toLowerCase(); return terms.every(x => s.includes(x)); })
      .sort((a, b) => (b.curated ? 1 : 0) - (a.curated ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 8);
    out.innerHTML = hits.map(p => `<button class="tqhit" data-jump="${esc(p.id)}"><b>${esc(p.name)}</b> <span class="muted small">${esc(years(p))}</span></button>`).join('') || '<div class="muted small" style="padding:8px">No match</div>';
  }, 150); };
  out.onclick = e => { const b = e.target.closest('[data-jump]'); if (b) goTree(b.dataset.jump, 'fade'); };
};

/* ---------- zoomable pedigree ---------- */
S.pedZoom = 1;
V.pedigree = id => {
  const root = S.P[id] || S.P[S.data.rootPersonId];
  setTitle('Pedigree');
  const G = 5; const gens = [[root]];
  for (let g = 1; g < G; g++) gens.push(gens[g - 1].flatMap(p => p ? [father(p), mother(p)] : [null, null]));
  const box = (p, g, i) => {
    if (!p) return `<div class="slot"><span class="pbox empty">${g ? (i % 2 ? 'Mother' : 'Father') + ' unknown' : ''}</span></div>`;
    const kid = g > 0 ? gens[g - 1][i >> 1] : null;
    const lc = sbadge(p.status);
    return `<div class="slot"><a class="pbox ${esc(p.sex)} ${lineOf(p.id)} ${g ? '' : 'root'}" href="#/pedigree/${encodeURIComponent(p.id)}" data-pid="${esc(p.id)}"><b>${esc(p.name)}</b><span class="yr">${esc(years(p))}</span>${lc ? '<br>' + lc : ''}</a></div>`;
  };
  const H = 2 ** (G - 1) * 76;
  return `<div class="pedctl"><button data-z="-">−</button><button data-z="0">Fit</button><button data-z="+">+</button>
    <a class="chip" href="#/tree/${encodeURIComponent(root.id)}">Open in Tree</a><button class="qbtn" data-act="legend" aria-label="Legend">?</button></div>
  <div class="pedwrap" id="pedwrap"><div class="pedzoom" id="pedzoom"><div class="ped" id="ped" style="height:${H}px">
  ${gens.map((col, g) => `<div class="gen">${col.map((p, i) => box(p, g, i)).join('')}</div>`).join('')}
  </div></div></div>
  <p class="muted small">Pinch or use − / + to zoom; drag to move. Tap anyone to put them at the left. Badges show how well each person is verified (tap ? for the key). Blue edge = father's line, rose = mother's line.</p>`;
};
V.pedigree.after = () => {
  const wrap = $('#pedwrap'), z = $('#pedzoom'), ped = $('#ped');
  const W = ped.scrollWidth, H = ped.scrollHeight;
  const set = (s, cx, cy) => {
    s = Math.max(0.3, Math.min(2, s)); const old = S.pedZoom;
    cx = cx == null ? wrap.clientWidth / 2 : cx; cy = cy == null ? wrap.clientHeight / 2 : cy;
    const ax = (wrap.scrollLeft + cx) / old, ay = (wrap.scrollTop + cy) / old;
    S.pedZoom = s; ped.style.transform = `scale(${s})`; z.style.width = W * s + 'px'; z.style.height = H * s + 'px';
    wrap.scrollLeft = ax * s - cx; wrap.scrollTop = ay * s - cy;
  };
  const fit = () => set(Math.min(wrap.clientWidth / W, wrap.clientHeight / H));
  set(S.pedZoom === 1 && !S.pedVisited ? Math.min(1, wrap.clientWidth / W, wrap.clientHeight / H) : S.pedZoom); S.pedVisited = true;
  document.querySelector('.pedctl').onclick = e => { const b = e.target.closest('[data-z]'); if (!b) return;
    b.dataset.z === '0' ? fit() : set(S.pedZoom * (b.dataset.z === '+' ? 1.25 : 0.8)); };
  let p0 = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  wrap.addEventListener('touchstart', e => { if (e.touches.length === 2) { const r = wrap.getBoundingClientRect(); p0 = {d: dist(e.touches), s: S.pedZoom, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top}; } }, {passive: true});
  wrap.addEventListener('touchmove', e => { if (p0 && e.touches.length === 2) { e.preventDefault(); set(p0.s * dist(e.touches) / p0.d, p0.cx, p0.cy); } }, {passive: false});
  wrap.addEventListener('touchend', e => { if (e.touches.length < 2) p0 = null; });
  wrap.addEventListener('gesturestart', e => e.preventDefault());
  wrap.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); const r = wrap.getBoundingClientRect(); set(S.pedZoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - r.left, e.clientY - r.top); } }, {passive: false});
};

function distances() {
  if (S._dist) return S._dist; const d = new Map([[S.data.rootPersonId, 0]]), q = [S.data.rootPersonId];
  while (q.length) { const x = q.shift(), p = S.P[x]; if (!p) continue;
    for (const n of [...(p.parents || []), ...(p.children || []), ...(p.spouses || []).map(s => s.id)]) if (!d.has(n) && S.P[n]) { d.set(n, d.get(x) + 1); q.push(n); } }
  return (S._dist = d);
}
function needsProof() {
  const d = distances();
  const list = S.data.people.filter(p => p.status === 'SUPPORTED' || p.status === 'LEAD').sort((a, b) => (d.get(a.id) ?? 99) - (d.get(b.id) ?? 99) || a.name.localeCompare(b.name));
  return list.map(p => `<a class="card nprow" href="#/person/${encodeURIComponent(p.id)}"><div><b>${esc(p.name)}</b> ${sbadge(p.status)}</div><div class="small muted">${esc(relLabel(p) || '')}${p.parentStatus && p.parentStatus !== 'VERIFIED' ? ' · parent link ' + p.parentStatus.toLowerCase() : ''}</div>${p.nextStep ? `<div class="small"><b>What would prove it:</b> ${esc(p.nextStep)}</div>` : ''}</a>`).join('') || '<p class="muted">Nothing here.</p>';
}
function srcList(ids) {
  const out = (ids || []).map(i => S.src[i]).filter(Boolean).map(s => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)} <span class="muted small">(${s.kind === 'record' ? 'record' : s.kind === 'index' ? 'index' : 'tree / family'})</span></li>`);
  return out.length ? `<ul class="whysrc">${out.join('')}</ul>` : '<div class="small muted">No source cited.</div>';
}
function whyHTML(p) {
  if (hidden(p)) return '';
  const rows = [];
  if ((p.parents || []).length) {
    const names = parentsOf(p).map(q => esc(q.name)).join(' &amp; ');
    const ids = [...new Set((p.events || []).filter(e => e.type === 'Birth' || e.type === 'Census').flatMap(e => e.sourceIds || []))];
    rows.push(`<div class="whyrow"><div>${sbadge(p.parentStatus)} <b>Parents:</b> ${names}</div>${p.parentStatus === 'TREE ONLY' ? '<div class="small muted">This parent link comes from the Ancestry tree only.</div>' : `<div class="small muted">${p.parentStatus === 'VERIFIED' ? 'Named as parents in original records (see the facts below).' : p.parentStatus === 'SUPPORTED' ? 'One record or strong indirect evidence names these parents. See the facts and notes below.' : 'A working hypothesis. See the possible parents and the next step above.'}</div>`}</div>`);
  }
  for (const c of p.candidateParents || []) rows.push(`<div class="whyrow"><div>${sbadge(c.confidence === 'LIKELY' || c.confidence === 'POSSIBLE' ? 'LEAD' : c.confidence === 'UNPROVEN' ? 'TREE ONLY' : 'SUPPORTED')} <b>Possible parents:</b> ${c.ids.map(i => S.P[i]).filter(Boolean).map(q => esc(q.name)).join(' &amp; ')} <span class="small muted">(${esc(c.confidence)})</span></div><div class="small">${esc(c.note)}</div></div>`);
  for (const e of p.events || []) rows.push(`<div class="whyrow"><div>${sbadge(e.status)} <b>${esc(e.type)}:</b> ${esc([e.date, e.place].filter(Boolean).join(', ') || '—')}</div>${srcList(e.sourceIds)}</div>`);
  const next = p.nextStep && p.status !== 'VERIFIED' ? `<div class="card nextstep"><b>What would prove it:</b> ${esc(p.nextStep)}</div>` : '';
  return `<h2>Why we think so <button class="qbtn" data-act="legend" aria-label="Legend">?</button></h2>
  <div class="card"><div>${sbadge(p.status)} <b>Overall.</b> <span class="small">${p.status !== 'VERIFIED' && p.recordCount >= 2 ? `Identity is backed by ${p.recordCount} independent records, but the parent link is only ${esc((p.parentStatus || 'not recorded').toLowerCase())}, so this person is not yet fully verified.` : esc(STATUS[p.status || 'TREE ONLY'].h) + (p.recordCount ? ` ${p.recordCount} independent record${p.recordCount > 1 ? 's' : ''} reviewed.` : '')}</span></div></div>${next}
  <div class="card">${rows.join('')}</div>`;
}
function showLegend() {
  let el = $('#legend'); if (!el) { el = document.createElement('div'); el.id = 'legend'; document.body.appendChild(el); el.onclick = e => { if (e.target === el || e.target.closest('[data-close]')) el.hidden = true; }; }
  el.innerHTML = `<div class="legbox" role="dialog" aria-label="Verification legend"><h2 style="margin-top:0">What the labels mean</h2>
  ${ST_ORDER.map(k => `<div class="legrow">${sbadge(k)}<div class="small">${esc(STATUS[k].h)}</div></div>`).join('')}
  <p class="small muted">Each person also has a status for each fact and for the link to their parents. Open a person and see “Why we think so”. Card edges: blue = father's side, rose = mother's side.</p>
  <button class="btn" data-close>Close</button></div>`;
  el.hidden = false;
}

/* ---------- router ---------- */
function notFound() { setTitle('Not found'); return '<p>That person was not found. <a href="#/home">Go home</a></p>'; }
async function route() {
  closeViewer();
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, '')); const [name, ...rest] = h.split('/'); const arg = rest.join('/');
  let v = name || 'tree';
  if (!S.data && v !== 'settings') v = 'welcome';
  if (!V[v]) v = 'home';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === v));
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
  if (a === 'legend') { e.preventDefault(); showLegend(); }
  if (a === 'share') shareTree().catch(err => alert('Share failed: ' + err.message));
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
    location.hash = '#/tree'; route();
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

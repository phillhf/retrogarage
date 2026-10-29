// Cover und Titel erkennen: ordnet ROM-Namen den Namen des libretro-Thumbnail-Servers zu (No-Intro-Namen,
// dieselbe Quelle wie RetroArch), lädt das Cover einmalig herunter und merkt sich den sauberen Titel.
// Läuft im Hintergrund – die Bibliothek wartet nie darauf. Kein API-Schlüssel nötig.

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://thumbnails.libretro.com/';
const LIBRETRO_SYSTEMS = {
  gb: 'Nintendo - Game Boy',
  gbc: 'Nintendo - Game Boy Color',
  gba: 'Nintendo - Game Boy Advance',
  nes: 'Nintendo - Nintendo Entertainment System',
  snes: 'Nintendo - Super Nintendo Entertainment System',
  n64: 'Nintendo - Nintendo 64',
  nds: 'Nintendo - Nintendo DS',
};
const INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // Namensliste je Konsole monatlich erneuern
const RETRY_MISSING_MS = 7 * 24 * 60 * 60 * 1000;    // nicht gefundene Spiele wöchentlich erneut versuchen
const MIN_SCORE = 0.75;                               // Mindest-Ähnlichkeit für unscharfe Treffer

// Bevorzugte Regionen, wenn ein Titel in mehreren Fassungen vorliegt
const REGION_ORDER = ['Germany', 'Europe', 'World', 'USA', 'UK', 'Australia', 'France', 'Italy', 'Spain', 'Japan'];
// Kürzel in frei benannten Dateien (z. B. "pokemon-heartgold-de")
const REGION_HINTS = {
  de: 'Germany', ger: 'Germany', german: 'Germany', deutsch: 'Germany', eu: 'Europe', eur: 'Europe',
  europe: 'Europe', us: 'USA', usa: 'USA', jp: 'Japan', jap: 'Japan', japan: 'Japan', fr: 'France',
  es: 'Spain', it: 'Italy', uk: 'UK',
};
// Fassungen, die nur notfalls genommen werden
const UNWANTED_TAGS = /\b(beta|proto|demo|sample|kiosk|pirate|unl|hack|aftermarket|virtual console|switch online)\b/i;

// ------------------------------------------------------------------ Namen
// Name so umformen, wie libretro Dateinamen bildet; führende Release-Nummern ("4827 - …") entfernen
function libretroName(name) {
  return name.replace(/\.[a-z0-9]{1,4}$/i, '').replace(/^\d{1,5}\s*-\s*/, '').replace(/[&*/:`<>?\\|"]/g, '_').trim();
}

function stripTags(name) {
  return name.replace(/\s*[\[(][^\])]*[\])]/g, '').trim();
}

function tagsOf(name) {
  return (name.match(/\(([^)]*)\)/g) || []).flatMap((t) => t.slice(1, -1).split(',').map((s) => s.trim()));
}

function tokens(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && w !== 'the');
}

// "Legend of Zelda, The - A Link to the Past" -> "The Legend of Zelda - A Link to the Past"
function displayTitle(name) {
  const title = stripTags(name).replace(/_/g, ' ');
  const m = /^(.+?), (The|A|An|Die|Der|Das|Le|La|Les|El|Il)( - .*)?$/.exec(title);
  return m ? `${m[2]} ${m[1]}${m[3] || ''}` : title;
}

function regionRank(tags, wanted) {
  if (tags.some((t) => wanted.includes(t))) return -1;
  const ranks = tags.map((t) => REGION_ORDER.indexOf(t)).filter((i) => i >= 0);
  return ranks.length ? Math.min(...ranks) : REGION_ORDER.length;
}

// Ranglisten-Vergleich: erstes unterschiedliches Kriterium entscheidet, kleiner ist besser
function isBetter(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// Bester Eintrag der libretro-Liste für einen ROM-Namen, oder null
function findMatch(romName, names, nameSet) {
  const wanted = libretroName(romName);
  if (nameSet.has(wanted)) return wanted;

  // Nur Regionsangaben übernehmen, keine Revisionen oder Sprachen
  const wantedRegions = tagsOf(wanted).filter((t) => REGION_ORDER.includes(t) || /^(Korea|China|Asia|Brazil|Canada|Netherlands|Sweden)$/.test(t));
  let query = tokens(stripTags(wanted));
  while (query.length > 1 && REGION_HINTS[query[query.length - 1]]) {
    wantedRegions.push(REGION_HINTS[query.pop()]);
  }
  if (!query.length) return null;
  const q = new Set(query);
  const qKey = query.join(' ');

  let best = null;
  for (const name of names) {
    const t = tokens(stripTags(name));
    let score;
    if (t.join(' ') === qKey) {
      score = 1;
    } else {
      let common = 0;
      for (const w of new Set(t)) if (q.has(w)) common++;
      score = (2 * common) / (q.size + new Set(t).size);
      if (score < MIN_SCORE) continue;
    }
    const tags = tagsOf(name);
    const rank = [
      -score,
      UNWANTED_TAGS.test(tags.join(' ')) ? 1 : 0,
      regionRank(tags, wantedRegions),
      tags.some((x) => /^Rev /.test(x)) ? 0 : 1,   // neueste Revision bevorzugen
      name.length,
    ];
    if (!best || isBetter(rank, best.rank)) best = { name, rank };
  }
  return best ? best.name : null;
}

// --------------------------------------------------------------- Dienst
function createCoverService({ dir, enabled = true }) {
  const metaFile = path.join(dir, 'titel.json');
  const indexDir = path.join(dir, '.index');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* noch leer */ }
  const indexes = new Map();     // System -> { names, set } bzw. Promise
  const queue = [];
  const queued = new Set();
  let working = false;
  let saveTimer = null;

  function saveMeta() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${metaFile}.tmp`, JSON.stringify(meta, null, 1));
        fs.renameSync(`${metaFile}.tmp`, metaFile);
      } catch (err) { console.error(`Cover-Liste konnte nicht gespeichert werden: ${err.message}`); }
    }, 1000);
  }

  const key = (folder, file) => `${folder}/${file}`;
  const coverPath = (folder, file) => path.join(dir, folder, `${file}.png`);

  async function loadIndex(system) {
    if (indexes.has(system)) return indexes.get(system);
    const promise = (async () => {
      const file = path.join(indexDir, `${system}.json`);
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Date.now() - cached.fetched < INDEX_MAX_AGE_MS) return cached.names;
      } catch { /* nicht vorhanden */ }
      const url = `${BASE_URL}${encodeURIComponent(LIBRETRO_SYSTEMS[system])}/Named_Boxarts/`;
      const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'RetroGarage' } });
      if (!res.ok) throw new Error(`Cover-Liste ${system}: HTTP ${res.status}`);
      const html = await res.text();
      const names = [...html.matchAll(/href="([^"?/]+)\.png"/g)].map((m) => decodeURIComponent(m[1]));
      if (!names.length) throw new Error(`Cover-Liste ${system} ist leer`);
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetched: Date.now(), names }));
      return names;
    })().then((names) => ({ names, set: new Set(names) }));
    indexes.set(system, promise);
    promise.catch(() => indexes.delete(system));   // beim nächsten Mal erneut versuchen
    return promise;
  }

  async function download(url, target) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'RetroGarage' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, data);
    fs.renameSync(`${target}.tmp`, target);
  }

  async function processItem({ folder, file, system, romName }) {
    const k = key(folder, file);
    let index;
    try { index = await loadIndex(system); } catch (err) {
      console.error(`Cover: ${err.message}`);
      return;   // Netzwerkproblem – ohne Eintrag, also beim nächsten Durchlauf erneut
    }
    const match = findMatch(romName, index.names, index.set);
    const entry = { name: romName, match, title: match ? displayTitle(match) : null, cover: false, checked: Date.now() };
    if (match) {
      const url = `${BASE_URL}${encodeURIComponent(LIBRETRO_SYSTEMS[system])}/Named_Boxarts/${encodeURIComponent(match)}.png`;
      try {
        await download(url, coverPath(folder, file));
        entry.cover = true;
      } catch (err) {
        console.error(`Cover für ${file} konnte nicht geladen werden: ${err.message}`);
        return;
      }
    }
    meta[k] = entry;
    saveMeta();
  }

  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        try { await processItem(item); } catch (err) { console.error(`Cover: ${err.message}`); }
        queued.delete(key(item.folder, item.file));
      }
    } finally {
      working = false;
    }
  }

  return {
    // Gespeicherte Erkennung für ein Spiel (Titel und Cover-Adresse), sonst null
    info(folder, file) {
      const entry = meta[key(folder, file)];
      if (!entry || !entry.match) return null;
      let version = 0;
      try { version = Math.round(fs.statSync(coverPath(folder, file)).mtimeMs); } catch { /* kein Cover */ }
      return {
        title: entry.title,
        cover: version ? `/covers/${encodeURIComponent(folder)}/${encodeURIComponent(file)}.png?v=${version}` : null,
      };
    },
    // Spiele ohne (aktuelle) Erkennung zur Bearbeitung vormerken
    request(folder, file, system, romName) {
      if (!enabled || !LIBRETRO_SYSTEMS[system]) return;
      const k = key(folder, file);
      const entry = meta[k];
      const fresh = entry && entry.name === romName &&
        (entry.match ? entry.cover : Date.now() - entry.checked < RETRY_MISSING_MS);
      if (fresh || queued.has(k)) return;
      queued.add(k);
      queue.push({ folder, file, system, romName });
      work();
    },
    busy() { return working || queue.length > 0; },
    coverFile(folder, file) { return coverPath(folder, file); },
  };
}

module.exports = { createCoverService, findMatch, displayTitle, libretroName };

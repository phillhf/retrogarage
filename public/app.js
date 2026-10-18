// Spielebibliothek: lädt die ROM-Liste vom Server und zeigt sie als große Touch-Kacheln an.

const SHORT = { gb: 'GB', gbc: 'GBC', gba: 'GBA', nes: 'NES', snes: 'SNES', n64: 'N64', nds: 'DS' };
const RECENT_KEY = 'retro-recent';

let library = {};
let current = loadPref('retro-system') || 'all';

function loadPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* privater Modus */ }
}
function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

function allGames() {
  return Object.entries(library).flatMap(([id, sys]) =>
    sys.games.map((g) => ({ ...g, system: id, systemName: sys.name })));
}

function card(game) {
  const a = document.createElement('a');
  a.className = 'game';
  // system = Ablageordner (ROM-Adresse, Spielstände), as = erkanntes System (Emulator)
  a.href = `play.html?system=${encodeURIComponent(game.folder)}&rom=${encodeURIComponent(game.file)}`
    + `&as=${encodeURIComponent(game.system)}`;
  const cover = document.createElement('div');
  cover.className = 'cover';
  if (game.cover) {
    const img = document.createElement('img');
    img.src = game.cover;
    img.alt = '';
    img.loading = 'lazy';
    cover.append(img);
  } else {
    cover.textContent = SHORT[game.system] || game.system.toUpperCase();
  }
  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = game.title;
  const sys = document.createElement('div');
  sys.className = 'sys';
  sys.textContent = game.systemName + (game.saved ? ' · ☁ Spielstand' : '');
  info.append(title, sys);
  a.append(cover, info);
  return a;
}

function renderSystems() {
  const nav = document.getElementById('systems');
  nav.innerHTML = '';
  const entries = [['all', 'Alle', allGames().length],
    ...Object.entries(library).map(([id, s]) => [id, SHORT[id] || s.name, s.games.length])];
  for (const [id, label, count] of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = id === current ? 'active' : '';
    b.innerHTML = `${label}<span class="count">${count}</span>`;
    b.onclick = () => { current = id; savePref('retro-system', id); renderSystems(); renderGames(); };
    nav.append(b);
  }
}

function renderGames() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const all = allGames();
  const games = all.filter((g) =>
    (current === 'all' || g.system === current) && (!q || g.title.toLowerCase().includes(q)));

  document.getElementById('list-title').textContent =
    current === 'all' ? 'Alle Spiele' : library[current]?.name || 'Spiele';
  const grid = document.getElementById('games');
  grid.replaceChildren(...games.map(card));

  const empty = document.getElementById('empty');
  empty.hidden = games.length > 0;
  if (!games.length) {
    empty.innerHTML = all.length
      ? 'Keine Treffer.'
      : 'Noch keine ROMs gefunden. Lege deine Spiele auf dem Server in die Ordner ' +
        '<code>roms/gb</code>, <code>roms/gbc</code>, <code>roms/gba</code>, <code>roms/nes</code>, ' +
        '<code>roms/snes</code>, <code>roms/n64</code> oder <code>roms/nds</code> und lade die Seite neu.';
  }

  // "Zuletzt gespielt" nur ohne Suche/Filter, und nur Spiele, die noch existieren
  const known = new Map(all.map((g) => [g.folder + '/' + g.file, g]));
  const rec = recent().map((r) => known.get(r.system + '/' + r.file)).filter(Boolean)
    .filter((g) => current === 'all' || g.system === current);
  document.getElementById('recent-wrap').hidden = !!q || rec.length === 0;
  document.getElementById('recent').replaceChildren(...rec.map(card));
}

async function init() {
  if (current !== 'all' && !Object.keys(SHORT).includes(current)) current = 'all';
  try {
    const res = await fetch('/api/roms');
    library = await res.json();
  } catch {
    document.getElementById('empty').hidden = false;
    document.getElementById('empty').textContent = 'Server nicht erreichbar.';
    return;
  }
  renderSystems();
  renderGames();
  document.getElementById('search').addEventListener('input', renderGames);
}

init();

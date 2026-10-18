// Spielseite: startet EmulatorJS und hält die Spielstände auf dem Server synchron.
//
// Der Server ist die einzige Quelle für Spielstände – der Browser im Auto speichert nichts dauerhaft.
// - Spielinterner Speicher (SRAM, z. B. "Speichern" im Pokémon-Menü): wird beim Start vom Server geladen
//   und danach alle paar Sekunden bei Änderungen hochgeladen.
// - Speicherstände (Menü "Save State"/"Load State"): gehen direkt auf den Server bzw. kommen von dort.
// Bricht die Verbindung ab, bleibt der letzte ungesicherte SRAM-Stand bis zum nächsten Upload als Notkopie
// im Browser und wird beim nächsten Spielstart nachgereicht.

const params = new URLSearchParams(location.search);
const system = params.get('system');
const rom = params.get('rom');
const CORES = { gb: 'gb', gbc: 'gb', gba: 'gba', nes: 'nes', snes: 'snes', n64: 'n64', nds: 'nds' };
// system = Ablageordner (ROM-Adresse, Spielstände); as = vom Server erkanntes System (bestimmt den Emulator)
const coreSystem = CORES[params.get('as')] ? params.get('as') : system;
// Optional bestimmter Emulator-Kern, z. B. &core=desmume2015 (zum Ausprobieren, falls ein Spiel ruckelt)
const CORE_CHOICES = { nds: ['melonds', 'desmume', 'desmume2015'], n64: ['mupen64plus_next', 'parallel_n64'],
  snes: ['snes9x'], nes: ['fceumm', 'nestopia'], gba: ['mgba'], gb: ['gambatte'], gbc: ['gambatte'] };
const coreOverride = (CORE_CHOICES[coreSystem] || []).includes(params.get('core')) ? params.get('core') : null;
const SYNC_INTERVAL_MS = 10000;
// Tonpuffer in Millisekunden. EmulatorJS nimmt 64 ms – zu knapp für schwächere Geräte wie den Auto-Browser,
// der Ton knackt/ruckelt dann. Mehr Puffer = ruhiger Ton bei kaum merklich späterem Klang.
const AUDIO_LATENCY_MS = 128;
const PENDING_KEY = `retro-pending:${system}/${rom}`;
const title = (rom || '').replace(/\.[^.]+$/, '');

const $ = (id) => document.getElementById(id);
let wakeLock = null;
let startSram = null;     // beim Start vom Server geladener (oder nachgereichter) SRAM
let lastSynced = null;    // Stand, der sicher auf dem Server liegt
let syncing = null;       // laufender Upload (Promise)

// ------------------------------------------------------------------ Server
const saveUrl = (kind) =>
  `/api/saves/${encodeURIComponent(system)}/${encodeURIComponent(rom)}/${kind}`;

async function fetchSave(kind) {
  const res = await fetch(saveUrl(kind), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server antwortet mit ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function putSave(kind, bytes) {
  const res = await fetch(saveUrl(kind), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Server antwortet mit ${res.status}`);
}

async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

// --------------------------------------------- Notkopie (nur bis zum Upload)
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
function writePending(bytes) {
  try { localStorage.setItem(PENDING_KEY, toBase64(bytes)); } catch { /* Speicher voll/gesperrt */ }
}
function readPending() {
  try { const v = localStorage.getItem(PENDING_KEY); return v ? fromBase64(v) : null; } catch { return null; }
}
function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* egal */ }
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------- Statusanzeige
function setStatus(state) {
  const el = $('sync');
  // Kompakt, damit der Knopf oben rechts klein bleibt; nur ein Problem wird ausgeschrieben
  const text = { ok: '☁', busy: '☁…', error: '☁ nicht gesichert!' }[state];
  el.textContent = text;
  el.className = state;
  $('back').classList.toggle('alert', state === 'error');
}

// --------------------------------------------------------------- Synchron
function emulator() {
  const emu = window.EJS_emulator;
  return emu && emu.started && emu.gameManager ? emu : null;
}

function syncSram() {
  if (syncing) return syncing;
  const emu = emulator();
  if (!emu) return Promise.resolve();
  let bytes;
  try { bytes = emu.gameManager.getSaveFile(); } catch { return Promise.resolve(); }
  if (!bytes || !bytes.length || sameBytes(bytes, lastSynced)) return Promise.resolve();
  const copy = bytes.slice();
  writePending(copy);   // synchron – überlebt auch ein abruptes Schließen
  setStatus('busy');
  syncing = putSave('sram', copy)
    .then(() => { lastSynced = copy; clearPending(); setStatus('ok'); })
    .catch(() => setStatus('error'))
    .finally(() => { syncing = null; });
  return syncing;
}

function writeSramToEmulator(emu, bytes) {
  const gm = emu.gameManager;
  const file = gm.getSaveFilePath();
  let dir = '';
  for (const part of file.split('/').slice(0, -1)) {
    if (!part) continue;
    dir += '/' + part;
    if (!gm.FS.analyzePath(dir).exists) gm.FS.mkdir(dir);
  }
  if (gm.FS.analyzePath(file).exists) gm.FS.unlink(file);
  gm.FS.writeFile(file, bytes);
  gm.loadSaveFiles();
  // Neu starten, damit auch Spiele, die den Speicher nur beim Einschalten lesen, den Stand sehen
  gm.restart();
}

// ------------------------------------------------------------- Controller
// Ist ein Controller verbunden, verschwinden die Bildschirmtasten; wird er getrennt, kommen sie zurück.
// Chrome meldet einen Controller erst, nachdem einmal eine Taste darauf gedrückt wurde.
let controllerConnected = null;

function hasController() {
  try {
    return Array.from(navigator.getGamepads ? navigator.getGamepads() : []).some((g) => g && g.connected);
  } catch { return false; }
}

function updateTouchControls() {
  const emu = window.EJS_emulator;
  if (!emu || typeof emu.toggleVirtualGamepad !== 'function') return;
  const connected = hasController();
  if (connected === controllerConnected) return;   // nur bei Änderung – Einstellung im Menü bleibt bedienbar
  const firstCheck = controllerConnected === null;
  controllerConnected = connected;
  if (connected) {
    emu.toggleVirtualGamepad(false);
    emu.displayMessage('Controller erkannt – Bildschirmtasten ausgeblendet');
  } else if (!firstCheck && emu.getSettingValue('virtual-gamepad') !== 'disabled') {
    emu.toggleVirtualGamepad(true);
    emu.displayMessage('Controller getrennt – Bildschirmtasten eingeblendet');
  }
}

window.addEventListener('gamepadconnected', updateTouchControls);
window.addEventListener('gamepaddisconnected', updateTouchControls);

function onGameStart() {
  // EmulatorJS blendet beim Start seine Menüleiste ein – im Auto stört sie; über ☰ oben rechts erreichbar
  try { window.EJS_emulator.menu.close(); } catch { /* egal */ }
  updateTouchControls();
  setInterval(updateTouchControls, 500);

  const emu = window.EJS_emulator;
  try {
    if (startSram) writeSramToEmulator(emu, startSram);
  } catch (err) {
    console.error('Spielstand konnte nicht in den Emulator geladen werden', err);
    setStatus('error');
  }
  // Ausgangspunkt: nur Änderungen, die ab jetzt im Spiel entstehen, werden hochgeladen.
  // So überschreibt ein frisch gestartetes Spiel niemals einen Stand auf dem Server.
  try { lastSynced = startSram || emu.gameManager.getSaveFile() || null; } catch { lastSynced = startSram; }
  if (lastSynced) lastSynced = lastSynced.slice();
  setInterval(syncSram, SYNC_INTERVAL_MS);
}

async function onSaveState({ state }) {
  const emu = window.EJS_emulator;
  emu.displayMessage('Speichere auf Server…');
  try {
    await withRetry(() => putSave('state', state));
    emu.displayMessage('Spielstand auf dem Server gespeichert');
  } catch {
    emu.displayMessage('FEHLER: Spielstand NICHT gespeichert – Verbindung prüfen');
  }
  syncSram();
}

async function onLoadState() {
  const emu = window.EJS_emulator;
  try {
    const state = await withRetry(() => fetchSave('state'));
    if (!state) return emu.displayMessage('Noch kein Spielstand auf dem Server');
    emu.gameManager.loadState(state);
    emu.displayMessage('Spielstand vom Server geladen');
  } catch {
    emu.displayMessage('FEHLER: Server nicht erreichbar');
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') syncSram();
  else if (wakeLock) keepScreenOn();
});
window.addEventListener('pagehide', () => { syncSram(); });

// ------------------------------------------------------------------- Seite
function rememberRecent() {
  try {
    const key = 'retro-recent';
    const list = (JSON.parse(localStorage.getItem(key)) || [])
      .filter((r) => !(r.system === system && r.file === rom));
    list.unshift({ system, file: rom });
    localStorage.setItem(key, JSON.stringify(list.slice(0, 12)));
  } catch { /* Speicher nicht verfügbar */ }
}

// Display bleibt an, solange gespielt wird (braucht HTTPS)
async function keepScreenOn() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* nicht verfügbar */ }
}

function showTap(heading, info, buttonText) {
  $('tap-title').textContent = heading;
  $('tap-info').textContent = info;
  $('start').textContent = buttonText;
  $('start').hidden = !buttonText;
  $('start').disabled = false;
  $('tap').hidden = false;
}

// Spielstand vom Server holen, bevor der Emulator startet. Ohne Server kein Spiel – sonst entstünden
// Spielstände, die nirgends gesichert sind.
async function loadStartSram() {
  const pending = readPending();
  const server = await withRetry(() => fetchSave('sram'));
  if (pending && !sameBytes(pending, server)) {
    // Letzter Upload ist beim vorigen Mal nicht mehr durchgekommen – jetzt nachreichen
    await withRetry(() => putSave('sram', pending));
    clearPending();
    return pending;
  }
  clearPending();
  return server;
}

// Startet sofort beim Öffnen – kein zusätzlicher Tipp nötig. Vollbild und Ton gibt Chrome erst nach einer
// Berührung frei; die erste Berührung im Spiel (z. B. eine Bildschirmtaste) holt das automatisch nach.
async function start() {
  showTap(title, 'Lade Spielstand…', '');
  try {
    startSram = await loadStartSram();
  } catch {
    return showError('Server nicht erreichbar',
      'Der Spielstand konnte nicht geladen werden. Bitte Internetverbindung prüfen.');
  }

  $('tap').hidden = true;
  setTimeout(() => $('back').classList.add('dim'), 4000);
  setStatus('ok');
  keepScreenOn();

  let ejsPath = 'https://cdn.emulatorjs.org/stable/data/';
  try { ejsPath = (await (await fetch('/api/config')).json()).ejsPath; } catch { /* CDN als Fallback */ }
  rememberRecent();

  const touch = navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches;
  window.EJS_player = '#game';
  window.EJS_core = coreOverride || CORES[coreSystem];
  window.EJS_gameName = title;
  window.EJS_gameUrl = '/roms/' + encodeURIComponent(system) + '/' + encodeURIComponent(rom);
  window.EJS_pathtodata = ejsPath;
  window.EJS_language = 'de-GER';   // Dateiname der deutschen Übersetzung bei EmulatorJS
  window.EJS_color = '#e8473b';
  window.EJS_backgroundColor = '#000';
  window.EJS_startOnLoaded = true;
  window.EJS_onGameStart = onGameStart;
  window.EJS_onSaveState = onSaveState;
  window.EJS_onLoadState = onLoadState;
  // Touch-Controller auf dem Auto-Display einblenden (verschwindet automatisch bei angeschlossenem Controller)
  if (touch) window.EJS_defaultOptions = { 'virtual-gamepad': 'enabled' };

  const s = document.createElement('script');
  s.src = ejsPath + 'loader.js';
  s.onerror = () => showError('Emulator nicht erreichbar',
    'Der Emulator konnte nicht geladen werden. Besteht eine Internetverbindung?');
  document.body.append(s);
  patchAudioLatency();
  watchForFailure();
}

// Die RetroArch-Einstellungen schreibt EmulatorJS beim Laden des Emulator-Kerns fest hinein.
// Sobald die Klasse geladen ist (vor dem Kern), den Tonpuffer dort erhöhen.
function patchAudioLatency() {
  const timer = setInterval(() => {
    const GM = window.EJS_GameManager;
    if (!GM || !GM.prototype.getRetroArchCfg) return;
    clearInterval(timer);
    if (GM.prototype.getRetroArchCfg.patched) return;
    const original = GM.prototype.getRetroArchCfg;
    GM.prototype.getRetroArchCfg = function () {
      return original.call(this).replace(/audio_latency = \d+/, `audio_latency = ${AUDIO_LATENCY_MS}`);
    };
    GM.prototype.getRetroArchCfg.patched = true;
  }, 20);
  setTimeout(() => clearInterval(timer), 120000);
}

// EmulatorJS meldet Startfehler nicht nach außen, sondern bleibt in seiner Oberfläche stehen.
// Deshalb hier prüfen und eine verständliche Meldung zeigen.
function watchForFailure() {
  const timer = setInterval(() => {
    const emu = window.EJS_emulator;
    if (!emu) return;
    if (emu.started) return clearInterval(timer);
    if (!emu.failedToStart) return;
    clearInterval(timer);
    const detail = emu.textElem && emu.textElem.innerText ? ` (Meldung: ${emu.textElem.innerText})` : '';
    showError('Spiel konnte nicht gestartet werden',
      `Die Datei passt vermutlich nicht zum System oder ist beschädigt${detail}.`);
  }, 1000);
}

function showError(heading, info) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showTap(heading, info, '↻ Erneut versuchen');
  $('start').onclick = () => location.reload();
  $('home').hidden = false;
}

// Erste Berührung: Vollbild anfordern und Ton freigeben (beides verlangt Chrome nach einer Nutzeraktion)
function unlockOnTouch() {
  if (!document.fullscreenElement && $('tap').hidden) {
    try { document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch { /* egal */ }
  }
  try {
    const ctx = window.EJS_emulator.Module.AL.currentCtx;
    if (ctx.audioCtx && ctx.audioCtx.state === 'suspended') ctx.audioCtx.resume();
    ctx.sources.forEach((src) => { if (src.gain.context.state === 'suspended') src.gain.context.resume(); });
  } catch { /* Ton noch nicht bereit */ }
}
document.addEventListener('pointerdown', unlockOnTouch, true);
document.addEventListener('keydown', unlockOnTouch, true);

$('back').onclick = async () => {
  $('back').disabled = true;
  // Letzten Stand sichern, bevor die Seite verlassen wird (höchstens 5 Sekunden warten)
  await Promise.race([syncSram(), new Promise((r) => setTimeout(r, 5000))]);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  location.href = '/';
};
$('home').onclick = () => { location.href = '/'; };
document.addEventListener('contextmenu', (e) => e.preventDefault());

if (!CORES[system] || !rom) {
  showError('Ungültiges Spiel', 'Bitte in der Bibliothek ein Spiel auswählen.');
} else {
  document.title = title + ' – Retro Garage';
  start();
}

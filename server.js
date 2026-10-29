// Retro-Emulator-Server: liefert die Web-Oberfläche, die ROM-Liste und die ROM-Dateien aus.
// Keine externen Abhängigkeiten – nur Node.js (>= 18) wird benötigt.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createCoverService } = require('./covers');

// Einstellungen aus config.json (legt der Installer an); Umgebungsvariablen haben Vorrang.
function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`config.json konnte nicht gelesen werden: ${err.message}`);
    return {};
  }
}
const config = loadConfig();

const PORT = parseInt(process.env.PORT || config.port || '8080', 10);
const HOST = process.env.HOST || config.host || '0.0.0.0';
const ROM_DIR = path.resolve(__dirname, process.env.ROM_DIR || config.romDir || 'roms');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOCAL_EJS_DIR = path.join(PUBLIC_DIR, 'emulatorjs', 'data');
// Optionaler Passwortschutz (HTTP Basic Auth), z.B. wenn der Server aus dem Internet erreichbar ist.
const AUTH_USER = process.env.AUTH_USER || config.authUser || '';
const AUTH_PASS = process.env.AUTH_PASS || config.authPass || '';
// Optionales HTTPS: Zertifikat und Schlüssel als PEM (z. B. von Let's Encrypt). Im Auto-Chrome nötig für
// "Display bleibt an", App-Installation und damit das Passwort nicht unverschlüsselt übertragen wird.
const HTTPS_CERT = process.env.HTTPS_CERT || config.httpsCert || '';
const HTTPS_KEY = process.env.HTTPS_KEY || config.httpsKey || '';
// Spielstände liegen ausschließlich auf dem Server (nicht im Browser des Autos).
const SAVE_DIR = path.resolve(__dirname, process.env.SAVE_DIR || config.saveDir || 'saves');
const SAVE_KINDS = { sram: '.srm', state: '.state' };   // Spielinterner Speicher / Speicherstand (Snapshot)
const SAVE_MAX_BYTES = 128 * 1024 * 1024;
const HISTORY_DIR = '.versionen';
const HISTORY_KEEP = 20;                                  // ältere Versionen je Spielstand
const HISTORY_MIN_AGE_MS = 10 * 60 * 1000;               // höchstens eine Sicherung alle 10 Minuten
// Cover und Titel automatisch vom libretro-Thumbnail-Server (abschaltbar mit "covers": false)
const COVER_DIR = path.resolve(__dirname, process.env.COVER_DIR || config.coverDir || 'covers');
const COVERS_ENABLED = (process.env.COVERS || '').toLowerCase() !== 'off' && config.covers !== false;
const coverService = createCoverService({ dir: COVER_DIR, enabled: COVERS_ENABLED });

// Systeme -> EmulatorJS-Core und erlaubte Dateiendungen (.zip/.7z entpackt EmulatorJS selbst)
const SYSTEMS = {
  gb:   { name: 'Game Boy',         core: 'gb',   ext: ['.gb'] },
  gbc:  { name: 'Game Boy Color',   core: 'gb',   ext: ['.gbc', '.gb'] },
  gba:  { name: 'Game Boy Advance', core: 'gba',  ext: ['.gba'] },
  nes:  { name: 'NES',              core: 'nes',  ext: ['.nes', '.fds', '.unf'] },
  snes: { name: 'SNES',             core: 'snes', ext: ['.sfc', '.smc', '.fig', '.swc'] },
  n64:  { name: 'Nintendo 64',      core: 'n64',  ext: ['.n64', '.z64', '.v64'] },
  nds:  { name: 'Nintendo DS',      core: 'nds',  ext: ['.nds'] },
};
// Dateiendung -> System (erste Zuordnung gewinnt, .gb also Game Boy)
const EXT_SYSTEM = {};
for (const [id, sys] of Object.entries(SYSTEMS)) for (const e of sys.ext) EXT_SYSTEM[e] ??= id;
const ARCHIVE_EXT = ['.zip', '.7z'];
const COVER_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json',
};

for (const id of Object.keys(SYSTEMS)) {
  fs.mkdirSync(path.join(ROM_DIR, id), { recursive: true });
  fs.mkdirSync(path.join(SAVE_DIR, id), { recursive: true });
}

function saveFile(system, rom, kind) {
  return path.join(SAVE_DIR, system, rom + SAVE_KINDS[kind]);
}

// Liest die Dateinamen aus dem Inhaltsverzeichnis eines ZIP-Archivs (ohne es zu entpacken).
function zipEntryNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return [];
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset + cdSize > size || cdSize > 16 * 1024 * 1024) return [];
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

// Erkennt das System eines Spiels an der Endung bzw. an der ROM im ZIP – unabhängig vom Ordner,
// in dem es liegt. So startet ein Spiel im falschen Ordner trotzdem mit dem richtigen Emulator.
// Liefert { system, romName } – romName ist bei ZIPs der Name der ROM darin (oft der saubere No-Intro-Name).
const detectCache = new Map();
function detectSystem(file, folder) {
  const ext = path.extname(file).toLowerCase();
  const own = { system: folder, romName: path.basename(file) };
  if (SYSTEMS[folder].ext.includes(ext)) return own;
  if (EXT_SYSTEM[ext]) return { system: EXT_SYSTEM[ext], romName: path.basename(file) };
  if (ext !== '.zip') return ARCHIVE_EXT.includes(ext) ? own : null;   // .7z: Ordner vertrauen
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (!detectCache.has(key)) {
    let found = own;   // ohne erkennbare ROM: dem Ordner vertrauen
    try {
      const roms = zipEntryNames(file).filter((n) => EXT_SYSTEM[path.extname(n).toLowerCase()]);
      const inFolder = roms.find((n) => SYSTEMS[folder].ext.includes(path.extname(n).toLowerCase()));
      if (inFolder) found = { system: folder, romName: path.basename(inFolder) };
      else if (roms.length) found = { system: EXT_SYSTEM[path.extname(roms[0]).toLowerCase()], romName: path.basename(roms[0]) };
    } catch { /* unlesbares ZIP: Ordner vertrauen */ }
    detectCache.set(key, found);
  }
  return detectCache.get(key);
}

// Titel aus dem Dateinamen: Release-Nummern, Unterstriche, Bindestriche und Klammerangaben entfernen
function titleFromName(name) {
  const base = name.replace(/\.[a-z0-9]{1,4}$/i, '').replace(/^\d{1,5}\s*-\s*/, '');
  return base.replace(/[_.]+|-(?=\S)/g, ' ').replace(/\s*[\[(].*?[\])]\s*/g, ' ').replace(/\s+/g, ' ').trim() || base;
}

function listRoms() {
  const result = {};
  for (const [id, sys] of Object.entries(SYSTEMS)) result[id] = { name: sys.name, core: sys.core, games: [] };
  for (const folder of Object.keys(SYSTEMS)) {
    const dir = path.join(ROM_DIR, folder);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { /* Ordner fehlt */ }
    const covers = new Map();
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (COVER_EXT.includes(ext)) covers.set(path.basename(f, path.extname(f)).toLowerCase(), f);
    }
    for (const f of files) {
      const detected = detectSystem(path.join(dir, f), folder);
      if (!detected) continue;
      const { system, romName } = detected;
      const base = path.basename(f, path.extname(f));
      const cover = covers.get(base.toLowerCase());
      // Erkannte Titel/Cover; ein eigenes Cover-Bild im ROM-Ordner hat Vorrang
      const known = coverService.info(folder, f);
      coverService.request(folder, f, system, romName);
      let size = 0;
      try { size = fs.statSync(path.join(dir, f)).size; } catch { /* ignorieren */ }
      result[system].games.push({
        file: f,
        folder,   // Ablageort (für ROM-Adresse und Spielstände); "system" bestimmt den Emulator
        title: (known && known.title) || titleFromName(romName),
        size,
        cover: cover ? `/roms/${folder}/${encodeURIComponent(cover)}` : (known && known.cover) || null,
        saved: Object.keys(SAVE_KINDS).some((k) => fs.existsSync(saveFile(folder, f, k))),
      });
    }
  }
  for (const sys of Object.values(result)) sys.games.sort((a, b) => a.title.localeCompare(b.title, 'de'));
  return result;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, data) {
  send(res, 200, JSON.stringify(data), { 'Content-Type': MIME['.json'] });
}

// Löst einen URL-Pfad sicher innerhalb eines Basisordners auf (kein "../" möglich).
function safeJoin(base, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const target = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

function serveFile(req, res, filePath, cache) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Nicht gefunden');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache ? 'public, max-age=86400' : 'no-cache',
      'Last-Modified': stat.mtime.toUTCString(),
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? parseInt(range[1], 10) : stat.size - parseInt(range[2], 10);
      const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), stat.size - 1) : stat.size - 1;
      if (start < 0 || start > end) return send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` });
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function authorized(req) {
  if (!AUTH_USER) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  return user === AUTH_USER && rest.join(':') === AUTH_PASS;
}

// /api/saves/<system>/<rom-datei>/<sram|state> – nur für ROMs, die tatsächlich existieren
function parseSavePath(pathname) {
  const parts = pathname.slice('/api/saves/'.length).split('/').map(decodeURIComponent);
  if (parts.length !== 3) return null;
  const [system, rom, kind] = parts;
  if (!SYSTEMS[system] || !SAVE_KINDS[kind]) return null;
  if (!rom || rom !== path.basename(rom) || rom.startsWith('.')) return null;
  if (!fs.existsSync(path.join(ROM_DIR, system, rom))) return null;
  return { system, rom, kind, file: saveFile(system, rom, kind) };
}

// Vorherigen Stand aufheben, bevor er überschrieben wird – schützt vor versehentlich leeren/alten Uploads
function archiveSave(target, body) {
  let old;
  try { old = fs.readFileSync(target); } catch { return; }
  if (old.equals(body)) return;
  const dir = path.join(path.dirname(target), HISTORY_DIR);
  const base = path.basename(target);
  fs.mkdirSync(dir, { recursive: true });
  const versions = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.')).sort();
  const last = versions[versions.length - 1];
  if (last && Date.now() - fs.statSync(path.join(dir, last)).mtimeMs < HISTORY_MIN_AGE_MS) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `${base}.${stamp}`), old);
  versions.push(`${base}.${stamp}`);
  for (const f of versions.slice(0, Math.max(0, versions.length - HISTORY_KEEP))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

function handleSave(req, res, pathname) {
  const save = parseSavePath(pathname);
  if (!save) return send(res, 404, 'Unbekanntes Spiel');
  if (req.method === 'GET' || req.method === 'HEAD') {
    return fs.stat(save.file, (err, stat) => {
      if (err) return send(res, 404, 'Kein Spielstand');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Last-Modified': stat.mtime.toUTCString(),
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(save.file).pipe(res);
    });
  }
  // PUT: komplett empfangen, dann atomar ersetzen (keine halb geschriebenen Spielstände)
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > SAVE_MAX_BYTES) { send(res, 413, 'Spielstand zu groß'); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    if (!body.length) return send(res, 400, 'Leerer Spielstand');
    try {
      archiveSave(save.file, body);
      const tmp = `${save.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, save.file);
      sendJson(res, { ok: true, size: body.length, saved: new Date().toISOString() });
    } catch (err) {
      console.error(`Spielstand konnte nicht gespeichert werden (${save.file}): ${err.message}`);
      send(res, 500, 'Speichern fehlgeschlagen');
    }
  });
}

function readTls() {
  return {
    cert: fs.readFileSync(path.resolve(__dirname, HTTPS_CERT)),
    key: fs.readFileSync(path.resolve(__dirname, HTTPS_KEY)),
  };
}

function handle(req, res) {
  if (!authorized(req)) {
    return send(res, 401, 'Anmeldung erforderlich', { 'WWW-Authenticate': 'Basic realm="Retro Emulator"' });
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { return send(res, 400, 'Ungültige URL'); }

  if (pathname.startsWith('/api/saves/') && ['GET', 'HEAD', 'PUT'].includes(req.method)) {
    try { return handleSave(req, res, pathname); } catch { return send(res, 400, 'Ungültiger Pfad'); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Methode nicht erlaubt');

  if (pathname === '/api/roms') {
    const data = listRoms();
    // Solange noch Cover gesucht werden, lädt die Bibliothek die Liste nach
    return send(res, 200, JSON.stringify(data), {
      'Content-Type': MIME['.json'],
      'X-Covers-Pending': coverService.busy() ? '1' : '0',
    });
  }
  if (pathname === '/api/config') {
    return sendJson(res, {
      ejsPath: fs.existsSync(path.join(LOCAL_EJS_DIR, 'loader.js'))
        ? '/emulatorjs/data/'
        : 'https://cdn.emulatorjs.org/stable/data/',
    });
  }

  try {
    if (pathname.startsWith('/covers/')) {
      // Nur heruntergeladene Cover, nicht die internen Listen (.index, titel.json)
      const file = safeJoin(COVER_DIR, pathname.slice('/covers/'.length));
      if (!file || !file.endsWith('.png') || file.includes(`${path.sep}.`)) return send(res, 403, 'Verboten');
      return serveFile(req, res, file, true);
    }
    if (pathname.startsWith('/roms/')) {
      const file = safeJoin(ROM_DIR, pathname.slice('/roms/'.length));
      return file ? serveFile(req, res, file, true) : send(res, 403, 'Verboten');
    }
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = safeJoin(PUBLIC_DIR, rel);
    if (!file) return send(res, 403, 'Verboten');
    return serveFile(req, res, file, rel.startsWith('emulatorjs/'));
  } catch {
    return send(res, 400, 'Ungültiger Pfad');
  }
}

const useHttps = Boolean(HTTPS_CERT && HTTPS_KEY);
let server;
if (useHttps) {
  try {
    server = https.createServer(readTls(), handle);
  } catch (err) {
    console.error(`HTTPS-Zertifikat konnte nicht geladen werden: ${err.message}`);
    process.exit(1);
  }
  // Erneuerte Zertifikate (Let's Encrypt) ohne Neustart übernehmen
  setInterval(() => {
    try { server.setSecureContext(readTls()); } catch (err) { console.error(`Zertifikat-Neuladen fehlgeschlagen: ${err.message}`); }
  }, 12 * 60 * 60 * 1000).unref();
} else {
  server = http.createServer(handle);
}

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${PORT} ist bereits belegt. Anderen Port in config.json eintragen oder Installer erneut ausführen.`
    : `Serverfehler: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Retro-Emulator läuft auf ${useHttps ? 'https' : 'http'}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`ROM-Ordner: ${ROM_DIR}`);
  console.log(`Spielstände: ${SAVE_DIR}`);
  if (AUTH_USER) console.log('Passwortschutz aktiv.');
});

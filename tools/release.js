#!/usr/bin/env node
// Veröffentlicht ein Release auf GitHub: pusht den aktuellen Stand, setzt den Versions-Tag,
// baut das Download-Paket und legt das Release mit Notizen an.
//
//   node tools/release.js                       # Notizen aus den Commits seit dem letzten Release
//   node tools/release.js --notes "Neu: …"      # eigene Notizen
//   node tools/release.js --notes-file notes.md
//   node tools/release.js --dry-run             # nur anzeigen, was passieren würde
//
// Version: Datum + laufende Nummer des Tages, z. B. v2026.10.19.1 (wie bei OpenRisk).
// Das Paket enthält nur, was in Git eingecheckt ist (git archive) – also nie ROMs,
// Spielstände oder config.json.
// Voraussetzung: GitHub-Kommandozeile installiert und angemeldet (gh auth login).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'Retro Garage';
const FILE_PREFIX = 'RetroGarage';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');

function run(cmd, cmdArgs, { capture = true, allowFail = false } = {}) {
  try {
    const out = execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
    return capture ? out.trim() : '';
  } catch (err) {
    if (allowFail) return null;
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`${cmd} ${cmdArgs.join(' ')} fehlgeschlagen:\n${detail}`);
  }
}

function fail(message) {
  console.error(`Fehler: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------- Prüfungen
if (run('gh', ['--version'], { allowFail: true }) === null) {
  fail('GitHub-Kommandozeile fehlt: winget install --id GitHub.cli, danach gh auth login');
}
if (run('gh', ['auth', 'status'], { allowFail: true }) === null) fail('Nicht bei GitHub angemeldet: gh auth login');
if (run('git', ['status', '--porcelain'])) {
  fail('Es gibt nicht eingecheckte Änderungen. Erst committen, dann das Release erstellen.');
}
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') fail(`Releases nur vom Branch main (aktuell: ${branch}).`);

// ---------------------------------------------------------------- Version
run('git', ['fetch', '--tags', '--quiet'], { allowFail: true });
const now = new Date();
const day = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
const tags = run('git', ['tag', '--list', `v${day}.*`]).split('\n').filter(Boolean);
const next = tags.reduce((max, t) => Math.max(max, parseInt(t.split('.').pop(), 10) || 0), 0) + 1;
const version = `${day}.${next}`;
const tag = `v${version}`;

// ---------------------------------------------------------------- Notizen
let notes = option('--notes');
const notesFile = option('--notes-file');
if (notesFile) notes = fs.readFileSync(path.resolve(notesFile), 'utf8');
if (!notes) {
  const previous = run('git', ['describe', '--tags', '--abbrev=0'], { allowFail: true });
  const range = previous ? [`${previous}..HEAD`] : [];
  const subjects = run('git', ['log', '--format=%s', '--no-merges', ...range]).split('\n').filter(Boolean);
  if (!subjects.length) fail(`Seit ${previous} gibt es keine neuen Commits – nichts zu veröffentlichen.`);
  notes = subjects.map((s) => `- ${s}`).join('\n');
}
notes += `\n\n**Installation:** \`${FILE_PREFIX}-${version}.zip\` herunterladen, entpacken und \`install.bat\` ` +
  '(Windows) bzw. `bash install.sh` (Linux) starten. Eine bestehende Installation wird dabei aktualisiert – ' +
  'Einstellungen, ROMs und Spielstände bleiben erhalten.';

console.log(`${NAME} ${version} (${tag})\n\n${notes}\n`);
if (dryRun) {
  console.log('--dry-run: nichts veröffentlicht.');
  process.exit(0);
}

// ------------------------------------------------------------ Veröffentlichen
console.log('Pushe main …');
run('git', ['push', 'origin', 'main'], { capture: false });

fs.mkdirSync(DIST, { recursive: true });
const zip = path.join(DIST, `${FILE_PREFIX}-${version}.zip`);
console.log(`Baue ${path.relative(ROOT, zip)} …`);
run('git', ['archive', '--format=zip', `--prefix=${FILE_PREFIX}/`, '-o', zip, 'HEAD']);

console.log(`Setze Tag ${tag} …`);
run('git', ['tag', '-a', tag, '-m', `${NAME} ${version}`]);
run('git', ['push', 'origin', tag], { capture: false });

const notesPath = path.join(DIST, `notes-${version}.md`);
fs.writeFileSync(notesPath, notes);
console.log('Lege Release an …');
const url = run('gh', ['release', 'create', tag, zip, '--title', `${NAME} ${version}`, '--notes-file', notesPath, '--verify-tag']);
fs.rmSync(notesPath, { force: true });
console.log(`\nFertig: ${url}`);

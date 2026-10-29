#!/usr/bin/env bash
# Retro Garage unter Linux / Raspberry Pi OS installieren oder aktualisieren (erneut ausführen).
#
#   ./install.sh                                    # fragt Ort, Port, ROM-Ordner und Passwort ab
#   ./install.sh --dir /opt/retrogarage --port 8090 --rom-dir /srv/roms --service --yes
#   ./install.sh --uninstall --dir /opt/retrogarage
#
# Optionen:
#   --dir DIR        Installationsort (Standard: ~/retrogarage)
#   --port N         Port der Weboberfläche (Standard: 8080)
#   --rom-dir DIR    ROM-Ordner (Standard: <Installationsort>/roms)
#   --save-dir DIR   Spielstände (Standard: <Installationsort>/saves)
#   --user U         Passwortschutz: Benutzername (zusammen mit --password)
#   --password P     Passwortschutz: Passwort
#   --https-cert F   HTTPS: Zertifikat (PEM, z. B. /etc/letsencrypt/live/<domain>/fullchain.pem)
#   --https-key F    HTTPS: privater Schlüssel (PEM, z. B. .../privkey.pem)
#   --service        als systemd-Dienst einrichten (startet beim Hochfahren, braucht sudo)
#   --yes            keine Rückfragen, Standardwerte verwenden
#   --uninstall      Installation entfernen (ROMs und Spielstände bleiben erhalten, außer man bestätigt das Löschen)
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="" PORT="" ROM_DIR="" SAVE_DIR="" AUTH_USER="" AUTH_PASS="" CERT="" KEY="" SERVICE=ask YES=no UNINSTALL=no
SERVICE_NAME=retrogarage
SYSTEMS="gb gbc gba nes snes n64 nds"
MIN_NODE=18

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --rom-dir) ROM_DIR="$2"; shift 2 ;;
    --save-dir) SAVE_DIR="$2"; shift 2 ;;
    --user) AUTH_USER="$2"; shift 2 ;;
    --password) AUTH_PASS="$2"; shift 2 ;;
    --https-cert) CERT="$2"; shift 2 ;;
    --https-key) KEY="$2"; shift 2 ;;
    --service) SERVICE=yes; shift ;;
    --yes) YES=yes; shift ;;
    --uninstall) UNINSTALL=yes; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
die() { echo "Fehler: $1" >&2; exit 1; }
ask() {  # ask FRAGE STANDARD
  local answer=""
  [ "$YES" = yes ] || read -r -p "$1 [$2]: " answer
  echo "${answer:-$2}"
}
confirm() {  # confirm FRAGE STANDARD(j|n)
  local answer
  answer="$(ask "$1 (j/n)" "$2")"
  case "$answer" in [jJyY]*) return 0 ;; *) return 1 ;; esac
}
abspath() { mkdir -p "$1" && (cd "$1" && pwd); }
node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
config_value() {  # config_value DATEI SCHLÜSSEL
  [ -f "$1" ] && command -v node >/dev/null 2>&1 &&
    node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c[process.argv[2]]??""))}catch{}' "$1" "$2" || true
}
data_dir() {  # data_dir CONFIG SCHLÜSSEL STANDARD INSTALLATIONSORT -> absoluter Pfad
  local value
  value="$(config_value "$1" "$2")"; value="${value:-$3}"
  case "$value" in /*) echo "$value" ;; .) echo "$4" ;; *) echo "$4/$value" ;; esac
}
config_path() {  # Ordner innerhalb der Installation relativ speichern
  case "$1" in "$2") echo "." ;; "$2"/*) echo "${1#"$2"/}" ;; *) echo "$1" ;; esac
}
inside() { case "$1/" in "$2"/*) return 0 ;; *) return 1 ;; esac; }   # inside PFAD ORDNER
service_installed() { [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; }

# ------------------------------------------------------------------ Entfernen
if [ "$UNINSTALL" = yes ]; then
  [ -n "$DIR" ] || DIR="$(ask "Installationsort von Retro Garage" "$HOME/retrogarage")"
  DIR="${DIR/#\~/$HOME}"
  [ -f "$DIR/server.js" ] || die "In '$DIR' liegt keine Retro-Garage-Installation."
  DIR="$(cd "$DIR" && pwd)"
  ROMS="$(data_dir "$DIR/config.json" romDir roms "$DIR")"
  SAVES="$(data_dir "$DIR/config.json" saveDir saves "$DIR")"
  [ "$YES" = yes ] || confirm "Retro Garage in '$DIR' entfernen?" n || exit 0
  KEEP=()
  if inside "$ROMS" "$DIR" && ! confirm "Auch alle ROMs in '$ROMS' löschen?" n; then KEEP+=("$ROMS"); fi
  if inside "$SAVES" "$DIR" && ! confirm "Auch alle SPIELSTÄNDE in '$SAVES' löschen?" n; then KEEP+=("$SAVES"); fi
  if service_installed; then
    sudo systemctl disable --now "$SERVICE_NAME" || true
    sudo rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    sudo systemctl daemon-reload
  fi
  cd /
  # Rekursiv löschen, aber zu behaltende Ordner und ihre übergeordneten Ordner stehen lassen
  remove_except() {
    local entry k skip
    for entry in "$1"/* "$1"/.[!.]*; do
      [ -e "$entry" ] || continue
      skip=no
      for k in "${KEEP[@]}"; do
        if inside "$entry" "$k"; then skip=keep; break; fi
        if inside "$k" "$entry"; then skip=descend; fi
      done
      case "$skip" in keep) ;; descend) remove_except "$entry" ;; *) rm -rf "$entry" ;; esac
    done
  }
  remove_except "$DIR"
  rmdir "$DIR" 2>/dev/null || true
  echo "Retro Garage wurde entfernt."
  for k in "${KEEP[@]}"; do echo "Erhalten: $k"; done
  exit 0
fi

[ -f "$SOURCE/server.js" ] && [ -f "$SOURCE/public/index.html" ] || die "install.sh muss im Retro-Garage-Ordner liegen."
echo "Retro Garage - Installation"

# ------------------------------------------------------------------- Node.js
if [ "$(node_major)" -lt "$MIN_NODE" ]; then
  if command -v apt-get >/dev/null 2>&1 && confirm "Node.js $MIN_NODE+ fehlt - jetzt per apt installieren (sudo)?" j; then
    sudo apt-get update && sudo apt-get install -y nodejs
  fi
  [ "$(node_major)" -ge "$MIN_NODE" ] || die "Node.js $MIN_NODE oder neuer wird benötigt (https://nodejs.org)."
fi
NODE="$(command -v node)"

# ------------------------------------------------------------------ Abfragen
[ -n "$DIR" ] || DIR="$(ask "Installationsort" "$HOME/retrogarage")"
DIR="$(abspath "${DIR/#\~/$HOME}")"
CONFIG="$DIR/config.json"
[ -f "$CONFIG" ] && echo "Vorhandene Installation gefunden - Einstellungen werden als Vorschlag übernommen."
service_installed && sudo systemctl stop "$SERVICE_NAME" || true

port_free() {
  "$NODE" -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"0.0.0.0",()=>s.close())' "$1"
}
OLD_PORT="$(config_value "$CONFIG" port)"
while true; do
  [ -n "$PORT" ] || PORT="$(ask "Port der Weboberfläche" "${OLD_PORT:-8080}")"
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "Port '$PORT' ist ungültig." >&2
  elif [ "$PORT" -lt 1024 ] && [ "$(id -u)" -ne 0 ]; then
    echo "Ports unter 1024 brauchen root-Rechte - bitte einen Port ab 1024 wählen." >&2
  elif ! port_free "$PORT"; then
    echo "Port $PORT ist belegt." >&2
  else break; fi
  [ "$YES" = no ] || die "Port $PORT ist nicht verwendbar."
  PORT=""
done

[ -n "$ROM_DIR" ] || ROM_DIR="$(ask "ROM-Ordner" "$(data_dir "$CONFIG" romDir roms "$DIR")")"
ROM_DIR="$(abspath "${ROM_DIR/#\~/$HOME}")"
[ -n "$SAVE_DIR" ] || SAVE_DIR="$(ask "Ordner für Spielstände" "$(data_dir "$CONFIG" saveDir saves "$DIR")")"
SAVE_DIR="$(abspath "${SAVE_DIR/#\~/$HOME}")"

if [ -z "$AUTH_USER" ]; then
  OLD_USER="$(config_value "$CONFIG" authUser)"
  OLD_PASS="$(config_value "$CONFIG" authPass)"
  if [ "$YES" = yes ]; then
    AUTH_USER="$OLD_USER" AUTH_PASS="$OLD_PASS"
  elif confirm "Passwortschutz einrichten (empfohlen, wenn aus dem Internet erreichbar)?" "$([ -n "$OLD_USER" ] && echo j || echo n)"; then
    AUTH_USER="$(ask "Benutzername" "${OLD_USER:-retro}")"
    read -r -s -p "Passwort (leer = bisheriges behalten): " AUTH_PASS; echo
    AUTH_PASS="${AUTH_PASS:-$OLD_PASS}"
    [ -n "$AUTH_PASS" ] || die "Ein Passwort ist erforderlich."
  fi
fi

if [ -z "$CERT$KEY" ]; then
  OLD_CERT="$(config_value "$CONFIG" httpsCert)"
  OLD_KEY="$(config_value "$CONFIG" httpsKey)"
  if [ "$YES" = yes ]; then
    CERT="$OLD_CERT" KEY="$OLD_KEY"
  else
    echo "HTTPS wird im Auto-Chrome für 'Display bleibt an', App-Installation und verschlüsseltes Passwort gebraucht."
    if confirm "HTTPS mit vorhandenem Zertifikat (z. B. Let's Encrypt) einrichten?" "$([ -n "$OLD_CERT" ] && echo j || echo n)"; then
      CERT="$(ask "Zertifikat (PEM, fullchain.pem)" "$OLD_CERT")"
      KEY="$(ask "Privater Schlüssel (PEM, privkey.pem)" "$OLD_KEY")"
    fi
  fi
fi
if [ -n "$CERT$KEY" ]; then
  for f in "$CERT" "$KEY"; do [ -n "$f" ] && [ -r "$f" ] || die "HTTPS-Datei '$f' nicht gefunden oder nicht lesbar."; done
  SCHEME=https
else
  SCHEME=http
fi

if [ "$SERVICE" = ask ]; then
  if command -v systemctl >/dev/null 2>&1 && confirm "Als systemd-Dienst beim Hochfahren starten (sudo)?" j; then SERVICE=yes; else SERVICE=no; fi
fi

# -------------------------------------------------------------------- Dateien
step "Programmdateien nach $DIR"
if [ "$DIR" = "$SOURCE" ]; then
  echo "Installation im Quellordner - nichts zu kopieren."
else
  cp -R "$SOURCE/public" "$DIR/"
  for f in server.js covers.js package.json README.md LICENSE install.sh config.example.json; do
    [ -f "$SOURCE/$f" ] && cp "$SOURCE/$f" "$DIR/"
  done
fi
for s in $SYSTEMS; do mkdir -p "$ROM_DIR/$s" "$SAVE_DIR/$s"; done
echo "ROM-Ordner:   $ROM_DIR"
echo "Spielstände:  $SAVE_DIR"

# ------------------------------------------------------------- Konfiguration
step "Konfiguration"
ROM_CFG="$(config_path "$ROM_DIR" "$DIR")"
SAVE_CFG="$(config_path "$SAVE_DIR" "$DIR")"
"$NODE" -e '
const [file, port, romDir, saveDir, user, pass, cert, key] = process.argv.slice(1);
const c = { port: +port, host: "0.0.0.0", romDir, saveDir };
if (user) { c.authUser = user; c.authPass = pass; }
if (cert) { c.httpsCert = cert; c.httpsKey = key; }
require("fs").writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
' "$CONFIG" "$PORT" "$ROM_CFG" "$SAVE_CFG" "$AUTH_USER" "$AUTH_PASS" "$CERT" "$KEY"
echo "config.json geschrieben (Port $PORT${AUTH_USER:+, Passwortschutz aktiv}${CERT:+, HTTPS})."

# --------------------------------------------------------------------- Dienst
if [ "$SERVICE" = yes ]; then
  step "systemd-Dienst"
  sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null <<EOF
[Unit]
Description=Retro Garage Emulator-Server
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  echo "Dienst '$SERVICE_NAME' läuft (Logs: journalctl -u $SERVICE_NAME -f)."
elif service_installed; then
  sudo systemctl disable --now "$SERVICE_NAME" || true
  sudo rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  sudo systemctl daemon-reload
  echo "Bisherigen Dienst entfernt."
fi

echo
echo "Fertig."
[ "$SERVICE" = yes ] || echo "  Starten:       cd '$DIR' && node server.js"
echo "  Oberfläche:    $SCHEME://localhost:$PORT"
if [ -n "$CERT" ]; then echo "  Im Auto:       https://<deine-domain>:$PORT  (Domain des Zertifikats)"; else
for ip in $(hostname -I 2>/dev/null); do case "$ip" in *:*) ;; *) echo "  Im Netz/Auto:  http://$ip:$PORT" ;; esac; done; fi
echo "  ROMs ablegen:  $ROM_DIR/<gb|gbc|gba|nes|snes|n64|nds>"
echo "  Spielstände:   $SAVE_DIR  (ältere Versionen jeweils im Unterordner .versionen)"
echo "  Einstellungen: $CONFIG (oder Installer erneut ausführen)"
echo "  Entfernen:     ./install.sh --uninstall --dir '$DIR'"

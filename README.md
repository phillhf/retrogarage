# Retro Garage – Retro-Konsolen im Browser

Spielt **Game Boy, Game Boy Color, Game Boy Advance, NES, SNES, Nintendo 64 und Nintendo DS** im
Browser – gebaut für den Chrome im Auto (Android Automotive, z. B. BYD Atto 3 Evo), läuft aber in jedem
aktuellen Browser auf Tablet, Handy oder PC.

Die ROMs und alle Spielstände liegen auf dem eigenen Server. Das Auto braucht nur eine Internetverbindung
zum Server; im Browser wird nichts dauerhaft gespeichert, Browserdaten löschen ist also unbedenklich.

- Spielebibliothek mit großen Kacheln, Suche, Filter nach Konsole und „Zuletzt gespielt“
- Spiel antippen – es startet sofort mit dem passenden Emulator
- Bildschirmtasten auf Touch-Displays; sie verschwinden automatisch, sobald ein Controller erkannt wird
- Spielstände werden automatisch auf dem Server gesichert, mit älteren Versionen als Sicherheitsnetz
- Konsole wird an der Datei erkannt, auch wenn ein Spiel im falschen Ordner liegt
- Optional Passwortschutz und HTTPS
- Nur Node.js nötig – keine Pakete, keine Datenbank, kein Build

Emulation: [EmulatorJS](https://emulatorjs.org) (RetroArch-Emulatoren als WebAssembly), wird vom
EmulatorJS-CDN geladen.

## Inhalt

- [Installation](#installation)
- [Aktualisieren und Entfernen](#aktualisieren-und-entfernen)
- [ROMs ablegen](#roms-ablegen)
- [Spielen](#spielen)
- [Spielstände](#spielstände)
- [Im Auto](#im-auto-android-automotive)
- [HTTPS einrichten](#https-einrichten)
- [Einstellungen](#einstellungen)
- [Fehlerbehebung](#fehlerbehebung)
- [Aufbau](#aufbau)
- [Release veröffentlichen](#release-veröffentlichen)
- [Rechtliches](#rechtliches)

## Installation

Voraussetzung ist **Node.js 18 oder neuer**. Fehlt es, bietet der Installer die Installation an
(Windows: winget, Linux: apt).

| System | Aufruf | Ohne Rückfragen |
|---|---|---|
| Windows | Doppelklick auf `install.bat` | `install.bat -InstallDir D:\RetroGarage -Port 8090 -Service -Firewall -Unattended` |
| Linux / Raspberry Pi | `bash install.sh` | `bash install.sh --dir /opt/retrogarage --port 8090 --service --yes` |

Der Installer fragt ab:

| Frage | Standard | Hinweis |
|---|---|---|
| Installationsort | Windows `C:\RetroGarage`, Linux `~/retrogarage` | |
| Port | `8080` | wird auf Belegung geprüft |
| ROM-Ordner | `<Installationsort>\roms` | darf auch woanders liegen, z. B. auf einer zweiten Platte |
| Ordner für Spielstände | `<Installationsort>\saves` | |
| Passwortschutz | aus | **empfohlen**, sobald der Server aus dem Internet erreichbar ist |
| HTTPS-Zertifikat | aus | siehe [HTTPS einrichten](#https-einrichten) |
| Hintergrunddienst | an (nur als Administrator) | startet beim Hochfahren, auch ohne Anmeldung |
| Firewall-Freigabe | an (nur als Administrator) | ohne Freigabe kommt das Auto nicht an den Server |
| Autostart / Desktop-Verknüpfungen | | nur ohne Hintergrunddienst |

Für Hintergrunddienst und Firewall-Freigabe unter Windows `install.bat` per Rechtsklick
**„Als Administrator ausführen“**. Der Dienst ist eine geplante Aufgabe `RetroGarage`, die als SYSTEM
beim Systemstart läuft und sich bei Absturz neu startet. Unter Linux richtet `--service` einen
systemd-Dienst `retrogarage` ein (Logs: `journalctl -u retrogarage -f`).

Danach im Browser `http://<server-adresse>:<port>` öffnen. Der Installer zeigt am Ende die Adressen an.

### Alle Parameter

| Windows (`install.bat`) | Linux (`install.sh`) | Bedeutung |
|---|---|---|
| `-InstallDir D:\RetroGarage` | `--dir /opt/retrogarage` | Installationsort |
| `-Port 8090` | `--port 8090` | Port der Weboberfläche |
| `-RomDir E:\ROMs` | `--rom-dir /srv/roms` | ROM-Ordner |
| `-SaveDir E:\Saves` | `--save-dir /srv/saves` | Ordner für Spielstände |
| `-User retro -Password …` | `--user retro --password …` | Passwortschutz |
| `-HttpsCert … -HttpsKey …` | `--https-cert … --https-key …` | HTTPS (PEM-Dateien) |
| `-Service` | `--service` | Hintergrunddienst |
| `-Firewall` | – | Port in der Windows-Firewall freigeben |
| `-Autostart` | – | ohne Dienst: beim Anmelden starten |
| `-NoShortcut` | – | keine Desktop-Verknüpfungen |
| `-Unattended` | `--yes` | keine Rückfragen, Standardwerte bzw. bisherige Einstellungen |
| `-Uninstall` | `--uninstall` | Installation entfernen |

Ein Passwort auf der Kommandozeile ist für andere Benutzer des Rechners in der Prozessliste sichtbar –
im Zweifel lieber interaktiv eingeben.

### Ohne Installer

```
node server.js
```

im Programmordner starten (Windows: `start.bat`). Einstellungen dann über `config.json` (Vorlage:
`config.example.json`) oder [Umgebungsvariablen](#einstellungen).

## Aktualisieren und Entfernen

**Aktualisieren:** Neue Version von den [Releases](https://github.com/phillhf/retrogarage/releases/latest)
herunterladen (`RetroGarage-<version>.zip`), entpacken und den Installer erneut ausführen, als Installationsort
die bestehende Installation angeben. Bei allen anderen Fragen reicht Enter – der Installer schlägt die
bisherigen Einstellungen vor. Er beendet den laufenden Server, kopiert das Programm und behält
`config.json`, ROMs und Spielstände. Mit Hintergrunddienst startet der Server automatisch neu, sonst
danach `start.bat` (bzw. `node server.js`) starten.

```
install.bat -InstallDir C:\RetroGarage -Unattended
```

Port oder Passwort ändern geht genauso: Installer erneut ausführen und den neuen Wert eingeben.

**Entfernen:** `install.bat -Uninstall` bzw. `bash install.sh --uninstall --dir <ort>`. Entfernt Programm,
Dienst, Firewall-Regel und Verknüpfungen. **ROMs und Spielstände bleiben erhalten**, außer das Löschen
wird ausdrücklich bestätigt.

## ROMs ablegen

| Ordner | Konsole | Dateien |
|---|---|---|
| `roms/gb` | Game Boy | `.gb` |
| `roms/gbc` | Game Boy Color | `.gbc` (auch `.gb`) |
| `roms/gba` | Game Boy Advance | `.gba` |
| `roms/nes` | NES | `.nes`, `.fds`, `.unf` |
| `roms/snes` | SNES | `.sfc`, `.smc`, `.fig`, `.swc` |
| `roms/n64` | Nintendo 64 | `.z64`, `.n64`, `.v64` |
| `roms/nds` | Nintendo DS | `.nds` |

- `.zip` und `.7z` gehen ebenfalls und sparen Datenvolumen im Auto.
- **Falscher Ordner?** Kein Problem: Der Server erkennt die Konsole an der Dateiendung bzw. an der ROM im
  ZIP (z. B. ein DS-Spiel im GBC-Ordner) und startet den richtigen Emulator. Bei `.7z` zählt der Ordner.
- **Cover:** Bild mit gleichem Namen daneben legen (`Spiel.png`, `.jpg`, `.webp`).
- Neue Spiele erscheinen sofort – Seite neu laden genügt, kein Neustart nötig.
- Der Titel wird aus dem Dateinamen gebildet; Unterstriche, Bindestriche und Angaben in Klammern wie
  `(Germany)` fallen weg.

## Spielen

- **Spiel antippen** – es startet sofort. Vollbild und Ton gibt Chrome erst nach einer Berührung frei; die
  erste Berührung im Spiel (z. B. eine Bildschirmtaste) holt das automatisch nach.
- **Oben rechts** ist immer der Knopf **„⌂ Hauptmenü“** – auch beim Laden und bei Fehlern. Die Wolke im
  Knopf zeigt den Sicherungsstand (siehe [Spielstände](#spielstände)).
- **Oben links (☰)** öffnet das Emulator-Menü: Speicherstand speichern/laden, Lautstärke, Einstellungen,
  Tastenbelegung.
- **Bildschirmtasten** erscheinen auf Touch-Displays. Ist ein USB- oder Bluetooth-Controller verbunden,
  verschwinden sie automatisch; wird er getrennt, kommen sie zurück. Chrome meldet einen Controller erst,
  nachdem einmal eine Taste darauf gedrückt wurde.
- **„Schnell“/„Langsam“** unten in der Mitte: Vorspulen bzw. Zeitlupe.
- Startet ein Spiel nicht (falsche Konsole, beschädigte Datei), erscheint eine Meldung mit
  „Erneut versuchen“ und „Zur Bibliothek“.

## Spielstände

Alle Spielstände liegen auf dem Server in `saves/<ordner>/` – nicht im Browser.

| Art | Was | Datei | Wann gesichert |
|---|---|---|---|
| Spielinterner Speicher | das „Speichern“ im Spiel selbst (z. B. im Pokémon-Menü) | `<rom>.srm` | automatisch alle 10 Sekunden bei Änderungen und beim Verlassen |
| Speicherstand | Menü ☰ → „Save State“ / „Load State“ | `<rom>.state` | sofort beim Speichern |

- **Beim Start** wird der Stand vom Server geladen. Ist der Server nicht erreichbar, startet das Spiel gar
  nicht erst – so entstehen keine Spielstände, die nirgends gesichert sind.
- **Anzeige** im Knopf oben rechts: grüne Wolke = gesichert, gelb = speichert gerade, rot
  **„☁ nicht gesichert!“** = keine Verbindung.
- **Funkloch:** Der letzte noch nicht hochgeladene Stand bleibt als Notkopie im Browser und wird beim
  nächsten Spielstart automatisch nachgereicht.
- **Ein frisch gestartetes Spiel überschreibt nie einen Stand auf dem Server** – hochgeladen wird erst, wenn
  sich im Spiel tatsächlich etwas ändert.
- **Ältere Versionen:** Bevor ein Stand überschrieben wird, legt der Server den alten in
  `saves/<ordner>/.versionen/` ab (höchstens eine Version alle 10 Minuten, die letzten 20 bleiben).
  Zurückholen: gewünschte Datei zurückkopieren und die Endung mit dem Zeitstempel entfernen.
- In der Bibliothek zeigt *☁ Spielstand*, für welche Spiele schon etwas gesichert ist.

## Im Auto (Android Automotive)

Ausgelegt auf Chrome im BYD Atto 3 Evo; gilt für Android Automotive allgemein.

- **Nur im Stand:** Chrome auf Android Automotive sperrt Inhalte während der Fahrt.
- **Als App aufs Display legen:** In Chrome „Zum Startbildschirm hinzufügen“ – startet dann im Vollbild
  ohne Adressleiste. Das geht nur mit [HTTPS](#https-einrichten).
- **Datenvolumen:** ROMs werden beim ersten Start über das Mobilfunknetz geladen (SNES wenige MB,
  N64 8–64 MB, DS bis über 100 MB) und danach vom Browser zwischengespeichert. Gezippte ROMs sparen Volumen.
- **Leistung:** NES, SNES, Game Boy und GBA brauchen wenig Rechenleistung. N64 und vor allem
  Nintendo DS brauchen deutlich mehr Rechenleistung; im Auto-Browser kann es ruckeln.
- **Ton:** Der Tonpuffer ist auf 128 ms erhöht (EmulatorJS-Standard: 64 ms), damit der Ton auf schwächeren
  Geräten nicht knackt. Ruckelt er trotzdem, schafft das Gerät das Spiel nicht in voller Geschwindigkeit.
- **Controller:** Ob sich ein Bluetooth-Controller mit dem Auto koppeln lässt, hängt vom Fahrzeug ab.
  Falls Chrome ihn nicht erkennt, zuerst HTTPS einrichten.

## HTTPS einrichten

Ohne HTTPS funktionieren „Display bleibt an“ und „Zum Startbildschirm hinzufügen“ nicht, und das Passwort
geht unverschlüsselt über das Mobilfunknetz. Ist der Server aus dem Internet erreichbar, daher unbedingt
HTTPS **und** Passwortschutz einrichten.

1. Eine Domain auf den Server zeigen lassen (z. B. `retro.example.de`).
2. Ein Zertifikat besorgen, z. B. kostenlos von Let's Encrypt:
   - Windows: [win-acme](https://www.win-acme.com) – erzeugt PEM-Dateien und erneuert sie automatisch.
   - Linux: `certbot` – die Dateien liegen dann unter `/etc/letsencrypt/live/<domain>/`.
3. Installer erneut ausführen und bei „HTTPS einrichten“ die Pfade zu Zertifikat (`fullchain.pem`) und
   privatem Schlüssel (`privkey.pem`) angeben.
4. Im Auto `https://<domain>:<port>` öffnen – die Domain des Zertifikats, nicht die IP-Adresse.

Erneuerte Zertifikate übernimmt der Server alle 12 Stunden ohne Neustart. Unter Linux muss der
Dienstbenutzer die Schlüsseldatei lesen dürfen (Let's-Encrypt-Schlüssel gehören standardmäßig root).

## Einstellungen

Der Installer schreibt `config.json` im Programmordner (Vorlage: `config.example.json`). Änderungen
wirken nach einem Neustart des Servers.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `port` | `8080` | Port |
| `host` | `0.0.0.0` | Netzwerkadresse (`127.0.0.1` = nur vom Server selbst erreichbar) |
| `romDir` | `roms` | ROM-Ordner (relativ zum Programmordner oder absolut) |
| `saveDir` | `saves` | Spielstände (relativ zum Programmordner oder absolut) |
| `authUser` / `authPass` | – | Passwortschutz (HTTP Basic Auth) |
| `httpsCert` / `httpsKey` | – | HTTPS: Zertifikat und Schlüssel als PEM-Dateien |

Umgebungsvariablen haben Vorrang: `PORT`, `HOST`, `ROM_DIR`, `SAVE_DIR`, `AUTH_USER`, `AUTH_PASS`,
`HTTPS_CERT`, `HTTPS_KEY`.

`config.json` enthält das Passwort im Klartext und ist deshalb von Git ausgeschlossen.

### Offline-Betrieb ohne EmulatorJS-CDN

Standardmäßig wird EmulatorJS von `cdn.emulatorjs.org` geladen. Für einen Betrieb ohne diese Verbindung
den `data`-Ordner eines [EmulatorJS-Releases](https://github.com/EmulatorJS/EmulatorJS/releases) nach
`public/emulatorjs/data/` kopieren – der Server erkennt das und liefert ihn selbst aus.

### Anderen Emulator-Kern ausprobieren

Ruckelt ein Spiel, lässt sich ein anderer Kern testen, indem man an die Spieladresse `&core=…` anhängt:

| Konsole | Kerne (erster = Standard) |
|---|---|
| Nintendo DS | `melonds`, `desmume`, `desmume2015` (schneller, ungenauer) |
| Nintendo 64 | `mupen64plus_next`, `parallel_n64` |
| NES | `fceumm`, `nestopia` |

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| Spiel startet nicht, Meldung „Spiel konnte nicht gestartet werden“ | Datei beschädigt oder keine ROM dieser Konsole. Ein DS-Spiel ist z. B. kein Game-Boy-Spiel – die Endung im ZIP prüfen. |
| „Server nicht erreichbar“ beim Start | Internetverbindung im Auto prüfen, „Erneut versuchen“ tippen. |
| Rote Wolke „☁ nicht gesichert!“ | Verbindung zum Server weg. Weiterspielen geht; die Notkopie wird beim nächsten Start nachgereicht. Nicht die Browserdaten löschen, solange die Wolke rot ist. |
| Kein Ton | Einmal aufs Display tippen – Chrome gibt den Ton erst nach einer Berührung frei. |
| Ton ruckelt / Spiel langsam | Das Gerät schafft das Spiel nicht in voller Geschwindigkeit (v. a. N64/DS). Anderen [Kern](#anderen-emulator-kern-ausprobieren) probieren. |
| Bildschirmtasten verschwinden nicht mit Controller | Einmal eine Taste am Controller drücken. Hilft das nicht: HTTPS einrichten. |
| Auto erreicht den Server nicht | Firewall-Freigabe (Installer als Administrator) bzw. Portweiterleitung im Router prüfen. |
| „Port ist belegt“ | Anderen Port wählen – Installer erneut ausführen. |
| Spiel fehlt in der Bibliothek | Dateiendung prüfen (siehe [ROMs ablegen](#roms-ablegen)); Seite neu laden. |

Der Server schreibt Meldungen in sein Konsolenfenster (Windows) bzw. ins Journal (Linux).

## Aufbau

```
server.js              Webserver: Oberfläche, ROM-Liste, ROM-Dateien, Spielstände (nur Node.js-Bordmittel)
public/index.html      Spielebibliothek (app.js, style.css)
public/play.html       Spielseite (play.js): startet EmulatorJS, synchronisiert Spielstände,
                       blendet Bildschirmtasten bei Controller aus
public/manifest.webmanifest   App-Installation ("Zum Startbildschirm hinzufügen")
install.bat/.ps1       Installer Windows (installieren, aktualisieren, entfernen)
install.sh             Installer Linux / Raspberry Pi
tools/release.js       Release auf GitHub veröffentlichen
config.example.json    Vorlage für config.json
roms/<konsole>/        ROMs (nicht im Repository)
saves/<ordner>/        Spielstände (nicht im Repository)
```

### Schnittstellen

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/roms` | Bibliothek: Spiele je Konsole mit Ablageordner, Titel, Cover, Spielstand ja/nein |
| `GET` | `/api/config` | Pfad zu EmulatorJS (lokal oder CDN) |
| `GET` | `/roms/<ordner>/<datei>` | ROM-Datei (mit Range-Unterstützung) |
| `GET`/`PUT` | `/api/saves/<ordner>/<datei>/sram` | spielinterner Speicher |
| `GET`/`PUT` | `/api/saves/<ordner>/<datei>/state` | Speicherstand |

Spielstände werden nur für ROMs angenommen, die tatsächlich im ROM-Ordner liegen, und atomar geschrieben
(erst vollständig empfangen, dann ersetzt). Mit Passwortschutz gilt die Anmeldung für alle Pfade.

## Release veröffentlichen

```
node tools/release.js
```

pusht den aktuellen Stand von `main`, setzt den Versions-Tag, baut das Download-Paket
`RetroGarage-<version>.zip` und legt das Release auf GitHub an. Die Version ist das Datum plus eine
laufende Nummer des Tages (z. B. `v2026.10.19.1`). Die Release-Notizen werden aus den Commits seit dem
letzten Release gebildet; eigene Notizen mit `--notes "…"` oder `--notes-file datei.md`. Mit `--dry-run`
zeigt das Skript nur an, was passieren würde.

Das Paket enthält nur eingecheckte Dateien – ROMs, Spielstände und `config.json` gelangen nie hinein.
Voraussetzung: alle Änderungen committet und die GitHub-Kommandozeile angemeldet (`gh auth login`).

## Rechtliches

- Retro Garage steht unter der [MIT-Lizenz](LICENSE).
- **ROMs sind nicht enthalten.** Nur Spiele verwenden, die man besitzt und rechtmäßig sichern darf.
- [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) steht unter der GPL-3.0 und wird zur Laufzeit vom
  CDN geladen; die enthaltenen Emulatoren haben jeweils eigene Lizenzen.
- Nintendo, Game Boy, Super Nintendo, Nintendo 64 und Nintendo DS sind Marken von Nintendo. Dieses
  Projekt steht in keiner Verbindung zu Nintendo.

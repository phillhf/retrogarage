<#
.SYNOPSIS
  Retro Garage unter Windows installieren, aktualisieren (erneut ausführen) oder mit -Uninstall entfernen.

.DESCRIPTION
  Fragt Installationsort, Port, ROM-Ordner und optionalen Passwortschutz ab, prüft Node.js
  (installiert es bei Bedarf über winget), kopiert das Programm und legt config.json an.
  Mit Administratorrechten zusätzlich: Hintergrunddienst beim Systemstart und Firewall-Freigabe.

  Start per Doppelklick auf install.bat oder:
    powershell -ExecutionPolicy Bypass -File install.ps1
  Ohne Rückfragen:
    install.ps1 -InstallDir D:\RetroGarage -Port 8090 -RomDir E:\ROMs -Service -Firewall -Unattended
#>
param(
    [string]$InstallDir,
    [int]$Port = 0,
    [string]$RomDir,
    [string]$SaveDir,         # Spielstände (Standard: <Installationsort>\saves)
    [string]$User,            # Passwortschutz: Benutzername ...
    [string]$Password,        # ... und Passwort (beides leer = kein Schutz)
    [string]$HttpsCert,       # HTTPS: Zertifikat (PEM, z. B. fullchain.pem) ...
    [string]$HttpsKey,        # ... und privater Schlüssel (PEM, z. B. privkey.pem)
    [switch]$Service,         # als Hintergrunddienst beim Systemstart (Administrator)
    [switch]$Firewall,        # Port in der Windows-Firewall freigeben (Administrator)
    [switch]$Autostart,       # ohne Dienst: beim Anmelden starten
    [switch]$NoShortcut,      # keine Desktop-Verknüpfungen
    [switch]$Unattended,      # keine Rückfragen, Standardwerte verwenden
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
trap { Write-Host "`nFehler: $_" -ForegroundColor Red; exit 1 }
$Source = $PSScriptRoot
$AppName = 'Retro Garage'
$TaskName = 'RetroGarage'
$DefaultDir = Join-Path $env:SystemDrive 'RetroGarage'
$DefaultPort = 8080
$MinNode = 18
$Systems = 'gb', 'gbc', 'gba', 'nes', 'snes', 'n64', 'nds'
$Desktop = [Environment]::GetFolderPath('Desktop')
$Startup = [Environment]::GetFolderPath('Startup')
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

function Ask($question, $default) {
    if ($Unattended) { return $default }
    $answer = Read-Host "$question [$default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

function Ask-Int($question, [int]$default) {
    while ($true) {
        $number = 0
        if ([int]::TryParse((Ask $question $default), [ref]$number)) { return $number }
        Write-Warning 'Bitte eine Zahl eingeben.'
    }
}

function Ask-YesNo($question, [bool]$default) {
    if ($Unattended) { return $default }
    $hint = if ($default) { 'J/n' } else { 'j/N' }
    $answer = Read-Host "$question [$hint]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim().ToLower().StartsWith('j')
}

function Test-PortFree([int]$candidate) {
    # Schlägt auch bei Ports fehl, die Windows reserviert hat
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $candidate)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch { return $false }
}

function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    $text = & $node.Source --version 2>$null
    if ($text -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Stop-RetroGarage($dir, [int]$port) {
    # Laufende Instanz anhalten, damit Port und Dateien frei werden
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    $script = (Join-Path $dir 'server.js')
    # Erkennung über den Pfad im Aufruf oder über den konfigurierten Port (Pfad kann als Kurzname/relativ angegeben sein)
    $portOwners = @()
    if ($port) {
        $portOwners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess)
    }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($script) -or
            (($portOwners -contains $_.ProcessId) -and $_.CommandLine -match 'server\.js')) } |
        ForEach-Object {
            Write-Host "Beende laufende Instanz (PID $($_.ProcessId))."
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    Start-Sleep -Milliseconds 500
}

function New-Shortcut($path, $target, $workDir, $arguments = '') {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $target
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $workDir
    $shortcut.Description = $AppName
    $shortcut.Save()
}

function Read-Config($dir) {
    $path = Join-Path $dir 'config.json'
    if (-not (Test-Path $path)) { return $null }
    try { return [System.IO.File]::ReadAllText($path) | ConvertFrom-Json } catch {
        Write-Warning "Vorhandene config.json ist fehlerhaft und wird neu angelegt."
        return $null
    }
}

function Resolve-DataDir($value, $dir, $default) {
    # romDir/saveDir aus config.json: absolut oder relativ zum Installationsort (wie im Server)
    if (-not $value) { return Join-Path $dir $default }
    if ([System.IO.Path]::IsPathRooted($value)) { return [System.IO.Path]::GetFullPath($value) }
    return [System.IO.Path]::GetFullPath((Join-Path $dir $value))
}

function ConvertTo-ConfigPath($path, $dir) {
    # Ordner innerhalb der Installation relativ speichern, damit sich der Ordner verschieben lässt
    $root = $dir.TrimEnd('\')
    if ($path.TrimEnd('\') -ieq $root) { return '.' }
    if (Test-Inside $path $dir) { return $path.Substring($root.Length + 1) }
    return $path
}

function Test-Inside($child, $parent) {
    $c = [System.IO.Path]::GetFullPath($child).TrimEnd('\') + '\'
    $p = [System.IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
    return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

# ------------------------------------------------------------------ Entfernen
if ($Uninstall) {
    if (-not $InstallDir) { $InstallDir = Ask "Installationsort von $AppName" $DefaultDir }
    $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
    if (-not (Test-Path (Join-Path $InstallDir 'server.js'))) { throw "In '$InstallDir' liegt keine $AppName-Installation." }
    if ((Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -and -not $IsAdmin) {
        throw 'Der Hintergrunddienst kann nur als Administrator entfernt werden (install.bat per Rechtsklick "Als Administrator ausführen").'
    }
    $cfg = Read-Config $InstallDir
    $roms = Resolve-DataDir $cfg.romDir $InstallDir 'roms'
    $saves = Resolve-DataDir $cfg.saveDir $InstallDir 'saves'
    if (-not $Unattended -and -not (Ask-YesNo "$AppName in '$InstallDir' entfernen?" $false)) { return }
    # ROMs und Spielstände bleiben erhalten, außer es wird ausdrücklich bestätigt
    $keep = @()
    if ((Test-Inside $roms $InstallDir) -and -not (Ask-YesNo "Auch alle ROMs in '$roms' löschen?" $false)) { $keep += $roms }
    if ((Test-Inside $saves $InstallDir) -and -not (Ask-YesNo "Auch alle SPIELSTÄNDE in '$saves' löschen?" $false)) { $keep += $saves }

    Stop-RetroGarage $InstallDir $(if ($cfg) { [int]$cfg.port } else { 0 })
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host 'Hintergrunddienst entfernt.'
    }
    if ($IsAdmin) { Remove-NetFirewallRule -DisplayName $AppName -ErrorAction SilentlyContinue }
    Remove-Item (Join-Path $Desktop "$AppName.lnk"), (Join-Path $Desktop "$AppName starten.lnk"),
        (Join-Path $Startup "$AppName.lnk") -ErrorAction SilentlyContinue

    Set-Location $env:TEMP   # nicht im zu löschenden Ordner stehen
    # Rekursiv löschen, aber zu behaltende Ordner und ihre übergeordneten Ordner stehen lassen
    function Remove-Except($folder) {
        foreach ($item in Get-ChildItem $folder -Force) {
            if ($keep | Where-Object { Test-Inside $item.FullName $_ }) { continue }
            if ($keep | Where-Object { Test-Inside $_ $item.FullName }) { Remove-Except $item.FullName; continue }
            Remove-Item $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Except $InstallDir
    if (-not (Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue)) { Remove-Item $InstallDir -Force -ErrorAction SilentlyContinue }
    Write-Host "$AppName wurde entfernt."
    foreach ($dir in $keep) { Write-Host "Erhalten: $dir" }
    return
}

# ------------------------------------------------------------------- Abfragen
Write-Host "$AppName - Installation" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $Source 'server.js')) -or -not (Test-Path (Join-Path $Source 'public\index.html'))) {
    throw "install.ps1 muss im $AppName-Ordner liegen (neben server.js und public)."
}
if (-not $IsAdmin) {
    Write-Host 'Hinweis: Ohne Administratorrechte gibt es keinen Hintergrunddienst und keine Firewall-Freigabe.' -ForegroundColor Yellow
    Write-Host '         Dafür install.bat per Rechtsklick "Als Administrator ausführen".' -ForegroundColor Yellow
}

if (-not $InstallDir) { $InstallDir = Ask 'Installationsort' $DefaultDir }
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$InPlace = $InstallDir.TrimEnd('\') -ieq $Source.TrimEnd('\')
$existing = Read-Config $InstallDir
if ($existing) { Write-Host 'Vorhandene Installation gefunden - Einstellungen werden als Vorschlag übernommen.' }
if (Test-Path (Join-Path $InstallDir 'server.js')) { Stop-RetroGarage $InstallDir $(if ($existing) { [int]$existing.port } else { 0 }) }

$suggestedPort = if ($existing -and $existing.port) { [int]$existing.port } else { $DefaultPort }
while ($true) {
    if ($Port -eq 0) { $Port = Ask-Int 'Port der Weboberfläche' $suggestedPort }
    if ($Port -lt 1 -or $Port -gt 65535) {
        Write-Warning "Port $Port liegt außerhalb von 1-65535."
    } elseif (-not (Test-PortFree $Port)) {
        Write-Warning "Port $Port ist belegt oder von Windows reserviert."
    } else { break }
    if ($Unattended) { throw "Port $Port ist nicht verwendbar." }
    $Port = 0
}

$suggestedRoms = Resolve-DataDir $existing.romDir $InstallDir 'roms'
if (-not $RomDir) { $RomDir = Ask 'ROM-Ordner' $suggestedRoms }
$RomDir = [System.IO.Path]::GetFullPath($RomDir)

$suggestedSaves = Resolve-DataDir $existing.saveDir $InstallDir 'saves'
if (-not $SaveDir) { $SaveDir = Ask 'Ordner für Spielstände' $suggestedSaves }
$SaveDir = [System.IO.Path]::GetFullPath($SaveDir)

$authUser = ''
$authPass = ''
if ($User) {
    $authUser = $User
    $authPass = $Password
} elseif (-not $Unattended) {
    $hadAuth = $existing -and $existing.authUser
    if (Ask-YesNo 'Passwortschutz einrichten (empfohlen, wenn aus dem Internet erreichbar)?' ([bool]$hadAuth)) {
        $authUser = Ask 'Benutzername' $(if ($hadAuth) { $existing.authUser } else { 'retro' })
        $secure = Read-Host 'Passwort (leer = bisheriges behalten)' -AsSecureString
        $authPass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        if (-not $authPass -and $hadAuth) { $authPass = $existing.authPass }
        if (-not $authPass) { throw 'Ein Passwort ist erforderlich.' }
    }
} elseif ($existing -and $existing.authUser) {
    $authUser = $existing.authUser
    $authPass = $existing.authPass
}

$certFile = ''
$keyFile = ''
if ($HttpsCert -or $HttpsKey) {
    $certFile = $HttpsCert
    $keyFile = $HttpsKey
} elseif (-not $Unattended) {
    $hadHttps = $existing -and $existing.httpsCert
    Write-Host 'HTTPS wird im Auto-Chrome für "Display bleibt an", App-Installation und verschlüsseltes Passwort gebraucht.'
    Write-Host 'Dafür ist ein Zertifikat für eine Domain nötig (z. B. Let''s Encrypt, etwa mit win-acme).'
    if (Ask-YesNo 'HTTPS mit vorhandenem Zertifikat einrichten?' ([bool]$hadHttps)) {
        $certFile = Ask 'Zertifikat (PEM, z. B. fullchain.pem)' $(if ($hadHttps) { $existing.httpsCert } else { '' })
        $keyFile = Ask 'Privater Schlüssel (PEM, z. B. privkey.pem)' $(if ($hadHttps) { $existing.httpsKey } else { '' })
    }
} elseif ($existing -and $existing.httpsCert) {
    $certFile = $existing.httpsCert
    $keyFile = $existing.httpsKey
}
if ($certFile -or $keyFile) {
    foreach ($file in $certFile, $keyFile) {
        if (-not $file -or -not (Test-Path ([System.IO.Path]::Combine($InstallDir, $file)))) { throw "HTTPS-Datei '$file' nicht gefunden." }
    }
    $certFile = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($InstallDir, $certFile))
    $keyFile = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($InstallDir, $keyFile))
}
$scheme = if ($certFile) { 'https' } else { 'http' }

$wantService = $false
$wantFirewall = $false
if ($IsAdmin) {
    $wantService = $Service -or ((-not $Unattended) -and (Ask-YesNo 'Als Hintergrunddienst beim Systemstart starten?' $true))
    $wantFirewall = $Firewall -or ((-not $Unattended) -and (Ask-YesNo "Port $Port in der Windows-Firewall freigeben (Zugriff aus dem Netz/Auto)?" $true))
} elseif ($Service -or $Firewall) {
    throw '-Service und -Firewall brauchen Administratorrechte.'
}
$wantAutostart = (-not $wantService) -and ($Autostart -or ((-not $Unattended) -and (Ask-YesNo 'Beim Anmelden automatisch starten?' $false)))
$wantShortcut = (-not $NoShortcut) -and (Ask-YesNo 'Desktop-Verknüpfungen anlegen?' $true)

# -------------------------------------------------------------------- Node.js
Write-Step 'Node.js'
if ((Get-NodeMajor) -lt $MinNode) {
    Write-Host "Node.js $MinNode oder neuer wurde nicht gefunden."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget -and (Ask-YesNo 'Node.js LTS jetzt über winget installieren (stimmt dessen Lizenzbedingungen zu)?' $true)) {
        & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements | Out-Host
        Update-Path
    }
    if ((Get-NodeMajor) -lt $MinNode) { throw "Bitte Node.js $MinNode+ von https://nodejs.org installieren und den Installer erneut starten." }
}
$NodeExe = (Get-Command node).Source
Write-Host "Verwende $NodeExe ($(& $NodeExe --version))"

# -------------------------------------------------------------------- Dateien
Write-Step "Programmdateien nach $InstallDir"
if ($InPlace) {
    Write-Host 'Installation im Quellordner - nichts zu kopieren.'
} else {
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    # /XO: neuere Dateien am Ziel bleiben erhalten (z. B. eine lokale EmulatorJS-Kopie)
    robocopy (Join-Path $Source 'public') (Join-Path $InstallDir 'public') /E /XO /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopieren von 'public' fehlgeschlagen (robocopy $LASTEXITCODE)." }
    foreach ($file in 'server.js', 'covers.js', 'package.json', 'README.md', 'LICENSE', 'start.bat', 'install.ps1', 'install.bat', 'config.example.json') {
        $from = Join-Path $Source $file
        if (Test-Path $from) { Copy-Item $from $InstallDir -Force }
    }
}
foreach ($system in $Systems) {
    New-Item -ItemType Directory -Force (Join-Path $RomDir $system), (Join-Path $SaveDir $system) | Out-Null
}
Write-Host "ROM-Ordner:   $RomDir"
Write-Host "Spielstände:  $SaveDir"

# ------------------------------------------------------------- Konfiguration
Write-Step 'Konfiguration'
$configPath = Join-Path $InstallDir 'config.json'
$config = [ordered]@{ port = $Port; host = '0.0.0.0' }
$config.romDir = ConvertTo-ConfigPath $RomDir $InstallDir
$config.saveDir = ConvertTo-ConfigPath $SaveDir $InstallDir
if ($authUser) { $config.authUser = $authUser; $config.authPass = $authPass }
if ($certFile) { $config.httpsCert = $certFile; $config.httpsKey = $keyFile }
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), $Utf8)
Write-Host "config.json geschrieben (Port $Port$(if ($authUser) { ', Passwortschutz aktiv' })$(if ($certFile) { ', HTTPS' }))."

# ------------------------------------------------------- Dienst und Firewall
if ($wantService) {
    Write-Step 'Hintergrunddienst'
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    $action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$(Join-Path $InstallDir 'server.js')`"" -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description "$AppName Emulator-Server (Port $Port)" | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Aufgabe '$TaskName' angelegt und gestartet (läuft als SYSTEM, startet beim Hochfahren)."
} elseif ($IsAdmin -and (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host 'Bisheriger Hintergrunddienst entfernt.'
}

if ($IsAdmin) {
    Remove-NetFirewallRule -DisplayName $AppName -ErrorAction SilentlyContinue
    if ($wantFirewall) {
        Write-Step 'Firewall'
        New-NetFirewallRule -DisplayName $AppName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
        Write-Host "Eingehender TCP-Port $Port freigegeben."
    }
}

# ------------------------------------------------------------ Verknüpfungen
$starter = Join-Path $InstallDir 'start.bat'
Remove-Item (Join-Path $Desktop "$AppName.lnk"), (Join-Path $Desktop "$AppName starten.lnk"),
    (Join-Path $Startup "$AppName.lnk") -ErrorAction SilentlyContinue
if ($wantShortcut) {
    $browser = Join-Path $env:WINDIR 'explorer.exe'
    New-Shortcut (Join-Path $Desktop "$AppName.lnk") $browser $InstallDir "${scheme}://localhost:$Port"
    if (-not $wantService) { New-Shortcut (Join-Path $Desktop "$AppName starten.lnk") $starter $InstallDir }
}
if ($wantAutostart) { New-Shortcut (Join-Path $Startup "$AppName.lnk") $starter $InstallDir }

# -------------------------------------------------------------------- Fertig
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress
Write-Host "`nFertig." -ForegroundColor Green
if ($wantService) {
    Write-Host '  Läuft bereits im Hintergrund.'
} else {
    Write-Host "  Starten:       $starter"
}
Write-Host "  Oberfläche:    ${scheme}://localhost:$Port"
if ($certFile) {
    Write-Host "  Im Auto:       https://<deine-domain>:$Port  (Domain des Zertifikats, nicht die IP)"
} else {
    foreach ($ip in $ips) { Write-Host "  Im Netz/Auto:  http://${ip}:$Port" }
}
Write-Host "  ROMs ablegen:  $RomDir\<gb|gbc|gba|nes|snes|n64|nds>"
Write-Host "  Spielstände:   $SaveDir  (ältere Versionen jeweils im Unterordner .versionen)"
Write-Host "  Einstellungen: $configPath (oder Installer erneut ausführen)"
Write-Host "  Entfernen:     install.bat -Uninstall"

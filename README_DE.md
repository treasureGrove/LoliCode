# LoliCode

[English](README.md) · [简体中文](README_ZH.md) · [日本語](README_JA.md)

**Ein einfach bedienbarer, erweiterbarer Agent mit Anime-Mädchen-Design.**

LoliCode verbindet einen Desktop-Agenten für Programmierung, gemeinsame Modellzugänge und eine Arbeitsumgebung im Anime-Stil. Modell auswählen, Projektordner öffnen und loslegen; erweiterte Einstellungen stehen bei Bedarf bereit.

[Download](https://tools.treasuregrove.art/lolicode/) · [Community und Konto](https://lolicode.com) · [Quellcode](https://github.com/treasureGrove/LoliCode) · [Dokumentation](docs/README.md) · [Änderungen](CHANGELOG.md)

## Bereits verfügbar

- **Ein zentraler Agent:** gestreamte Gespräche, Projektdateien, Terminalwerkzeuge, Berechtigungsabfragen, Rückfragen und Auswahlmöglichkeiten, Abbruch, Gesprächsverlauf und Änderungsansicht.
- **Gemeinsame Modelle und Zugänge:** API-Anbieter, unterstützte Kontoanmeldungen, Modellverzeichnisse und verfügbare Modelloptionen verwalten. Kontextgrenzen und Denkstufen hängen von den Angaben und Fähigkeiten des jeweiligen Dienstes ab.
- **Zentrale Konfiguration:** Anbieter, Prompts, Skills und MCP-Konfiguration für unterstützte externe KI-Werkzeuge. Konfigurationsverwaltung und Ausführung durch den integrierten Agenten werden getrennt ausgewiesen.
- **Ein Desktop mit Charakter:** Anime-Design, ein rosahaariges Chibi-Maskottchen, kompakte Werkzeugfortschritte und Dateivorschau in einer Seitenleiste.
- **Verbrauch und Updates:** erfasste Nutzung anzeigen und eigenständige LoliCode-Updates prüfen. Das Community-Konto ist von den Konten der Modellanbieter getrennt.

Die aktuelle Anwendung verwendet **Tauri 2, React, TypeScript und Rust**. Der Standard-Agent läuft als Rust-Kern innerhalb der Anwendung; eine separate Installation von OpenCode oder ZCode ist nicht erforderlich. Details stehen in der [Beschreibung des aktuellen Agenten](docs/guides/lolicode-inprocess-agent.md).

Windows, macOS und Linux sind Zielplattformen. Derzeit sind **Windows-x64-NSIS-Installer und portable ZIPs** veröffentlicht; Pakete für macOS und Linux stehen noch aus. Der geprüfte Umfang steht in den jeweiligen Versionshinweisen.

## Installation und erster Start

1. Ein passendes Paket von der [LoliCode-Downloadseite](https://tools.treasuregrove.art/lolicode/) herunterladen.
2. In der Modell- und Zugangsverwaltung einen Zugang hinzufügen und ein Modell auswählen.
3. Im Arbeitsbereich einen Projektordner öffnen, eine Aufgabe beschreiben und Berechtigungen sowie Änderungen prüfen.

Updates lassen sich über das Avatar-Menü unten links oder den Update-Eintrag prüfen. Die installierte Ausgabe verwendet das [signierte LoliCode-Update-Manifest](https://tools.treasuregrove.art/lolicode/updates/latest.json). Bei portablen Ausgaben die Programmdateien gemäß Downloadseite und Versionshinweisen ersetzen und die eigenen Daten behalten.

Aus Kompatibilitätsgründen bleibt das bisherige Datenverzeichnis `~/.tai-switch` erhalten. Weitere Hinweise enthält die [Installationsanleitung](docs/user-manual/en/1-getting-started/1.2-installation.md).

## Geplante Erweiterungen

**UE-Werkzeuge** und **Tavern-artige Charaktergespräche** sollen als gleichrangige Anwendungen ausgewählte Fähigkeiten desselben Haupt-Agenten nutzen. Dauerhaftes Gedächtnis, Sprache, weitere Maskottchen-Interaktionen und das leichte, auf Frontend und 3D ausgerichtete Modell **sillyLoli** sind weitere Entwicklungsziele.

Diese Funktionen sind noch nicht vollständig ausgeliefert. Wir binden gezielte Fähigkeiten und Komponenten ein. Die vollständigen Programme der Referenzprojekte werden dadurch nicht automatisch übernommen. Siehe [Produktvision](docs/guides/lolicode-product-vision.md), [erster Meilenstein](docs/guides/lolicode-phase-one-plan.md) und [Funktions- und Quellenverzeichnis](docs/guides/lolicode-platform-capabilities.json).

## Lokal entwickeln

Voraussetzungen: Node.js 22.12+ oder eine von Vite unterstützte Version, pnpm 10.12.3, Rust gemäß `rust-toolchain.toml` und die [Tauri-Plattformabhängigkeiten](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/treasureGrove/LoliCode.git
cd LoliCode
pnpm install --frozen-lockfile
pnpm dev
```

Vite aktualisiert das Frontend während der Entwicklung. Rust-Änderungen bauen und starten den Entwicklungsprozess neu; ein neues Installationspaket ist dafür nicht nötig. Auch den Agent-Crate überwachen:

```sh
pnpm dev --additional-watch-folders ../crates/lolicode-agent
```

Prüfungen stehen im [Beitragsleitfaden](CONTRIBUTING.md), Paketbau und Signierung im [Release-Leitfaden](docs/guides/lolicode-release.md).

## Hilfe, Herkunft und Lizenz

Für Rückmeldungen stehen [LoliCode Issues](https://github.com/treasureGrove/LoliCode/issues), [Support](SUPPORT.md), [Sicherheitsrichtlinie](SECURITY.md) und [Verhaltenskodex](CODE_OF_CONDUCT.md) bereit.

LoliCode wird unabhängig gepflegt. Die Konfigurationsgrundlage stammt aus CC Switch; die ursprüngliche [MIT-Lizenz](LICENSE), Urheberrechtshinweise und die [Basisrevision](FORK_BASELINE.md) bleiben erhalten. Weitere übernommene Komponenten stehen in den [Drittanbieterhinweisen](THIRD_PARTY_NOTICES.md). Die Nennung eines Referenzprojekts bedeutet keine vollständige Integration oder Plugin-Kompatibilität.

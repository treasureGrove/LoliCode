# LoliCode

[English](README.md) · [简体中文](README_ZH.md) · [日本語](README_JA.md)

LoliCode ist ein Desktop-Arbeitsplatz für KI-Agenten mit gemeinsamer Modellkonfiguration, lokalen Projektaufgaben, Werkzeugausführung und Ergebnisvorschau.

Die aktuelle Anwendung verwendet Tauri 2, React, TypeScript und Rust. Seit Version 4.0.15 läuft der standardmäßige Coding-Agent als Rust-Kern innerhalb der Anwendung. Eine vollständige OpenCode- oder ZCode-Anwendung muss dafür nicht separat gestartet werden.

## Aktueller Stand und Entwicklungsziel

Vorhanden sind gemeinsame Modellkanäle, Kontoverwaltung, Anbieterkonfiguration, ein Coding-Arbeitsplatz, Werkzeugaufrufe, gespeicherte Sitzungen und die Konfigurationsverwaltung externer KI-Werkzeuge. Die tatsächlich ausführbaren Funktionen werden vom Laufzeitstatus ausgewiesen.

Das Ziel ist Electron mit der bestehenden React-Oberfläche, einem eigenen TypeScript-Host und Agentenkern sowie den vorhandenen Rust-Diensten für Windows, macOS und Linux.

Ein Anwendungszentrum soll benötigte Anwendungen hinzufügen, empfohlene Einstellungen vorbereiten und erweiterte Optionen bei Bedarf zugänglich machen. Dieser Ablauf, die Electron-Migration sowie Tavern- und UE-Funktionen sind noch keine ausgelieferten Funktionen.

## Entwicklung und Dokumentation

~~~sh
pnpm install --frozen-lockfile
pnpm dev
~~~

Anforderungen an Node.js, pnpm und Rust sowie Prüfkommandos stehen in der [englischen README](README.md).

- [Download](https://tools.treasuregrove.art/lolicode/)
- [Architektur und Migrationsplan](docs/guides/lolicode-platform-architecture.md)
- [Funktions-, Herkunfts- und Lizenzübersicht](docs/guides/lolicode-platform-capabilities.json)
- [Prüfnachweise für 4.0.15](docs/guides/lolicode-4.0.15-delivery.md)

Die bisher dokumentierte Paketprüfung betrifft Windows. Veröffentlichungen von CC Switch sind keine LoliCode-Pakete.

## Herkunft und Lizenz

Dieses Repository wird unabhängig gepflegt. Die Konfigurationsbasis stammt aus CC Switch; die ursprüngliche [MIT-Lizenz](LICENSE) und die Urheberhinweise bleiben erhalten. Die genaue Ausgangsversion ist in [FORK_BASELINE.md](FORK_BASELINE.md) dokumentiert.

Die Nennung eines Referenzprojekts bedeutet nicht, dass dessen Quellcode oder vollständige Anwendung eingebunden ist. Bei einer Codeübernahme werden die Bedingungen der jeweiligen Dateien und Abhängigkeiten gesondert erfasst.

# TAI Switch contributor guide

Read TASKBOOK.md before changing scope. M0 targets Windows, Chat Completions and Cherry Studio.
Allow user-selected free and paid models, multiple models per channel, and explicit per-model prices/free quota settings.
Use high precision decimals for USD. Missing usage/prices must remain unknown. Quota consumption and request costs must commit atomically.
Preserve the legacy art.treasuregrove.freehub app identifier, data directory, database filename and vault service so upgrades keep existing keys.
Keep all upstream credentials in Windows Credential Manager, never SQLite, logs, fixtures or source.
Do not log request/response bodies or raw upstream errors. Use safe error categories.
Bind the gateway only to 127.0.0.1. Authenticate models and inference before contacting upstream.
Do not modify other applications' configuration or enable paid models automatically.
Run gateway tests, cargo fmt/check, frontend typecheck/build and desktop compilation before delivery.
Record real-provider and real-client acceptance separately from mock tests. Never mark unrun checks passed.
Keep server publishing separate from desktop inference. Preserve user changes and backups.

# FreeHub contributor guide

Read TASKBOOK.md before changing scope. M0 targets Windows, Chat Completions and Cherry Studio.
Keep all upstream credentials in Windows Credential Manager, never SQLite, logs, fixtures or source.
Do not log request/response bodies or raw upstream errors. Use safe error categories.
Bind the gateway only to 127.0.0.1. Authenticate models and inference before contacting upstream.
Do not modify other applications' configuration or enable paid models automatically.
Run gateway tests, cargo fmt/check, frontend typecheck/build and desktop compilation before delivery.
Record real-provider and real-client acceptance separately from mock tests. Never mark unrun checks passed.
Keep server publishing separate from desktop inference. Preserve user changes and backups.

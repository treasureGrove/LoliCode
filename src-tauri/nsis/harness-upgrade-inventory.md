# Windows Harness upgrade inventory

`lolicode-harness-legacy.gz` lists the relative paths and SHA-256 digests of obsolete files shipped in the published 1.1.0 and 1.1.1 Harness rc.1 payloads and the 1.1.2 Harness rc.2 payload. It is a gzip-compressed, UTF-8, tab-separated list. The first column is the path under `agent/harness-runtime` and subsequent columns are the accepted digests for that file.

The two official portable baselines have SHA-256 digests `c6621dbf75d00ee35806ef5d19f5401f0d684a6117523031df61a8f62cfb0251` and `e9140fd25990571992387a338cdcb398c50f483b9ae6f787702d470eae13463c`. Their runtime file paths agree. The inventory covers 45,736 paths absent from the bundled rc.2 file inventory.

The published 1.1.2 portable ZIP (SHA-256 `ffcd4d2b574e0ee0cf7803ff99772f6a694b449070a7920ca5cc2c0b81f332f4`) adds 1,027 paths removed by the 1.1.3 distribution policy. The combined inventory has 46,763 paths.

A build produces `installer-files.gz` from the exact post-pruning payload. NSIS runs reconciliation after resource extraction, before recording install success.

Reconciliation removes a listed file only when its path is absent from the new payload and its bytes match a published baseline. It skips links and preserves unknown or modified files. Empty directories are removed only after a managed removal. A retry can continue an interrupted reconciliation.

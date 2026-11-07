# Native GUI smoke: test-instrumented, not release acceptance

This opt-in workflow runs only on `test/native-gui-smoke-20261107` in
`treasureGrove/LoliCode`, including manual dispatch. It uses disposable
GitHub-hosted macOS 15 ARM64, macOS 15 Intel, and Ubuntu 22.04 x64 machines.

It prepares the pinned Harness and agent assets, then **recompiles native debug
code** with development identity and the exact workflow SHA.
`tauri dev --no-watch --exit-on-panic` loads an independently overlaid,
loopback-only Vite server into real WKWebView/WebKitGTK. It does not reuse the
validation package, inject a runtime source-path override, or claim the renderer
is identical to a formal package. `LOLICODE_DEV_SOURCE_DIR` is supplied at
compilation, not used to bypass its compile-time-only design. No native product
interfaces or files are changed.

The renderer has test instrumentation and a signed-out account fixture. Native
`get_build_info`, `get_agent_status`, window visibility and process exit are
real. The smoke checks exact development profile/revision, Harness availability,
a visible root and controls with nonzero geometry across two animation frames,
settings navigation, English/Chinese language changes and translated copy, then
actual Agent -> Tavern -> Agent visibility. It enables Tavern through the normal
DOM control in the fresh profile. No conversation is sent, no model credentials
are installed, and no external model is called. This is not image/screenshot
comparison or an OS accessibility click test. Account/network, model inference,
installers, signatures, notarization, distribution, user devices and production
renderer acceptance remain outside this check.

Application HOME, CC_SWITCH_TEST_HOME, XDG directories, temp files, profile and
native build outputs live in a new runner temporary directory. Toolchain
installation locations remain read from the job's Rust/Cargo homes. macOS
frameworks may use the disposable runner user's default Library for WebView
caches despite HOME overrides: VM disposal, not CC_SWITCH_TEST_HOME alone, is
that cache isolation boundary. Nothing runs on the owner's computer. Linux
starts the entire harness and native child under the same `dbus-run-session` and
`xvfb-run`. macOS requires WindowServer. Any system permission, TCC or
Gatekeeper prompt is a blocker: do not grant, automate, or bypass it. A prompt
preventing the checks from finishing must fail the deadline.

The per-run random nonce, exact SHA, ordered success phases, and normal
native/CLI exit 0 are all required. IPC, DOM polling, report requests,
build/process lifetime, and cleanup have deadlines. Cleanup targets only this
invocation's detached process group. No killall or system security changes. Logs
are not uploaded or printed by the GUI runner. Only allowlisted pass/failure
stages, checkpoint names, error codes and exact SHA summaries are written to
stdout, GitHub annotations and the job summary. Arbitrary exception messages,
paths, DOM text and private logs are excluded; there is no artifact upload,
release, tag, feed, site update, or downloadable binary.

Run portable contracts locally with:
`node --test scripts/tests/native-gui-smoke.test.mjs`. Native GUI execution
deliberately refuses non-hosted/local machines. Passing the portable contracts
is not evidence that the hosted GUI check has run or passed.

The initial e2fdf1a run used a simplified test window and does not cover
production native titlebar/traffic-light geometry. Subsequent smoke windows
clone the original main-window configuration and override only title and
visibility. Even then this DOM smoke does not assert native titlebar pixel
geometry or replace visual review. Private build/application logs remain only in
the disposable runner temporary directory. Old failed runs remain failed; adding
safe diagnostics does not establish their cause or turn those runs into GUI
passes.

The fresh Tavern profile deliberately has no model or story. Its expected loaded
UI is the model-configuration hint, not the story-selection hint. The smoke still
requires a successful native empty snapshot and accepts only the exact native
missing-model catalog error defined in the source. Any other catalog error, an
unexpected configured model, a loading placeholder, or a failed snapshot fails.
No model is installed, configured or called to make this assertion pass.

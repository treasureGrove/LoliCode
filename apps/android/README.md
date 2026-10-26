# LoliCode Android companion

Native Kotlin + Jetpack Compose client, package `art.treasuregrove.lolicode.mobile`.
Current development version: **0.1.0-alpha.4** (`versionCode=4`). This project is independent
of the desktop application's version and native build. Previously published test APKs are available from
[the Android download page](https://lolicode.com/mobile/).

The computer owns tasks, models and model credentials. The phone connects to a
desktop, lists its projects/models and its own sessions, sends tasks, reads live
snapshots, stops tasks, answers questions, replies to one-time approvals and views
text/file differences. The first desktop background policy disables terminal
commands and interactive desktop tools. It must never activate a desktop window.

Alpha.4 uses the same LoliCode account to discover computers and request explicit
desktop approval. Passwords are submitted once and never persisted. Forum tokens,
per-account P-256 private PKCS8 keys and saved room credentials are sealed by an
AndroidKeyStore AES key. Short-lived device tickets remain in memory. Accounts,
computer caches, navigation and task drafts are isolated; logout closes runtime
connections immediately. Existing QR credentials remain sealed, but the new UI
does not expose QR enrollment or assign old rooms to an account.

Task traffic is **direct only**, using native WebRTC SCTP/DTLS and the existing
authenticated AES-GCM task packets. The account service carries discovery and
encrypted offer/answer signaling only. The fixed STUN endpoint is
`stun:lolicode.com:3478`; there is no TURN or task-data WebSocket fallback. A native
DataChannel must actually open and pass the normal host status check before tasks
become available. Networks that cannot establish a direct route fail visibly.

`io.github.webrtc-sdk:android:150.7871.04` is pinned. Its Maven artifact declares
BSD-3-Clause; upstream WebRTC third-party notices and their source/hash are bundled
under `app/src/main/assets/licenses/`. JNI classes are retained by R8. The SDK
exposes the received channel label but no DCEP protocol getter: desktop creates
the fixed protocol, while Android checks label, DTLS and authenticated task status.
The debug app uses `.debug` so native tests can coexist with a signed installation.

Physical MI 8 Lite testing proved two real native peers can exchange authenticated
packets over host-candidate UDP, with 1,064 signaling bytes, 785 encrypted direct
bytes and zero task WebSocket bytes. This is not proof of Wi-Fi/mobile NAT traversal.
The initial phone/Rust host-only attempt failed between different network prefixes;
do not describe that attempt as a successful cross-network connection.
Android 35's read-only emulator subsequently completed a real native Rust/Android
20 KiB exchange in each direction, with 55,265 encrypted direct bytes and exactly
two HTTP SDP requests. Ten Compose interaction tests plus native and Keystore
instrumentation passed there. The physical phone also passed native and Keystore
tests; its UI run remained pending while its screen was off and was stopped.
JVM account, crypto, strict signaling, no-fallback and compatibility tests total 35.
Pending enrollment polls every three seconds only while the device screen is
visible; other discovery polls every 30 seconds, presence every 60 seconds. Idle
task snapshots are not polled. Automatic control reconnection waits at least
30 seconds; explicit retry is immediate. Native setup failure requires explicit retry.

## Build

The native UI has three bottom-navigation destinations: workbench, tasks and
devices. Task details keep the composer above the keyboard, retain unsent drafts
per computer/session when switching tabs, and disable approvals while offline.
Account devices, notification availability and background-tool limits are on the
devices page. Production screens use actual supplied business state.

The `alpha.3` visual update uses a sakura-pink/lilac palette, quiet star details,
sticker-like surfaces and a floating navigation bar. It reuses the existing brand
character from `src/assets/atelier/companion.png` and avatar from
`src/assets/brand/lolicode-icon.png`, bundled in the APK as
`drawable-nodpi/lolicode_companion.png` and `lolicode_avatar.png`. There are no new
image downloads or network calls. Task, approval, pairing and draft behavior are
unchanged; artwork does not replace connection status or approval details.

The debug-only `UiShowcaseActivity` provides clearly labelled offline sample
states for layout checks. It never creates a transport, credential store or
ViewModel, and is excluded from the release APK. All six native interaction tests
in `app/src/androidTest/` passed for the final `alpha.3` build on the Android 35
emulator, including a 360dp/1.3× font-scale run. Its signed APK also installed and
cold-started successfully. The [signed alpha.3 APK](https://lolicode.com/downloads/android/0.1.0-alpha.3/LoliCode-Android-0.1.0-alpha.3.apk)
was published and fully verified over anonymous HTTPS on 2026-10-26.
Emulator validation is not physical-phone acceptance.

Use JDK 17, Android platform 35 and SDK Build Tools 35.0.0. No NDK is required.
The checked-in Gradle 8.11.1 wrapper pins and verifies the distribution SHA-256.
AGP is 8.9.2; Kotlin and the Compose compiler plugin are both 2.1.20; the Compose
BOM is 2025.04.01. Versions are deliberately pinned, not dynamically resolved.

```powershell
# From apps/android; set these to your own installed toolchain.
$env:JAVA_HOME = 'C:\path\to\jdk-17'
$env:ANDROID_HOME = 'C:\path\to\Android\Sdk'
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease

# On the current development machine, this helper also discovers the isolated
# downloaded toolchain in ../../tmp/android-toolchain without changing global env.
.\build-local.ps1 -Variant Debug -Test
# A separate Codex worktree can explicitly reuse the existing isolated toolchain:
.\build-local.ps1 -Variant Debug -Test -ToolchainRoot 'D:\projectGithub\TAI-Switch\tmp\android-toolchain'
```

Outputs:

- `app/build/outputs/apk/debug/app-debug.apk` — debug-signed development build.
- `app/build/outputs/apk/release/app-release-unsigned.apk` — optimized unsigned
  release for the release owner to sign. No production key is created by this project.
- `app/build/reports/tests/testDebugUnitTest/index.html` — JVM protocol/client tests.

For the authorized Android test release, run `./sign-release.ps1` on Windows after
the release build. It reuses (or creates only when absent) a dedicated RSA-3072
Android application key in `%LOCALAPPDATA%/LoliCode/android-signing/`. Its password
is random, saved only with current-user DPAPI, and passed to signing tools through
the process environment. The directory ACL grants access to the current user and
SYSTEM. Existing keys are preserved. The script keeps the unsigned/debug APKs,
aligns and verifies the signed APK, then prints only public artifact metadata and
certificate fingerprints. This self-signed Android application identity does not
sign or modify Windows installers or the desktop updater.

The local SDK path belongs in ignored `local.properties`, or `ANDROID_HOME`.
Build outputs, private Firebase config, key stores and local IDE files are ignored.
No root desktop script or pnpm workspace setting is needed to build this app.

For opening the independent project, Gradle JDK/SDK selection, offline Compose
previews, USB/Wi-Fi device debugging, breakpoints and Logcat, see
[Android Studio development guide](ANDROID_STUDIO.md). `open-studio.ps1 -DryRun`
only discovers an installed IDE; it neither installs software nor launches it.
The static debug previews call `CompanionScreen` with sample state and no runtime
ViewModel, network, Keystore or Firebase. Native UI execution and interaction tests
passed for `alpha.3` on the emulator; Android Studio Preview rendering and
physical-phone QA are still pending.

## Pairing and foreground behavior

1. Open phone pairing on the desktop and scan its short-lived QR with the app's
   offline ZXing scanner, or paste its JSON. The phone never sends the AES key to
   the relay. Treat the pairing QR/JSON as a secret.
2. Confirm the named phone on the desktop. Each phone requires a separate room.
   The QR's five-minute expiry limits a new import only. A saved pending room
   re-authenticates and asks the desktop for its current approval after reconnect,
   including an approval made while the phone was in the background.
3. Select a project/model, create a session and send a task. Desktop execution
   continues when the phone disconnects, is locked, or changes networks.
4. The WebSocket exists only while the Activity is visible and the phone is
   unlocked. Returning to the app reloads sessions and authoritative snapshots;
   mutations are not blindly replayed. Connection failures require checking the
   current task state before sending another task.

Credentials are AES-256-GCM encrypted with an Android Keystore key before entering
SharedPreferences. App backup and device transfer are disabled. Removing a saved
computer deletes local credentials; revoke the pairing on the desktop to close
access server-side as well.

Production pairing accepts only `wss://`. Explicit local development builds can
use `-PcompanionAllowLocalRelay=true` for a local `ws://` relay. This option is off
by default and must remain off for public APKs. No certificate verification is
bypassed. Task text is limited to 20 KiB UTF-8; encrypted plaintext to 30 KiB, frames
to 64 KiB. Larger snapshots must be trimmed and marked `truncated` by the desktop.

## System push is deferred in this test build

This test APK builds without Firebase configuration and displays **系统推送暂未启用**.
There is no claim that phone lockscreen notifications work in this build. Use the
app in the foreground for approvals/progress, then return to refresh after a phone
lock or disconnect. Computer tasks continue independently.

The optional adapter is implemented for later activation:

- Place a real project configuration at ignored `app/google-services.json`, with
  the exact package name above. The Google Services plugin runs only when present.
- Configure the corresponding FCM HTTP v1 provider on the relay; service-account
  credentials stay on the relay and never in the APK.
- The app requests Android 13+ notification permission and registers its FCM token
  over its authenticated relay connection. Missing client or relay configuration
  is reported separately in the UI.
- `CompanionMessagingService` can receive FCM without an Activity/WebSocket.
  `lolicode_tasks` uses private lockscreen visibility. Notices contain generic text
  and opaque IDs, with no command, source code or model key.
- Tapping a notification opens the app after unlock, fetches the current snapshot,
  and checks the approval again before a reply. No approve action is exposed on the
  notification or lockscreen. A provider acceptance receipt is not delivery proof.

No Firebase project/account is created by the build. Real phone lockscreen/Doze,
network changes, notification permission and vendor battery behavior still need
acceptance testing when push work resumes. Both intended Xiaomi/Redmi phones have
Google services; this is not an assurance about all Chinese Android devices.

## Validation scope

The final `alpha.3` visual-update build has been tested on the **Android 35 WHPX
emulator**, using explicitly targeted `emulator-5554` commands only:

- All **6 native UI tests passed** at approximately 393dp width, and all six passed
  again at **360dp with 1.3× font scaling** on the final build.
- All **11 JVM tests passed**. Release lint finished with **0 errors, 13 warnings**:
  ten dependency-update suggestions, one KTX suggestion and two adaptive-icon
  directory/monochrome suggestions.
- The final signed APK (**5,535,942 bytes**) installed and cold-started successfully.
  Its SHA-256 is `1a895a06d4909ad63f63f05d7f499ced6b7e46d2b6c363c545a6f1e596214d75`;
  it reuses the prior Android signing identity. The website APK and companion ZIP
  were published and fully verified over anonymous HTTPS on 2026-10-26; their
  lengths and SHA-256 values exactly match the local artifacts. The prior alpha.2
  download remains available.

No physical phone or actual desktop task was operated in this theme-validation
round. Firebase/system lockscreen push remains deferred.

### Historical alpha.2 baseline

The `alpha.2` native app has actually run on an **Android 35 WHPX emulator** (`emulator-5554`,
1080 × 2400 pixels at 440 dpi). The regular `MainActivity` unpaired screen and the
debug-only sample workbench/approval screens were captured from that running app.
The sample screens visibly identify themselves as offline demonstration data;
they are not evidence of a connected computer or executed remote task.

- All **6 `CompanionUiTest` cases passed** on the emulator: explicit pairing and
  bottom navigation; offline approval gating; one-time approval/rejection; keeping
  a draft until acceptance; retaining a draft across tabs; and clearing it when
  acceptance arrives after switching away.
- All **11 JVM tests passed**, covering a Node-generated AES-GCM interoperability
  vector, direction/AAD, tamper/replay/clock/size rejection, QR expiry/TLS rules,
  snapshot approvals, pairing recovery, and local WebSocket request/response.
- Release lint completed with **0 errors and 11 dependency/KTX warnings**.

The signed `alpha.2` APK was also installed on the emulator and its normal
`MainActivity` cold start succeeded. A recording covers all three tabs and the
pairing dialog's empty-input disabled state/cancel action. These checks did not
connect to a real computer or run a remote task.

The emulator is not a real Redmi/Xiaomi phone. Actual phone pairing, camera and
Keystore behavior, Windows Win+L remote execution and focus behavior still need
end-to-end acceptance. FCM/system lockscreen push remains deferred at the user's
request; neither the UI tests nor the captured samples validate its delivery.

Protocol: `../../docs/architecture/companion-protocol-v1.md`.

Official references: [AGP 8.9 compatibility](https://developer.android.com/build/releases/agp-8-9-0-release-notes),
[Compose compiler plugin](https://kotlinlang.org/docs/compose-compiler-migration-guide.html),
[FCM Android setup](https://firebase.google.com/docs/cloud-messaging/android/get-started),
[ZXing embedded](https://github.com/journeyapps/zxing-android-embedded).

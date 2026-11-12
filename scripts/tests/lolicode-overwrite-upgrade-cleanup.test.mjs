// Pure tests only: never execute the account fixture entrypoint, create an account,
// install a product, modify a real ACL, or stop a process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./lolicode-overwrite-upgrade-account.ps1", import.meta.url),
);
const psSource = readFileSync(scriptPath, "utf8");
const source = readFileSync(
  new URL("./lolicode-overwrite-upgrade-acceptance.mjs", import.meta.url),
  "utf8",
);
function marked(name) {
  const part = source
    .replaceAll("\r\n", "\n")
    .split(`// BEGIN ${name}\n`)[1]
    ?.split(`// END ${name}`)[0];
  assert.ok(part, `Missing marked production function ${name}`);
  return part;
}
const validationSource = marked("PURE CLEANUP VALIDATION");
assert.ok(validationSource);
// Extract only the deliberately marked pure validator; importing the entrypoint
// would run a real acceptance. Use the same Array realm for strict assertions.
const validate = vm.runInThisContext(
  `(function(assert, path) { ${validationSource}; return validateCleanupRecord; })`,
)(assert, path.win32);
const stage = "C:\\Users\\Public\\Documents\\LoliCodeUpgrade-0123456789";
function records() {
  const originalAcl = [
    { path: stage, daclSha256: "a".repeat(64), testSidAceCount: 0 },
  ];
  const identity = {
    accountName: "LCU0123456789",
    accountSid: "S-1-5-21-1-2-3-1001",
    profile: "C:\\Users\\LCU0123456789",
    stage,
    originalAcl,
  };
  return {
    identity,
    record: {
      ...identity,
      completed: true,
      accountRemoved: true,
      profileRemoved: true,
      profileRegistrationRemoved: true,
      profileDirectoryRemoved: true,
      processesCleared: true,
      daclRestored: true,
      stageSidRemoved: true,
      errors: [],
      remainingProcesses: [],
      finalAcl: structuredClone(originalAcl),
    },
  };
}
test("upgrade arguments reject missing or malformed provenance before side effects", () => {
  const parse = vm.runInThisContext(
    `(function() { ${marked("PURE ARGUMENT VALIDATION")}; return parseAcceptanceArgs; })`,
  )();
  assert.equal(parse(["old.exe"], "win32").candidate, undefined);
  assert.equal(
    parse(
      ["old.exe", "new.exe", "source-snapshot.json", "a".repeat(64)],
      "win32",
    ).candidate,
    "new.exe",
  );
  for (const args of [
    [],
    [""],
    ["old.exe", "new.exe"],
    ["old.exe", "new.exe", "source.json"],
    ["old.exe", "", "source.json", "a".repeat(64)],
    ["old.exe", "new.exe", "source.json", "wrong"],
    ["old.exe", "new.exe", "source.json", "a".repeat(64), "extra"],
  ])
    assert.throws(() => parse(args, "win32"), /Usage/);
  assert.throws(() => parse(["old.exe"], "linux"), /Usage/);
  assert.ok(
    source.indexOf("parseAcceptanceArgs(process.argv") <
      source.indexOf("spawnSync("),
  );
  assert.ok(
    source.indexOf("parseAcceptanceArgs(process.argv") <
      source.indexOf("await mkdir(stage)"),
  );
});
test("published baseline bytes select legacy migration or real Harness preservation", () => {
  const { publishedBaseline, validateCandidateVersion } = vm.runInThisContext(
    `(function(assert) { ${marked("PURE RELEASE VALIDATION")}; return { publishedBaseline, validateCandidateVersion }; })`,
  )(assert);
  const legacy = publishedBaseline(
    "e21021377ea8284eb00f73d297700644db76dd41bc93de7d3290833678b018b9",
  );
  const harness = publishedBaseline(
    "f848959df4aca72a924b2fe2e276568bd4058f89f5d648027bbc800527c48a76",
  );
  assert.equal(legacy.engine, "legacy");
  assert.equal(legacy.buildVersion, "4.1.6");
  assert.equal(harness.engine, "harness");
  assert.equal(harness.buildVersion, "1.1.0");
  assert.throws(() => publishedBaseline("a".repeat(64)), /published/);
  const snapshot = (version) => ({
    product: "LoliCode",
    productVersion: version,
    buildVersion: version,
  });
  assert.doesNotThrow(() =>
    validateCandidateVersion(snapshot("1.1.0"), legacy),
  );
  assert.doesNotThrow(() =>
    validateCandidateVersion(snapshot("1.1.1"), legacy),
  );
  assert.doesNotThrow(() =>
    validateCandidateVersion(snapshot("1.1.1"), harness),
  );
  assert.doesNotThrow(() =>
    validateCandidateVersion(snapshot("1.10.0"), harness),
  );
  for (const version of [
    "1.1.0",
    "1.0.6",
    "4.2.0",
    "1.1.1-rc.1",
    "1.01.1",
    "1.1.9007199254740992",
  ]) {
    assert.throws(() => validateCandidateVersion(snapshot(version), harness));
  }
  assert.throws(() =>
    validateCandidateVersion(
      { ...snapshot("1.1.1"), buildVersion: "4.2.0" },
      harness,
    ),
  );
  assert.throws(() =>
    validateCandidateVersion(
      { ...snapshot("1.1.1"), product: "Other" },
      harness,
    ),
  );
  assert.ok(
    source.indexOf("publishedBaseline(baselineHash)") <
      source.indexOf("await mkdir(stage)"),
  );
});
test("a pass requires matching identity, original DACL and every cleanup proof", () => {
  const { identity, record } = records();
  assert.equal(validate(record, identity, stage), record);
  for (const flag of [
    "completed",
    "accountRemoved",
    "profileRemoved",
    "profileRegistrationRemoved",
    "profileDirectoryRemoved",
    "processesCleared",
    "daclRestored",
    "stageSidRemoved",
  ]) {
    assert.throws(
      () => validate({ ...record, [flag]: false }, identity, stage),
      flag,
    );
  }
  assert.throws(() =>
    validate({ ...record, accountSid: "S-1-5-21-1-2-3-999" }, identity, stage),
  );
  assert.throws(() =>
    validate(
      { ...record, remainingProcesses: [{ processId: 123 }] },
      identity,
      stage,
    ),
  );
  assert.throws(() =>
    validate(
      { ...record, finalAcl: [{ ...record.finalAcl[0], testSidAceCount: 1 }] },
      identity,
      stage,
    ),
  );
  assert.throws(() =>
    validate(
      {
        ...record,
        finalAcl: [{ ...record.finalAcl[0], daclSha256: "b".repeat(64) }],
      },
      identity,
      stage,
    ),
  );
  assert.throws(() => validate(undefined, identity, stage));
});

test("cleanup cannot reset ACLs, sweep users or kill the worker's finally", () => {
  assert.doesNotMatch(
    psSource,
    /icacls[^\r\n]*\/(?:reset|remove)|RemoveAccessRuleAll|RemoveAccessRule\(|Stop-Process -Id \$worker/,
  );
  assert.match(psSource, /RemoveAccessRuleSpecific\(\$Context\.grantRule\)/);
  assert.match(
    psSource,
    /Remove-LocalUser -SID \(\[Security\.Principal\.SecurityIdentifier\]\$Context\.testSid\)/,
  );
  assert.match(psSource, /Write-Phase 'cleanup-identity'/);
  assert.match(
    psSource,
    /finally\s*\{\s*if \(\$account\)\s*\{\s*\$cleanup = Complete-IsolatedCleanup/,
  );
  assert.ok(
    source.indexOf('path.join(stage, "acceptance.json")') >
      source.lastIndexOf("if (acceptanceError)"),
  );
});

test("worker reports preserve controller ownership under CREATOR OWNER inheritance", () => {
  const names = [
    "baseline",
    "candidate",
    "restart",
    "reinstall",
    "finished",
    "account-finished",
  ];
  const declared = /const workerRecords = (\[[^;]+\]);/.exec(source);
  assert.ok(declared);
  assert.deepEqual(JSON.parse(declared[1].replace(/,\s*\]/g, "]")), names);
  assert.ok(
    source.indexOf("const workerRecords") < source.indexOf("account = spawn("),
  );
  assert.match(source, /for \(const suffix of \["\.json", "\.json\.tmp"\]\)/);
  assert.match(
    source,
    /JSON\.stringify\(\{ pending: true \}\),\s*\{ flag: "wx" \}/,
  );
  assert.match(source, /record\.pending === true \? undefined : record/);
  const writer = psSource.slice(
    psSource.indexOf("function Write-Phase"),
    psSource.indexOf("function Get-DaclDigest"),
  );
  assert.match(writer, /if \(\$ExpectedSid\) \{ \[IO\.FileMode\]::Open \}/);
  assert.doesNotMatch(
    writer,
    /Move-Item|Copy-Item|Set-Acl|SetOwner|FileMode\]::Create/,
  );
  assert.match(
    psSource,
    /\(\$null -ne \$exitCode -and \$exitCode -ne 0\) -or \$workerRecord\.pending/,
  );
  assert.match(
    psSource,
    /\$workerRecord\.persistedConversationSha256 -notmatch/,
  );
  assert.match(psSource, /if \(\$message\) \{ throw \$message \}/);
});

test(
  "Harness install preservation checks real persisted bytes with mocked OS reads",
  { skip: process.platform !== "win32" },
  () => {
    const program = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:LOLICODE_CLEANUP_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Get-HarnessConversationFiles', 'Assert-PreservedConversationFiles')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (!$function) { throw "Missing $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
$profile = 'C:\Users\fixture-only\.tai-switch'
$sessionId = 'lc:12345678-1234-1234-1234-123456789abc'
$root = Join-Path $profile 'agent\harness-desktop\12345678-1234-1234-1234-123456789abc'
$logs = Join-Path $root 'home\sessions'
$log = Join-Path $logs 'fixture.jsonl.zstd'
$fixtureMetadataPath = Join-Path $profile 'agent\harness-sessions\12345678-1234-1234-1234-123456789abc.json'
$fixtureDesktopPath = Join-Path $root 'desktop.json'
function Get-Content { param($LiteralPath, [switch]$Raw)
    $id = if ($script:scenario -eq 'wrong-id') { 'lc:other' } else { $sessionId }
    if ($LiteralPath -eq $fixtureMetadataPath) { return (@{ session = @{ id = $id }; deleted = ($script:scenario -eq 'deleted') } | ConvertTo-Json -Depth 4) }
    if ($LiteralPath -eq $fixtureDesktopPath) { return (@{ snapshot = @{ session = @{ id = $id } }; rootCreated = ($script:scenario -ne 'no-runtime') } | ConvertTo-Json -Depth 4) }
    throw 'Unexpected content read'
}
function Get-Item { param($LiteralPath, [switch]$Force)
    if ($LiteralPath -notin @($logs, $log, $fixtureMetadataPath, $fixtureDesktopPath)) { throw 'Unexpected file read' }
    if ($script:scenario -eq 'missing' -and $LiteralPath -eq $log) { throw 'Missing log' }
    $attributes = [IO.FileAttributes]::Normal
    if ($script:scenario -eq 'reparse' -and $LiteralPath -eq $log) { $attributes = [IO.FileAttributes]::ReparsePoint }
    [pscustomobject]@{ FullName = $LiteralPath; Name = (Split-Path -Leaf $LiteralPath); PSIsContainer = ($LiteralPath -eq $logs);
        Attributes = $attributes; Length = $(if ($script:scenario -eq 'truncated' -and $LiteralPath -eq $log) { 99 } else { 100 }) }
}
function Get-ChildItem { param($LiteralPath, [switch]$Force)
    if ($LiteralPath -ne $logs) { throw 'Unexpected directory read' }
    if ($script:scenario -ne 'no-native-log') { Get-Item -LiteralPath $log }
}
function Get-FileHash { param($LiteralPath)
    if ($LiteralPath -notin @($log, $fixtureMetadataPath, $fixtureDesktopPath)) { throw 'Unexpected hash read' }
    [pscustomobject]@{ Hash = $(if ($script:scenario -eq 'changed' -and $LiteralPath -eq $log) { 'b' * 64 } else { 'a' * 64 }) }
}
$script:scenario = 'success'
$files = @(Get-HarnessConversationFiles $profile $sessionId)
if ($files.Count -ne 3) { throw 'Native log was not part of the preservation manifest' }
Assert-PreservedConversationFiles $files
foreach ($case in @('wrong-id', 'deleted', 'no-runtime', 'no-native-log', 'reparse', 'missing')) {
    $script:scenario = $case; $failed = $false
    try { $null = @(Get-HarnessConversationFiles $profile $sessionId) } catch { $failed = $true }
    if (!$failed) { throw "Harness capture accepted $case" }
}
foreach ($case in @('changed', 'truncated', 'reparse', 'missing')) {
    $script:scenario = $case; $failed = $false
    try { Assert-PreservedConversationFiles $files } catch { $failed = $true }
    if (!$failed) { throw "Installer preservation accepted $case" }
}
$failed = $false
try { Assert-PreservedConversationFiles @() } catch { $failed = $true }
if (!$failed) { throw 'Empty preservation evidence was accepted' }
'preservation-verified'
`;
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(program, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, LOLICODE_CLEANUP_SCRIPT: scriptPath },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /preservation-verified/);
    assert.match(
      psSource,
      /if \(!\$legacy\) \{ Assert-PreservedConversationFiles \$baselineFiles \}/,
    );
    assert.match(
      psSource,
      /if \(!\$legacy\) \{ Assert-PreservedConversationFiles \$beforeReinstallFiles \}/,
    );
  },
);

test("restart/reinstall require all earlier turns and reject a stale replay", () => {
  const history = vm.runInThisContext(
    `(function(assert) { ${marked("PURE HISTORY VALIDATION")}; return validateFixtureHistory; })`,
  )(assert);
  const fixture = {
    turns: ["baseline", "candidate", "restart", "reinstall"].map((phase) => ({
      phase,
      prompt: `${phase}-question`,
      answer: `${phase}-answer`,
    })),
  };
  const calls = { baseline: 1, candidate: 1, restart: 1, reinstall: 0 };
  const messages = fixture.turns.flatMap((turn, index) => [
    turn.prompt,
    ...(index < 3 ? [turn.answer] : []),
  ]);
  assert.equal(
    history(messages, fixture, calls, "reinstall").phase,
    "reinstall",
  );
  for (const missing of messages.slice(0, -1)) {
    assert.throws(() =>
      history(
        messages.filter((value) => value !== missing),
        fixture,
        calls,
        "reinstall",
      ),
    );
  }
  assert.throws(() =>
    history(messages, fixture, { ...calls, restart: 0 }, "reinstall"),
  );
  assert.throws(() =>
    history(messages.slice(0, -1), fixture, calls, "reinstall"),
  );
  assert.match(source, /modelCalls\[phase\] > callsBefore/);
  assert.match(
    psSource,
    /\$reinstalled\.installerSha256 -cne \$candidate\.installerSha256/,
  );
  assert.match(
    psSource,
    /Assert-PreservedUpgrade 'Post-reinstall conversation'/,
  );
});

test("CDP connect/evaluate/close are bounded without a live browser or socket", async () => {
  class NoResponseSocket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send() {}
    close() {} // Deliberately no close event, as with an unresponsive peer.
  }
  const factory = vm.runInThisContext(
    `(function(assert, WebSocket) { ${marked("BOUNDED CDP CONNECTION")}; return connectCdp; })`,
  );
  const connect = factory(assert, NoResponseSocket);
  const cdp = await connect("ws://127.0.0.1:1234/test", 1234, {
    connectionTimeoutMs: 50,
    callTimeoutMs: 5,
  });
  await assert.rejects(cdp.evaluate("never resolves"), /Timed out/);
  const pending = cdp.evaluate("controller exited", 1000);
  cdp.close();
  await assert.rejects(pending, /socket closed/);
  class NeverOpenSocket extends EventTarget {
    close() {}
  }
  await assert.rejects(
    factory(assert, NeverOpenSocket)("ws://127.0.0.1:1234/test", 1234, {
      connectionTimeoutMs: 5,
    }),
    /Timed out/,
  );
  assert.match(
    source,
    /accountExit\.then\(\s*\(\) => cdp\.close\(\),\s*\(\) => cdp\.close\(\),?\s*\)/,
  );
});

test(
  "real PowerShell cleanup function is fail-closed with all OS operations mocked",
  { skip: process.platform !== "win32" },
  () => {
    const program = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:LOLICODE_CLEANUP_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Complete-IsolatedCleanup' }, $true)
if (!$function) { throw 'Missing cleanup function' }
. ([scriptblock]::Create($function.Extent.Text))
$common = 'C:\Users\Public\Documents'
$profileList = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
$testSid = 'S-1-5-21-1-2-3-1001'
$stage = Join-Path $common 'LoliCodeUpgrade-0123456789'
$fixtureHome = 'C:\Users\LCU0123456789'
$context = @{ accountName = 'LCU0123456789'; testSid = $testSid; expectedProfile = $fixtureHome; profilesRoot = 'C:\Users';
    stage = $stage; previousProcesses = @{}; grantAttempted = $true; grantRule = 'ONLY-OUR-EXACT-GRANT';
    originalAcl = @([pscustomobject]@{ path = $stage; daclSha256 = 'original'; testSidAceCount = 0 }) }
# Mock every OS-accessing command used by Complete-IsolatedCleanup. Any new command
# added to production must be reviewed here before this test is extended.
function Get-TestAccountProcesses { param($Sid, $Previous)
    if ($Sid -ne $testSid) { throw 'Wrong process SID' }
    if ($script:scenario -eq 'unknown-owner') { throw 'Owner SID unreadable' }
    if ($script:scenario -eq 'live-process') { [pscustomobject]@{ processId = 456; name = 'fixture-only.exe' } }
}
function Get-CimInstance { param($ClassName, $Filter)
    if ($ClassName -ne 'Win32_UserProfile' -or $Filter -ne "SID='$testSid'") { throw 'Unscoped CIM query' }
    if ($script:profileExists) { [pscustomobject]@{ SID = $testSid; LocalPath = $fixtureHome; Loaded = ($script:scenario -eq 'loaded') } }
}
function Get-LocalUser {
    if ($script:userExists) { [pscustomobject]@{ Name = $context.accountName; SID = [pscustomobject]@{ Value = $testSid } } }
}
function Remove-LocalUser { param($SID)
    if ($SID.Value -ne $testSid) { throw 'Unscoped account delete' }
    $script:actions.Add('account')
    if ($script:scenario -eq 'account-failure') { throw 'Mock account deletion failed' }
    $script:userExists = $false
}
function Remove-CimInstance { param($InputObject)
    if ($InputObject.SID -ne $testSid -or $InputObject.LocalPath -ne $fixtureHome -or $InputObject.Loaded) { throw 'Unsafe profile deletion' }
    $script:actions.Add('profile')
    if ($script:scenario -eq 'profile-failure') { throw 'Mock profile deletion failed' }
    $script:profileExists = $false; $script:directoryExists = $false
}
function Test-Path { param($LiteralPath)
    if ($LiteralPath -eq $fixtureHome) { return $script:directoryExists }
    if ($LiteralPath -eq (Join-Path $profileList $testSid)) { return $script:profileExists }
    throw 'Unscoped Test-Path'
}
function Get-Item { param($LiteralPath, [switch]$Force)
    if ($LiteralPath -ne $fixtureHome -and $LiteralPath -ne $stage) { throw 'Unscoped Get-Item' }
    $attributes = [IO.FileAttributes]::Directory
    if ($script:scenario -eq 'reparse' -and $LiteralPath -eq $fixtureHome) { $attributes = $attributes -bor [IO.FileAttributes]::ReparsePoint }
    [pscustomobject]@{ FullName = $LiteralPath; Attributes = $attributes }
}
function Get-Acl { param($LiteralPath)
    if ($LiteralPath -ne $stage) { throw 'Unscoped ACL read' }
    $acl = [pscustomobject]@{}
    $acl | Add-Member -MemberType ScriptMethod -Name RemoveAccessRuleSpecific -Value {
        param($Rule)
        if ($Rule -ne 'ONLY-OUR-EXACT-GRANT') { throw 'Wrong ACL grant' }
        $script:actions.Add('remove-specific-grant')
    }
    return $acl
}
function Set-Acl { param($LiteralPath, $AclObject)
    if ($LiteralPath -ne $stage) { throw 'Unscoped ACL write' }
    $script:actions.Add('acl')
    if ($script:scenario -eq 'acl-failure') { throw 'Mock ACL revoke failed' }
}
function Get-StageAclSnapshot { param($Directory, $Sid)
    if ($Directory -ne $stage -or $Sid -ne $testSid) { throw 'Unscoped ACL verification' }
    [pscustomobject]@{ path = $stage; daclSha256 = $(if ($script:scenario -eq 'other-acl-changed') { 'changed' } else { 'original' });
        testSidAceCount = $(if ($script:scenario -eq 'orphan-grant') { 1 } else { 0 }) }
}
function Start-Sleep { param($Milliseconds) }
$reports = @()
foreach ($case in @('success', 'loaded', 'live-process', 'unknown-owner', 'reparse', 'account-failure', 'profile-failure', 'acl-failure', 'orphan-grant', 'other-acl-changed', 'invalid-identity')) {
    $script:scenario = $case; $script:userExists = $true; $script:profileExists = $true; $script:directoryExists = $true
    $script:actions = [Collections.Generic.List[string]]::new()
    $context.expectedProfile = $(if ($case -eq 'invalid-identity') { 'C:\Users\real-user' } else { $fixtureHome })
    $result = Complete-IsolatedCleanup $context 0
    if ($result.completed -ne ($case -eq 'success')) { throw "Wrong result for $case : $($result | ConvertTo-Json -Depth 8)" }
    if ($case -in @('loaded', 'live-process', 'unknown-owner', 'reparse', 'account-failure', 'invalid-identity') -and $script:actions.Contains('profile')) { throw "Unsafe profile removal in $case" }
    if ($case -eq 'invalid-identity' -and $script:actions.Count) { throw 'Invalid identity performed cleanup' }
    if ($case -ne 'invalid-identity' -and !$script:actions.Contains('remove-specific-grant')) { throw "Grant cleanup skipped in $case" }
    $reports += [pscustomobject]@{ scenario = $case; completed = $result.completed; actions = @($script:actions.ToArray()) }
}
$reports | ConvertTo-Json -Depth 8 -Compress
`;
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(program, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, LOLICODE_CLEANUP_SCRIPT: scriptPath },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).length, 11);
  },
);

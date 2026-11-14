param(
    [Parameter(Mandatory = $true)][string]$StageDirectory,
    [string]$ExpectedSid,
    [string]$ExpectedName
)

$ErrorActionPreference = 'Stop'
$stage = (Resolve-Path -LiteralPath $StageDirectory).ProviderPath
$common = [Environment]::GetFolderPath('CommonDocuments')
$stageName = Split-Path -Leaf $stage
if ((Split-Path -Parent $stage) -ne $common -or $stageName -notmatch '^LoliCodeUpgrade-[a-f0-9]{10}$') {
    throw 'Refusing to use a directory outside the dedicated upgrade staging area'
}
$plan = Get-Content -LiteralPath (Join-Path $stage 'plan.json') -Raw | ConvertFrom-Json
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$profileList = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
$profilesRoot = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileList).ProfilesDirectory)

function Write-Phase([string]$Name, $Record) {
    $destination = Join-Path $stage "$Name.json"
    $temporary = "$destination.tmp"
    $text = $Record | ConvertTo-Json -Depth 12 -Compress
    foreach ($file in @($temporary, $destination)) {
        # The worker may only open controller-owned pre-created evidence files.
        # Never replace them: CREATOR OWNER would otherwise add an orphan SID ACE.
        $mode = if ($ExpectedSid) { [IO.FileMode]::Open } else { [IO.FileMode]::OpenOrCreate }
        $stream = [IO.File]::Open($file, $mode, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try {
            $stream.SetLength(0)
            $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
            try { $writer.Write($text); $writer.Flush() } finally { $writer.Dispose() }
        } finally { $stream.Dispose() }
    }
}

function Get-DaclDigest($Acl) {
    $sddl = $Acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($sddl)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-StageAclSnapshot([string]$Directory, [string]$TestSid) {
    # Walk only this exact stage and never follow a junction/symlink.
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($Directory)
    while ($pending.Count) {
        $name = $pending.Dequeue()
        $entry = Get-Item -LiteralPath $name -Force
        if ($entry.FullName -ne $Directory -and !$entry.FullName.StartsWith($Directory + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'An ACL inspection escaped the exact test stage'
        }
        if ($entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw "Refusing to inspect a reparse point: $name" }
        $acl = Get-Acl -LiteralPath $name
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
            Where-Object { $_.IdentityReference.Value -eq $TestSid })
        [pscustomobject]@{ path = $name; daclSha256 = Get-DaclDigest $acl; testSidAceCount = $rules.Count }
        if ($entry.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $name -Force) { $pending.Enqueue($child.FullName) }
        }
    }
}

function Get-TestAccountProcesses([string]$TestSid, $PreviousProcesses) {
    foreach ($process in Get-CimInstance -ClassName Win32_Process) {
        # A process already alive before this account existed cannot belong to it.
        # This also avoids treating protected pre-existing system processes as ours.
        $identity = "$($process.ProcessId):$($process.CreationDate.Ticks)"
        if ($PreviousProcesses.ContainsKey($identity)) { continue }
        try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid }
        catch {
            $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($process.ProcessId)"
            if (!$current -or $current.CreationDate -ne $process.CreationDate) { continue }
            throw
        }
        if ($owner.ReturnValue -ne 0 -or !$owner.Sid) {
            $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($process.ProcessId)"
            if ($current -and $current.CreationDate -eq $process.CreationDate) {
                throw "Cannot verify owner SID of new process $($process.ProcessId) (code $($owner.ReturnValue))"
            }
        } elseif ($owner.Sid -eq $TestSid) {
            [pscustomobject]@{ processId = $process.ProcessId; name = $process.Name; created = $process.CreationDate }
        }
    }
}

function Complete-IsolatedCleanup($Context, [int]$GraceSeconds = 15) {
    # Every destructive operation below is bound to the SID returned by New-LocalUser.
    # Never sweep LCU* accounts, reset a DACL, unload a hive, or kill a process here.
    $errors = [Collections.Generic.List[string]]::new()
    $result = [ordered]@{
        accountName = $Context.accountName; accountSid = $Context.testSid; profile = $Context.expectedProfile
        stage = $Context.stage; originalAcl = $Context.originalAcl; accountRemoved = $false
        profileRemoved = $false; profileRegistrationRemoved = $false; profileDirectoryRemoved = $false
        processesCleared = $false; remainingProcesses = @(); daclRestored = $false
        stageSidRemoved = $false; completed = $false
    }
    if ($Context.accountName -notmatch '^LCU[a-f0-9]{10}$' -or $Context.testSid -notmatch '^S-1-5-21-[0-9-]+$' -or
        $Context.expectedProfile -ne (Join-Path $Context.profilesRoot $Context.accountName) -or
        $Context.stage -ne (Join-Path $common ('LoliCodeUpgrade-' + $Context.accountName.Substring(3)))) {
        $result.errors = @('Invalid cleanup identity; no cleanup actions attempted')
        return $result
    }
    $safeProfile = $false
    try {
        # Give ordinary WebView/Node exit and profile unloading a bounded grace period.
        $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
        do {
            $result.remainingProcesses = @(Get-TestAccountProcesses $Context.testSid $Context.previousProcesses)
            $profile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($Context.testSid)'"
            if (!$result.remainingProcesses.Count -and (!$profile -or !$profile.Loaded)) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($result.remainingProcesses.Count) { throw 'Exact test-SID processes remain; preserving the profile' }
        $result.processesCleared = $true
        if ($profile -and $profile.Loaded) { throw 'The exact test profile is still Loaded; preserving it' }
        if ($profile -and $profile.LocalPath -ne $Context.expectedProfile) { throw 'The test SID profile path changed; preserving it' }
        if (Test-Path -LiteralPath $Context.expectedProfile) {
            $entry = Get-Item -LiteralPath $Context.expectedProfile -Force
            if ($entry.FullName -ne $Context.expectedProfile -or $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
                throw 'The exact test profile is a reparse point or changed path; preserving it'
            }
        }
        $safeProfile = $true
    } catch { $errors.Add($_.Exception.Message) }
    try {
        $users = @(Get-LocalUser | Where-Object { $_.SID.Value -eq $Context.testSid })
        if ($users.Count -gt 1 -or ($users.Count -eq 1 -and $users[0].Name -ne $Context.accountName)) { throw 'Test SID account identity changed' }
        if ($users.Count -eq 1) { Remove-LocalUser -SID ([Security.Principal.SecurityIdentifier]$Context.testSid) }
        if (@(Get-LocalUser | Where-Object { $_.SID.Value -eq $Context.testSid }).Count) { throw 'The exact test account remains' }
        $result.accountRemoved = $true
    } catch { $errors.Add($_.Exception.Message) }
    try {
        if ($safeProfile -and $result.accountRemoved) {
            # Recheck immediately before Remove-CimInstance; never delete a loaded profile.
            $profile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($Context.testSid)'"
            if ($profile) {
                if ($profile.Loaded -or $profile.LocalPath -ne $Context.expectedProfile) { throw 'Profile changed before cleanup; preserving it' }
                if (@(Get-TestAccountProcesses $Context.testSid $Context.previousProcesses).Count) { throw 'A test process appeared before profile cleanup' }
                $entry = Get-Item -LiteralPath $Context.expectedProfile -Force
                if ($entry.FullName -ne $Context.expectedProfile -or $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
                    throw 'The test profile path changed before removal; preserving it'
                }
                Remove-CimInstance -InputObject $profile
            }
        }
        $result.profileRemoved = !(Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($Context.testSid)'")
        $result.profileRegistrationRemoved = !(Test-Path -LiteralPath (Join-Path $profileList $Context.testSid))
        $result.profileDirectoryRemoved = !(Test-Path -LiteralPath $Context.expectedProfile)
        if (!$result.profileRemoved -or !$result.profileRegistrationRemoved -or !$result.profileDirectoryRemoved) {
            throw 'The exact test profile, ProfileList key, or directory remains; no recursive fallback deletion was attempted'
        }
    } catch { $errors.Add($_.Exception.Message) }
    try {
        # RemoveAccessRuleSpecific removes only our exact explicit Modify grant.
        # The current ACL is used so any unrelated changes are never overwritten.
        if ($Context.grantAttempted) {
            $entry = Get-Item -LiteralPath $Context.stage -Force
            if ($entry.FullName -ne $Context.stage -or $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Stage changed before grant removal' }
            $acl = Get-Acl -LiteralPath $Context.stage
            $acl.RemoveAccessRuleSpecific($Context.grantRule)
            Set-Acl -LiteralPath $Context.stage -AclObject $acl
        }
        $after = @(Get-StageAclSnapshot $Context.stage $Context.testSid)
        $result.stageSidRemoved = !(@($after | Where-Object { $_.testSidAceCount -ne 0 }).Count)
        if (!$result.stageSidRemoved) { throw 'The exact test SID still has a stage DACL entry; evidence retained' }
        foreach ($before in $Context.originalAcl) {
            $current = @($after | Where-Object { $_.path -eq $before.path })
            if ($current.Count -ne 1 -or $current[0].daclSha256 -ne $before.daclSha256) { throw "Original DACL changed: $($before.path)" }
        }
        $result.daclRestored = $true
        $result.finalAcl = $after
    } catch { $errors.Add($_.Exception.Message) }
    try {
        $result.remainingProcesses = @(Get-TestAccountProcesses $Context.testSid $Context.previousProcesses)
        $result.processesCleared = !$result.remainingProcesses.Count
        if (!$result.processesCleared) { throw 'Exact test-SID processes remain after cleanup' }
    } catch { $result.processesCleared = $false; $errors.Add($_.Exception.Message) }
    $result.errors = @($errors.ToArray())
    $result.completed = $errors.Count -eq 0
    return $result
}

if (!$ExpectedSid) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'An elevated controller is required to create a disposable standard Windows account'
    }
    $accountName = 'LCU' + $stageName.Substring('LoliCodeUpgrade-'.Length)
    $password = ConvertTo-SecureString ('Lc!8z' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $account = $null
    $context = @{
        accountName = $accountName; testSid = $null; expectedProfile = Join-Path $profilesRoot $accountName
        stage = $stage; profilesRoot = $profilesRoot; grantAttempted = $false; previousProcesses = @{}
        originalAcl = @(Get-StageAclSnapshot $stage '')
    }
    foreach ($process in Get-CimInstance -ClassName Win32_Process) {
        $context.previousProcesses["$($process.ProcessId):$($process.CreationDate.Ticks)"] = $true
    }
    $workerFailure = $null
    try {
        $account = New-LocalUser -Name $accountName -Password $password -Description 'Disposable LoliCode NSIS upgrade test'
        $testSid = $account.SID.Value
        $context.testSid = $testSid
        $context.grantRule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]$testSid, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        Write-Phase 'cleanup-identity' @{
            accountName = $accountName; accountSid = $testSid; profile = $context.expectedProfile
            stage = $stage; originalAcl = $context.originalAcl
        }
        Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]'S-1-5-32-545') -Member $account
        $acl = Get-Acl -LiteralPath $stage
        if (@($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $testSid }).Count) {
            throw 'The fresh test SID unexpectedly already has stage access'
        }
        $acl.AddAccessRule($context.grantRule)
        $context.grantAttempted = $true
        Set-Acl -LiteralPath $stage -AclObject $acl
        $credential = [pscredential]::new(".\$accountName", $password)
        $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -StageDirectory `"$stage`" -ExpectedSid $testSid -ExpectedName $accountName"
        $worker = Start-Process -FilePath $powershell -Credential $credential -LoadUserProfile -WorkingDirectory $stage -WindowStyle Hidden -ArgumentList $arguments -PassThru
        if (!$worker.WaitForExit(1800000)) {
            Write-Phase 'cancel' @{ reason = 'The isolated account worker exceeded the 30 minute timeout' }
            # Let the worker unwind its own finally; never kill its cleanup path.
            if (!$worker.WaitForExit(120000)) { throw 'The worker did not exit after cancellation; retain its exact profile and report remaining processes' }
            throw 'The isolated account worker exceeded the 30 minute timeout'
        }
        $workerRecord = Get-Content -LiteralPath (Join-Path $stage 'account-finished.json') -Raw | ConvertFrom-Json
        $message = Get-Content -LiteralPath (Join-Path $stage 'failure.txt') -Raw
        if ($message) { throw $message }
        # An alternate-credential process can exit without exposing its exit code.
        # Require the explicit completion record even when the exit code is available.
        $exitCode = $worker.ExitCode
        if (($null -ne $exitCode -and $exitCode -ne 0) -or $workerRecord.pending -or
            $workerRecord.persistedConversationSha256 -notmatch '^[a-f0-9]{64}$') {
            throw "The isolated account worker failed or did not report completion (exit code: $exitCode)"
        }
    } catch { $workerFailure = $_ } finally {
        if ($account) {
            $cleanup = Complete-IsolatedCleanup $context
            Write-Phase 'cleanup' $cleanup
            if (!$cleanup.completed) { throw "Isolated cleanup failed; evidence retained at ${stage}: $($cleanup.errors -join '; ')" }
        }
    }
    if ($workerFailure) { throw $workerFailure }
    return
}

function Install-Product([string]$Installer, [string]$Version, [string]$ExpectedHash, [string[]]$Arguments) {
    $installerHash = (Get-FileHash -LiteralPath $Installer).Hash.ToLowerInvariant()
    if ($ExpectedHash -notmatch '^[a-f0-9]{64}$' -or $installerHash -cne $ExpectedHash) { throw 'Installer bytes changed before installation' }
    $install = Start-Process -FilePath $Installer -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "NSIS $Version exited with $($install.ExitCode)" }
    $entry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LoliCode'
    if ($entry.InstallLocation.Trim('"') -ne $installDirectory -or $entry.DisplayVersion -ne $Version) {
        throw 'NSIS registration does not match the isolated install directory and expected version'
    }
    return @{
        installerSha256 = $installerHash
        executableSha256 = (Get-FileHash -LiteralPath $executable).Hash.ToLowerInvariant()
        installedVersion = $entry.DisplayVersion
        exitCode = $install.ExitCode
    }
}

function Start-InstalledApp([string]$Phase, $InstallProof) {
    if (Get-Process -Name 'LoliCode' -ErrorAction SilentlyContinue) {
        throw 'Another LoliCode instance appeared before the isolated app launch'
    }
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $localData "LoliCode-Upgrade-$Phase-WebView"
    $debugPort = $plan.debugPorts.$Phase
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$debugPort --remote-debugging-address=127.0.0.1"
    $app = Start-Process -FilePath $executable -WorkingDirectory $installDirectory -WindowStyle Hidden -PassThru
    try {
        Write-Phase $Phase @{
            account = $ExpectedName
            accountSid = $ExpectedSid
            accountProfile = $accountHome
            profile = $appProfile
            project = $project
            processId = $app.Id
            install = $InstallProof
        }
        $deadline = [DateTime]::UtcNow.AddMinutes(6)
        while (!$app.WaitForExit(1000)) {
            if (Test-Path -LiteralPath (Join-Path $stage 'cancel.json')) { throw "Installed $Phase acceptance was cancelled" }
            if ([DateTime]::UtcNow -ge $deadline) { throw "Installed $Phase app did not exit after WebView acceptance" }
        }
        if ($app.ExitCode -ne 0) { throw "Installed $Phase app exited with $($app.ExitCode)" }
    } finally {
        if (!$app.HasExited) { Stop-Process -Id $app.Id }
    }
}

# These files are read only. A Harness baseline is created through real Tauri
# commands and model requests; it must never be represented by a fake legacy
# migration receipt. Installer preservation is checked while the app is stopped.
function Get-HarnessConversationFiles([string]$Profile, [string]$SessionId) {
    if ($SessionId -cnotmatch '^lc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
        throw 'Invalid persisted Harness session identity'
    }
    $nativeId = $SessionId.Substring(3)
    $metadataPath = Join-Path $Profile "agent\harness-sessions\$nativeId.json"
    $root = Join-Path $Profile "agent\harness-desktop\$nativeId"
    $desktopPath = Join-Path $root 'desktop.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $desktop = Get-Content -LiteralPath $desktopPath -Raw | ConvertFrom-Json
    if ($metadata.session.id -cne $SessionId -or $metadata.deleted -or
        $desktop.snapshot.session.id -cne $SessionId -or !$desktop.rootCreated) {
        throw 'Persisted Harness session identity changed or has no real runtime history'
    }
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue((Join-Path $root 'home\sessions'))
    $files = [Collections.Generic.List[string]]::new()
    $files.Add($metadataPath)
    $files.Add($desktopPath)
    while ($queue.Count) {
        $directory = Get-Item -LiteralPath $queue.Dequeue() -Force
        if (!$directory.PSIsContainer -or $directory.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
            throw 'Harness session history directory is not a regular directory'
        }
        foreach ($entry in Get-ChildItem -LiteralPath $directory.FullName -Force) {
            if ($entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Harness history contains a reparse point' }
            if ($entry.PSIsContainer) { $queue.Enqueue($entry.FullName) }
            elseif ($entry.Name -match '\.jsonl(?:\.zstd)?$') { $files.Add($entry.FullName) }
        }
    }
    if ($files.Count -le 2) { throw 'Harness baseline did not persist any native session log' }
    foreach ($file in $files | Sort-Object) {
        $entry = Get-Item -LiteralPath $file -Force
        if ($entry.PSIsContainer -or $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or !$entry.Length) {
            throw 'Harness conversation file is not a nonempty regular file'
        }
        [pscustomobject]@{ path = $entry.FullName; bytes = $entry.Length; sha256 = (Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() }
    }
}

function Assert-PreservedConversationFiles($Files) {
    if (@($Files).Count -lt 3) { throw 'Missing Harness conversation preservation evidence' }
    foreach ($before in $Files) {
        $entry = Get-Item -LiteralPath $before.path -Force
        if ($entry.PSIsContainer -or $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
            $entry.Length -ne $before.bytes -or (Get-FileHash -LiteralPath $before.path).Hash.ToLowerInvariant() -cne $before.sha256) {
            throw 'Installer modified or removed persisted Harness conversation bytes'
        }
    }
}

try {
    $profileRegistration = Join-Path $profileList $sid
    $accountHome = (Get-ItemProperty -LiteralPath $profileRegistration).ProfileImagePath
    $accountHome = [Environment]::ExpandEnvironmentVariables($accountHome)
    if ($sid -ne $ExpectedSid -or $ExpectedName -notmatch '^LCU[a-f0-9]{10}$' -or
        $accountHome -ne (Join-Path $profilesRoot $ExpectedName) -or
        [Environment]::GetFolderPath('UserProfile') -ne $accountHome) {
        throw 'Windows did not load the exact new local account and profile'
    }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Refusing to execute an installer as an elevated account'
    }
    $localData = Join-Path $accountHome 'AppData\Local'
    $env:USERPROFILE = $accountHome
    Remove-Item -LiteralPath Env:HOME -ErrorAction SilentlyContinue
    $env:USERNAME = $ExpectedName
    $env:LOCALAPPDATA = $localData
    $env:APPDATA = Join-Path $accountHome 'AppData\Roaming'
    $env:TEMP = Join-Path $localData 'Temp'
    $env:TMP = $env:TEMP
    $env:HOMEDRIVE = (Split-Path -Qualifier $accountHome)
    $env:HOMEPATH = $accountHome.Substring($env:HOMEDRIVE.Length)
    Remove-Item -LiteralPath Env:CC_SWITCH_TEST_HOME -ErrorAction SilentlyContinue
    $installDirectory = Join-Path $localData 'LoliCode'
    $executable = Join-Path $installDirectory 'LoliCode.exe'
    $appProfile = Join-Path $accountHome '.tai-switch'
    $project = Join-Path $accountHome 'upgrade-project'
    if (Test-Path -LiteralPath $installDirectory) { throw 'Isolated account already has LoliCode installed' }
    New-Item -ItemType Directory -Path $appProfile, $project, $env:TEMP -Force | Out-Null
    @{
        silentStartup = $true
        checkUpdates = $false
        sessionAutoSyncEnabled = $false
        firstRunNoticeConfirmed = $true
        newLayoutNoticeConfirmed = $true
        language = 'zh'
    } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $appProfile 'settings.json') -Encoding ASCII
    $legacy = $plan.baseline.engine -eq 'legacy'
    if ($plan.baseline.engine -notin @('legacy', 'harness')) { throw 'Unknown baseline conversation engine' }
    $old = Install-Product (Join-Path $stage 'baseline.exe') $plan.baseline.buildVersion $plan.baseline.installerSha256 @('/S', '/NS')
    if ($old.executableSha256 -cne $plan.baseline.executableSha256) {
        throw 'The executable installed by the baseline does not match the published build'
    }
    Start-InstalledApp 'baseline' $old
    if ($legacy) {
        $source = Get-ChildItem -LiteralPath (Join-Path $appProfile 'agent\native\sessions') -File -Filter '*.json'
        if (@($source).Count -ne 1) { throw 'Expected exactly one old persisted Agent transcript' }
        $baselineSessionId = "lc:$($source.BaseName)"
    } else {
        $metadata = Get-ChildItem -LiteralPath (Join-Path $appProfile 'agent\harness-sessions') -File -Filter '*.json'
        if (@($metadata).Count -ne 1) { throw 'Expected exactly one real persisted Harness session' }
        $baselineSessionId = "lc:$($metadata.BaseName)"
        $baselineFiles = @(Get-HarnessConversationFiles $appProfile $baselineSessionId)
        $source = Get-Item -LiteralPath (Join-Path $appProfile "agent\harness-desktop\$($metadata.BaseName)\desktop.json")
    }
    $sourceHash = (Get-FileHash -LiteralPath $source.FullName).Hash
    if (!$plan.upgrade) {
        Write-Phase 'account-finished' @{ persistedConversationSha256 = $sourceHash.ToLowerInvariant() }
        return
    }
    $installedMarker = Join-Path $installDirectory 'upgrade-preservation.txt'
    $sourceHash | Set-Content -LiteralPath $installedMarker -Encoding ASCII
    $candidate = Install-Product (Join-Path $stage 'candidate.exe') $plan.candidateVersion $plan.candidateSha256 @('/S', '/UPDATE', '/NS')
    if ($candidate.executableSha256 -eq $old.executableSha256) { throw 'Upgrade left the baseline executable in place' }
    if ((Get-Content -LiteralPath $installedMarker) -ne $sourceHash -or
        (Get-FileHash -LiteralPath $source.FullName).Hash -ne $sourceHash) {
        throw 'Upgrade did not preserve the original install and baseline conversation files'
    }
    if (!$legacy) { Assert-PreservedConversationFiles $baselineFiles }
    $harness = Join-Path $installDirectory 'agent\harness-runtime'
    if (!(Test-Path -LiteralPath (Join-Path $harness 'node.exe'))) {
        throw 'The installed candidate lacks bundled Harness Node'
    }
    $runtime = Get-Content -LiteralPath (Join-Path $harness 'runtime-manifest.json') -Raw | ConvertFrom-Json
    $runtimePackage = Get-Content -LiteralPath (Join-Path $harness 'node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json
    if ($runtime.harnessVersion -cne $plan.expectedHarnessVersion -or
        $runtimePackage.version -cne $plan.expectedHarnessVersion) {
        throw "Installed Harness version does not match $($plan.expectedHarnessVersion)"
    }
    if (Test-Path -LiteralPath (Join-Path $harness 'installer-files.gz')) {
        $resolveZod = "const r=require('node:module').createRequire(process.argv[1]); process.stdout.write(r.resolve('zod/package.json'));"
        $agentManifest = Join-Path $harness 'node_modules\@deepseek-ai\dsh-agent\package.json'
        $expectedZod = Join-Path $harness 'node_modules\zod\package.json'
        $resolvedZod = & (Join-Path $harness 'node.exe') -e $resolveZod $agentManifest
        if ($LASTEXITCODE -ne 0 -or $resolvedZod -ne $expectedZod) {
            throw 'The installed Harness still resolves a stale private Zod dependency'
        }
    }
    Start-InstalledApp 'candidate' $candidate
    if ($legacy) {
        if ((Get-FileHash -LiteralPath $source.FullName).Hash -ne $sourceHash) {
            throw 'Resuming with Harness modified the original conversation file'
        }
        $sourceId = $source.BaseName
        $receiptPath = Join-Path $appProfile "agent\harness-migration\$sourceId.committed.json"
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
        if ($receipt.loliSessionId -ne "lc:$sourceId" -or $receipt.sourceSha256 -ne $sourceHash -or
            $receipt.harnessSessionId -notmatch '^[0-9a-f-]{36}$') {
            throw 'Missing or invalid committed Harness migration receipt'
        }
        $receiptHash = (Get-FileHash -LiteralPath $receiptPath).Hash
    }
    function Assert-PreservedUpgrade([string]$Phase) {
        if ((Get-Content -LiteralPath $installedMarker) -ne $sourceHash -or
            (Get-FileHash -LiteralPath $executable).Hash.ToLowerInvariant() -cne $candidate.executableSha256) {
            throw "$Phase changed the install marker or candidate executable"
        }
        if ($legacy) {
            if ((Get-FileHash -LiteralPath $source.FullName).Hash -ne $sourceHash -or
                (Get-FileHash -LiteralPath $receiptPath).Hash -ne $receiptHash) {
                throw "$Phase changed the legacy source or committed migration receipt"
            }
        } else {
            $null = @(Get-HarnessConversationFiles $appProfile $baselineSessionId)
            if (Test-Path -LiteralPath (Join-Path $appProfile "agent\harness-migration\$($baselineSessionId.Substring(3)).committed.json")) {
                throw 'A native Harness session unexpectedly acquired a legacy migration receipt'
            }
        }
    }
    # Same Windows account, same profile, same session. The JS driver requires a
    # fresh model request containing every previous question/answer each time.
    Start-InstalledApp 'restart' $candidate
    Assert-PreservedUpgrade 'Restart'
    if (!$legacy) { $beforeReinstallFiles = @(Get-HarnessConversationFiles $appProfile $baselineSessionId) }
    $reinstalled = Install-Product (Join-Path $stage 'candidate.exe') $plan.candidateVersion $plan.candidateSha256 @('/S', '/UPDATE', '/NS')
    if ($reinstalled.installerSha256 -cne $candidate.installerSha256 -or
        $reinstalled.executableSha256 -cne $candidate.executableSha256) {
        throw 'Repeated installation did not use the identical verified candidate'
    }
    if (!$legacy) { Assert-PreservedConversationFiles $beforeReinstallFiles }
    Assert-PreservedUpgrade 'Repeated installation'
    Start-InstalledApp 'reinstall' $reinstalled
    Assert-PreservedUpgrade 'Post-reinstall conversation'
    $finished = @{
        baselineEngine = $plan.baseline.engine
        baselineSessionId = $baselineSessionId
        preservedBaselineConversationSha256 = $sourceHash.ToLowerInvariant()
        harnessVersion = $runtimePackage.version
        overwroteOriginalInstall = $true
        restartVerified = $true
        sameCandidateReinstalled = $true
        candidateSha256 = $candidate.installerSha256
    }
    if ($legacy) {
        $finished.preservedLegacySha256 = $sourceHash.ToLowerInvariant()
        $finished.harnessSessionId = $receipt.harnessSessionId
        $finished.migrationReceiptSha256 = $receiptHash.ToLowerInvariant()
    } else {
        $finished.harnessSessionId = $baselineSessionId.Substring(3)
        $finished.harnessFilesPreservedByInstall = $true
        $finished.harnessFilesPreservedByReinstall = $true
        $finished.baselineFiles = $baselineFiles
        $finished.beforeReinstallFiles = $beforeReinstallFiles
    }
    Write-Phase 'finished' $finished
    Write-Phase 'account-finished' @{ persistedConversationSha256 = $sourceHash.ToLowerInvariant() }
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $stage 'failure.txt') -Encoding UTF8
    throw
}

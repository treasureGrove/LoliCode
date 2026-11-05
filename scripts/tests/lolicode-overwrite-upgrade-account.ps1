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

if (!$ExpectedSid) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'An elevated controller is required to create a disposable standard Windows account'
    }
    $accountName = 'LCU' + $stageName.Substring('LoliCodeUpgrade-'.Length)
    $password = ConvertTo-SecureString ('Lc!8z' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
    $account = $null
    try {
        $account = New-LocalUser -Name $accountName -Password $password -Description 'Disposable LoliCode NSIS upgrade test'
        Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]'S-1-5-32-545') -Member $account
        $testSid = $account.SID.Value
        & icacls.exe $stage /grant ('*' + $testSid + ':(OI)(CI)(M)') | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot authorize the isolated account to access its fixture' }
        $credential = [pscredential]::new(".\$accountName", $password)
        $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -StageDirectory `"$stage`" -ExpectedSid $testSid -ExpectedName $accountName"
        $worker = Start-Process -FilePath $powershell -Credential $credential -LoadUserProfile -WorkingDirectory $stage -WindowStyle Hidden -ArgumentList $arguments -PassThru
        if (!$worker.WaitForExit(900000)) {
            Stop-Process -Id $worker.Id
            throw 'The isolated account worker exceeded the 15 minute timeout'
        }
        if (!(Test-Path -LiteralPath (Join-Path $stage 'account-finished.json'))) {
            $failure = Join-Path $stage 'failure.txt'
            if (Test-Path -LiteralPath $failure) { throw (Get-Content -LiteralPath $failure -Raw) }
            throw "The isolated account worker exited with $($worker.ExitCode)"
        }
    } finally {
        if ($account) {
            Remove-LocalUser -SID $account.SID
            $testProfile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$($account.SID.Value)'"
            $expectedProfile = Join-Path $profilesRoot $accountName
            if ($testProfile -and !$testProfile.Loaded -and $testProfile.LocalPath -eq $expectedProfile) {
                $resolvedProfile = Get-Item -LiteralPath $expectedProfile
                if ($resolvedProfile.FullName -eq $expectedProfile -and
                    !$resolvedProfile.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
                    Remove-CimInstance -InputObject $testProfile
                }
            }
        }
    }
    return
}

function Write-Phase([string]$Name, $Record) {
    $destination = Join-Path $stage "$Name.json"
    $temporary = "$destination.tmp"
    $Record | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $destination
}

function Install-Product([string]$Installer, [string]$Version, [string[]]$Arguments) {
    $install = Start-Process -FilePath $Installer -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "NSIS $Version exited with $($install.ExitCode)" }
    $entry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LoliCode'
    if ($entry.InstallLocation.Trim('"') -ne $installDirectory -or $entry.DisplayVersion -ne $Version) {
        throw 'NSIS registration does not match the isolated install directory and expected version'
    }
    return @{
        installerSha256 = (Get-FileHash -LiteralPath $Installer).Hash.ToLowerInvariant()
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
            profile = $appProfile
            project = $project
            processId = $app.Id
            install = $InstallProof
        }
        if (!$app.WaitForExit(360000)) { throw "Installed $Phase app did not exit after WebView acceptance" }
        if ($app.ExitCode -ne 0) { throw "Installed $Phase app exited with $($app.ExitCode)" }
    } finally {
        if (!$app.HasExited) { Stop-Process -Id $app.Id }
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
    $old = Install-Product (Join-Path $stage 'baseline.exe') '4.1.6' @('/S', '/NS')
    if ($old.executableSha256 -ne 'ac2e01426395a073db62ba1a476654533b46a146696fc48061b86a3df7d8d187') {
        throw 'The executable installed by the baseline does not match the published build'
    }
    Start-InstalledApp 'baseline' $old
    $source = Get-ChildItem -LiteralPath (Join-Path $appProfile 'agent\native\sessions') -File -Filter '*.json'
    if (@($source).Count -ne 1) { throw 'Expected exactly one old persisted Agent transcript' }
    $sourceHash = (Get-FileHash -LiteralPath $source.FullName).Hash
    if (!$plan.upgrade) {
        Write-Phase 'account-finished' @{ persistedLegacySha256 = $sourceHash.ToLowerInvariant() }
        return
    }
    $installedMarker = Join-Path $installDirectory 'upgrade-preservation.txt'
    $sourceHash | Set-Content -LiteralPath $installedMarker -Encoding ASCII
    $candidate = Install-Product (Join-Path $stage 'candidate.exe') $plan.candidateVersion @('/S', '/UPDATE', '/NS')
    if ($candidate.executableSha256 -eq $old.executableSha256) { throw 'Upgrade left the baseline executable in place' }
    if ((Get-Content -LiteralPath $installedMarker) -ne $sourceHash -or
        (Get-FileHash -LiteralPath $source.FullName).Hash -ne $sourceHash) {
        throw 'Upgrade did not preserve the original install and old conversation files'
    }
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
    Start-InstalledApp 'candidate' $candidate
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
    Write-Phase 'finished' @{
        preservedLegacySha256 = $sourceHash.ToLowerInvariant()
        harnessSessionId = $receipt.harnessSessionId
        harnessVersion = $runtimePackage.version
        overwroteOriginalInstall = $true
    }
    Write-Phase 'account-finished' @{ persistedLegacySha256 = $sourceHash.ToLowerInvariant() }
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $stage 'failure.txt') -Encoding UTF8
    throw
}

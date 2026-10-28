param(
    [ValidateSet('Register', 'Unregister')]
    [string]$Action = 'Register',
    [string]$BuildDirectory
)

$ErrorActionPreference = 'Stop'
$taskIdentifier = 'art.treasuregrove.lolicode.dev'
$taskInstallDirectory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\LoliCode Dev'))
$taskBinary = Join-Path $taskInstallDirectory 'LoliCode Dev.exe'
$taskManifestPath = Join-Path $taskInstallDirectory 'development-build.json'
$taskRegistryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$taskIdentifier"

function Read-DevelopmentManifest([string]$ManifestPath) {
    $taskManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($taskManifest.identifier -ne $taskIdentifier -or $taskManifest.channel -ne 'development' -or $taskManifest.appName -ne 'LoliCode Dev') {
        throw 'Refusing to manage a directory without a matching development manifest.'
    }
    return $taskManifest
}

function Assert-DevelopmentAppClosed {
    $taskRunning = @(Get-Process -Name 'LoliCode Dev' -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and [IO.Path]::GetFullPath($_.Path) -eq $taskBinary
    })
    if ($taskRunning.Count -gt 0) {
        throw 'Close LoliCode Dev, then run pnpm dev:register again. The build is already saved.'
    }
}

function Development-ShortcutPaths([string]$ShortcutName) {
    if ([IO.Path]::GetFileName($ShortcutName) -ne $ShortcutName) { throw 'Invalid shortcut name.' }
    return @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) ($ShortcutName + '.lnk')),
        (Join-Path ([Environment]::GetFolderPath('Programs')) ($ShortcutName + '.lnk'))
    )
}

if ($Action -eq 'Unregister') {
    if (-not (Test-Path -LiteralPath $taskManifestPath)) {
        if ((Test-Path -LiteralPath $taskInstallDirectory) -or (Test-Path -LiteralPath $taskRegistryPath)) {
            throw 'Development ownership manifest missing; existing files were preserved.'
        }
        Write-Output 'No development installation is registered.'
        exit 0
    }
    $taskManifest = Read-DevelopmentManifest $taskManifestPath
    Assert-DevelopmentAppClosed
    if (Test-Path -LiteralPath $taskRegistryPath) {
        $taskExistingRegistry = Get-ItemProperty -LiteralPath $taskRegistryPath
        if ($taskExistingRegistry.InstallLocation -ne $taskInstallDirectory) { throw 'Unexpected development registration; preserved.' }
    }
    $taskShell = New-Object -ComObject WScript.Shell
    foreach ($taskShortcutPath in (Development-ShortcutPaths $taskManifest.shortcutName)) {
        if (Test-Path -LiteralPath $taskShortcutPath) {
            $taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
            if ($taskShortcut.TargetPath -eq $taskBinary) { Remove-Item -LiteralPath $taskShortcutPath }
        }
    }
    if (Test-Path -LiteralPath $taskRegistryPath) {
        Remove-Item -LiteralPath $taskRegistryPath -Recurse
    }
    # Remove only files recorded by our installer; preserve unknown files and user data.
    foreach ($taskRelativeFile in @($taskManifest.files) + @('development-build.json')) {
        $taskOwnedFile = [IO.Path]::GetFullPath((Join-Path $taskInstallDirectory $taskRelativeFile))
        if (-not $taskOwnedFile.StartsWith($taskInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe managed file path.' }
        if (Test-Path -LiteralPath $taskOwnedFile -PathType Leaf) { Remove-Item -LiteralPath $taskOwnedFile }
    }
    Write-Output 'Development shortcuts, application registration and managed files removed. User data preserved.'
    exit 0
}

if (-not $BuildDirectory) { throw 'BuildDirectory is required.' }
$taskSourceDirectory = [IO.Path]::GetFullPath($BuildDirectory)
$taskSourceManifest = Join-Path $taskSourceDirectory 'development-build.json'
$taskManifest = Read-DevelopmentManifest $taskSourceManifest
$taskPreviousManifest = $null
if (-not (Test-Path -LiteralPath (Join-Path $taskSourceDirectory 'LoliCode Dev.exe') -PathType Leaf)) { throw 'Development executable missing.' }
if (Test-Path -LiteralPath $taskInstallDirectory) {
    if (Test-Path -LiteralPath $taskManifestPath) { $taskPreviousManifest = Read-DevelopmentManifest $taskManifestPath }
    elseif (@(Get-ChildItem -LiteralPath $taskInstallDirectory -Force -Recurse -File).Count -gt 0) {
        throw 'Existing development folder is not managed by this script; files preserved.'
    }
}
Assert-DevelopmentAppClosed

$taskShell = New-Object -ComObject WScript.Shell
foreach ($taskShortcutPath in (Development-ShortcutPaths $taskManifest.shortcutName)) {
    if (Test-Path -LiteralPath $taskShortcutPath) {
        $taskOldShortcut = $taskShell.CreateShortcut($taskShortcutPath)
        if ($taskOldShortcut.TargetPath -ne $taskBinary) { throw 'A different app owns the development shortcut; preserved.' }
    }
}
if (Test-Path -LiteralPath $taskRegistryPath) {
    $taskExistingRegistry = Get-ItemProperty -LiteralPath $taskRegistryPath
    if ($taskExistingRegistry.InstallLocation -ne $taskInstallDirectory) { throw 'Unexpected development registration; preserved.' }
}
foreach ($taskRelativeFile in @($taskManifest.files) + @('development-build.json')) {
    $taskSourceFile = [IO.Path]::GetFullPath((Join-Path $taskSourceDirectory $taskRelativeFile))
    $taskDestinationFile = [IO.Path]::GetFullPath((Join-Path $taskInstallDirectory $taskRelativeFile))
    if (-not $taskSourceFile.StartsWith($taskSourceDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not $taskDestinationFile.StartsWith($taskInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe managed file path.' }
    if (-not (Test-Path -LiteralPath $taskSourceFile -PathType Leaf)) { throw 'Managed source file missing.' }
}

$null = New-Item -ItemType Directory -Path $taskInstallDirectory -Force
if ($taskPreviousManifest) {
    foreach ($taskRelativeFile in $taskPreviousManifest.files) {
        if ($taskManifest.files -contains $taskRelativeFile) { continue }
        $taskOwnedFile = [IO.Path]::GetFullPath((Join-Path $taskInstallDirectory $taskRelativeFile))
        if (-not $taskOwnedFile.StartsWith($taskInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe managed file path.' }
        if (Test-Path -LiteralPath $taskOwnedFile -PathType Leaf) { Remove-Item -LiteralPath $taskOwnedFile }
    }
}
foreach ($taskRelativeFile in @($taskManifest.files) + @('development-build.json')) {
    $taskSourceFile = [IO.Path]::GetFullPath((Join-Path $taskSourceDirectory $taskRelativeFile))
    $taskDestinationFile = [IO.Path]::GetFullPath((Join-Path $taskInstallDirectory $taskRelativeFile))
    if (-not $taskSourceFile.StartsWith($taskSourceDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not $taskDestinationFile.StartsWith($taskInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe managed file path.' }
    $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($taskDestinationFile)) -Force
    Copy-Item -LiteralPath $taskSourceFile -Destination $taskDestinationFile -Force
}

foreach ($taskShortcutPath in (Development-ShortcutPaths $taskManifest.shortcutName)) {
    $taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
    $taskShortcut.TargetPath = $taskBinary
    $taskShortcut.WorkingDirectory = $taskInstallDirectory
    $taskShortcut.IconLocation = "$taskBinary,0"
    $taskShortcut.Description = "LoliCode development - $($taskManifest.developmentBuildNumber) - $($taskManifest.revision)"
    $taskShortcut.Save()
}

$taskUninstaller = Join-Path $taskInstallDirectory 'register-lolicode-development.ps1'
$taskPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskUninstallCommand = '"' + $taskPowerShell + '" -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskUninstaller + '" -Action Unregister'
$null = New-Item -Path $taskRegistryPath -Force
$taskRegistryValues = @{
    DisplayName = $taskManifest.shortcutName
    DisplayVersion = "$($taskManifest.productVersion) $($taskManifest.developmentBuildNumber) ($($taskManifest.revision))"
    Publisher = 'LoliCode Development'
    InstallLocation = $taskInstallDirectory
    DisplayIcon = "$taskBinary,0"
    UninstallString = $taskUninstallCommand
    QuietUninstallString = $taskUninstallCommand
    URLInfoAbout = 'https://github.com/treasureGrove/LoliCode'
}
foreach ($taskValueName in $taskRegistryValues.Keys) {
    $null = New-ItemProperty -LiteralPath $taskRegistryPath -Name $taskValueName -Value $taskRegistryValues[$taskValueName] -PropertyType String -Force
}
foreach ($taskValueName in @('NoModify', 'NoRepair')) {
    $null = New-ItemProperty -LiteralPath $taskRegistryPath -Name $taskValueName -Value 1 -PropertyType DWord -Force
}
Write-Output "Registered $($taskManifest.shortcutName): $taskBinary"

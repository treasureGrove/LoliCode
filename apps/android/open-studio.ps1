param(
    [string]$StudioPath = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$officialDownload = 'https://developer.android.com/studio'
$candidates = [Collections.Generic.List[string]]::new()
if ($StudioPath) {
    $provided = [IO.Path]::GetFullPath($StudioPath)
    $candidates.Add($(if (Test-Path -LiteralPath $provided -PathType Container) { Join-Path $provided 'bin\studio64.exe' } else { $provided }))
} else {
    foreach ($commandName in @('studio64.exe', 'studio.exe', 'studio64', 'studio')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($command) { $candidates.Add($command.Source) }
    }
    foreach ($baseDirectory in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if (!$baseDirectory) { continue }
        foreach ($relative in @('Android\Android Studio\bin\studio64.exe', 'Android Studio\bin\studio64.exe', 'Programs\Android Studio\bin\studio64.exe')) {
            $candidates.Add((Join-Path $baseDirectory $relative))
        }
    }
    foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        foreach ($entry in @(Get-ItemProperty $registryRoot -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Android Studio' })) {
            if ($entry.InstallLocation) { $candidates.Add((Join-Path $entry.InstallLocation 'bin\studio64.exe')) }
            if ($entry.DisplayIcon) { $candidates.Add(($entry.DisplayIcon -replace ',\d+$', '').Trim('"')) }
        }
    }
    foreach ($registryPath in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\studio64.exe', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\studio64.exe')) {
        if (Test-Path -LiteralPath $registryPath) {
            $registered = (Get-Item -LiteralPath $registryPath).GetValue('')
            if ($registered) { $candidates.Add($registered) }
        }
    }
}
$studioExecutable = $candidates | Select-Object -Unique | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$studioExecutable) {
    throw "Android Studio was not found. Install it from $officialDownload, then rerun or pass -StudioPath 'C:\path\to\Android Studio'. This helper does not install software."
}
if ($DryRun) {
    [pscustomobject]@{ studio = $studioExecutable; project = $projectDirectory; launch = $false } | ConvertTo-Json
    return
}
# Invoking this helper explicitly opens the interactive IDE for the user.
Start-Process -FilePath $studioExecutable -ArgumentList ('"' + $projectDirectory + '"') -WindowStyle Normal | Out-Null

$ErrorActionPreference = 'Stop'
$taskInstallDirectory = $PSScriptRoot
$taskRunName = 'launch-' + [Guid]::NewGuid().ToString('N')
$taskLogPath = Join-Path $taskInstallDirectory ($taskRunName + '.log')
$taskLatestLogPath = Join-Path $taskInstallDirectory 'launch.log'
$taskErrorLogPath = Join-Path $taskInstallDirectory ($taskRunName + '.stderr.log')
$taskProgress = $null

try {
    $taskManifest = Get-Content -LiteralPath (Join-Path $taskInstallDirectory 'development-build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($taskManifest.identifier -ne 'art.treasuregrove.lolicode.dev' -or
        $taskManifest.channel -ne 'development' -or $taskManifest.appName -ne 'LoliCode Dev') {
        throw '开发版安装记录无效，请重新运行 pnpm build:dev。'
    }
    $taskBinary = Join-Path $taskInstallDirectory 'LoliCode Dev.exe'
    if (-not (Test-Path -LiteralPath $taskBinary -PathType Leaf)) {
        throw '开发版程序缺失，请重新运行 pnpm build:dev。'
    }
    if ($taskManifest.autoBuildOnLaunch -ne $true) {
        # Downloaded development packages and old registrations have no local source binding.
        Start-Process -FilePath $taskBinary -WorkingDirectory $taskInstallDirectory
        exit 0
    }
    if (-not $taskManifest.sourceDirectory -or -not [IO.Path]::IsPathRooted($taskManifest.sourceDirectory)) {
        throw '开发版源码目录记录无效，请在本机源码仓库重新运行 pnpm build:dev。'
    }
    $taskSourceDirectory = [IO.Path]::GetFullPath($taskManifest.sourceDirectory)
    $taskEntry = Join-Path $taskSourceDirectory 'scripts\dev\lolicode-development.mjs'
    if (-not (Test-Path -LiteralPath $taskEntry -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $taskSourceDirectory '.git'))) {
        throw '开发版绑定的源码仓库不可用，请恢复原目录，或在新目录运行 pnpm build:dev。'
    }
    $taskNode = $taskManifest.nodePath
    if (-not $taskNode -or -not [IO.Path]::IsPathRooted($taskNode) -or
        -not (Test-Path -LiteralPath $taskNode -PathType Leaf)) {
        throw '开发版绑定的 Node.js 不可用，请恢复 Node.js 后重新运行 pnpm build:dev。'
    }
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskEntry + '"'), 'launch') `
        -WorkingDirectory $taskSourceDirectory -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $taskLogPath -RedirectStandardError $taskErrorLogPath
    # Wait only for the launcher, not for the interactive app it starts.
    $null = $taskProcess.Handle
    $taskStartedAt = [DateTime]::UtcNow
    $taskProgressUnavailable = $false
    while (-not $taskProcess.WaitForExit(150)) {
        if (-not $taskProgress -and -not $taskProgressUnavailable -and
            ([DateTime]::UtcNow - $taskStartedAt).TotalSeconds -ge 1) {
            try {
                Add-Type -AssemblyName System.Windows.Forms
                $taskProgress = New-Object Windows.Forms.Form
                $taskProgress.Text = 'LoliCode 开发版'
                $taskProgress.Width = 460
                $taskProgress.Height = 145
                $taskProgress.StartPosition = 'CenterScreen'
                $taskProgress.FormBorderStyle = 'FixedDialog'
                $taskProgress.ControlBox = $false
                $taskLabel = New-Object Windows.Forms.Label
                $taskLabel.Text = "正在检查源码并准备最新开发版……`n有变化时会自动构建，可能需要几分钟。"
                $taskLabel.SetBounds(20, 15, 410, 45)
                $taskProgress.Controls.Add($taskLabel)
                $taskBar = New-Object Windows.Forms.ProgressBar
                $taskBar.Style = 'Marquee'
                $taskBar.SetBounds(20, 65, 405, 18)
                $taskProgress.Controls.Add($taskBar)
                $taskProgress.Show()
            } catch {
                $taskProgressUnavailable = $true
                if ($taskProgress) { $taskProgress.Dispose(); $taskProgress = $null }
            }
        }
        if ($taskProgress) { [Windows.Forms.Application]::DoEvents() }
    }
    $taskProcess.WaitForExit()
    if ($taskProgress) { $taskProgress.Dispose(); $taskProgress = $null }
    if (Test-Path -LiteralPath $taskErrorLogPath) {
        Get-Content -LiteralPath $taskErrorLogPath -Raw -Encoding UTF8 | Add-Content -LiteralPath $taskLogPath -Encoding UTF8
        Remove-Item -LiteralPath $taskErrorLogPath
    }
    if ($taskProcess.ExitCode -ne 0) {
        $taskDetail = (Get-Content -LiteralPath $taskLogPath -Encoding UTF8 | Where-Object { $_.Trim() } | Select-Object -Last 1)
        throw ("开发版未能启动。`n" + $taskDetail)
    }
    # Each invocation owns its output until completion; a repeated click cannot
    # truncate the log of a build that is still running.
    $taskPublished = $false
    try {
        Copy-Item -LiteralPath $taskLogPath -Destination $taskLatestLogPath -Force
        $taskPublished = $true
    } catch {}
    if ($taskPublished) { Remove-Item -LiteralPath $taskLogPath -ErrorAction SilentlyContinue }
} catch {
    $taskMessage = $_.Exception.Message
    try { Add-Content -LiteralPath $taskLogPath -Value $taskMessage -Encoding UTF8 } catch {}
    try { Copy-Item -LiteralPath $taskLogPath -Destination $taskLatestLogPath -Force } catch {}
    $taskShell = New-Object -ComObject WScript.Shell
    $null = $taskShell.Popup(($taskMessage + "`n`n启动日志：" + $taskLogPath), 0, 'LoliCode 开发版', 16)
    exit 1
} finally {
    if ($taskProgress) { $taskProgress.Dispose() }
}

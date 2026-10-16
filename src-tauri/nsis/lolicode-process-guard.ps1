param(
  [Parameter(Mandatory = $true)]
  [string] $InstallDirectory,

  [Parameter(Mandatory = $true)]
  [string] $BinaryName,

  [string] $FixturePath,
  [switch] $Fixture,
  [switch] $Silent
)

$ErrorActionPreference = 'Stop'
$allowedBinaryNames = @('tai-switch.exe', 'LoliCode.exe')

if ($allowedBinaryNames -notcontains $BinaryName) {
  [Console]::Error.WriteLine('Refusing to inspect an unknown executable name.')
  exit 20
}

function Get-NormalizedPath([string] $Path) {
  try {
    return [System.IO.Path]::GetFullPath($Path)
  } catch {
    return $null
  }
}

function Test-ProcessPath([object] $ProcessInfo, [string] $ExpectedPath) {
  if (-not $ProcessInfo) {
    return 'exited'
  }

  if ($ProcessInfo.Name -ine $BinaryName) {
    return 'different-name'
  }

  if (-not $ProcessInfo.ExecutablePath) {
    return 'unresolved'
  }

  $actualPath = Get-NormalizedPath ([string] $ProcessInfo.ExecutablePath)
  if (-not $actualPath) {
    return 'unresolved'
  }

  if ([string]::Equals($actualPath, $ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 'match'
  }

  return 'different-path'
}

function Get-MatchingProcesses([object[]] $Processes) {
  $expectedPath = Get-NormalizedPath (Join-Path $InstallDirectory $BinaryName)
  if (-not $expectedPath) {
    throw 'The install path could not be normalized.'
  }

  $matches = @()
  $unresolved = @()
  foreach ($process in $Processes) {
    $pathStatus = Test-ProcessPath $process $expectedPath
    if ($pathStatus -eq 'unresolved') {
      $unresolved += $process
      continue
    }

    if ($pathStatus -eq 'match') {
      $matches += $process
    }
  }

  return [pscustomobject] @{
    ExpectedPath = $expectedPath
    Matches      = $matches
    Unresolved   = $unresolved
  }
}

function Get-VerifiedProcessById([int] $ProcessId, [string] $ExpectedPath) {
  $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId"
  $pathStatus = Test-ProcessPath $processInfo $ExpectedPath
  if ($pathStatus -eq 'unresolved') {
    throw 'Windows could not verify a running process path.'
  }
  if ($pathStatus -ne 'match') {
    return $null
  }

  $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
  $handlePath = Get-NormalizedPath ([string] $process.Path)
  if (-not $handlePath) {
    throw 'Windows could not verify the process path before closing it.'
  }
  if (-not [string]::Equals($handlePath, $ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }

  return $process
}

if ($Fixture) {
  if (-not $FixturePath) {
    [Console]::Error.WriteLine('Fixture mode requires FixturePath.')
    exit 21
  }

  try {
    $fixtureData = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    $selection = Get-MatchingProcesses @($fixtureData.Processes)
    $candidateChecks = @(
      foreach ($processId in $fixtureData.CandidateIds) {
        $currentProcess = @($fixtureData.CurrentProcesses | Where-Object { [int] $_.ProcessId -eq [int] $processId } | Select-Object -First 1)
        if ($currentProcess.Count -eq 0) {
          $currentProcess = $null
        } else {
          $currentProcess = $currentProcess[0]
        }
        [pscustomobject] @{
          ProcessId = [int] $processId
          Status    = Test-ProcessPath $currentProcess $selection.ExpectedPath
        }
      }
    )
    [pscustomobject] @{
      ExpectedPath = $selection.ExpectedPath
      MatchedIds   = @($selection.Matches | ForEach-Object { $_.ProcessId })
      Unresolved   = @($selection.Unresolved | ForEach-Object { $_.ProcessId })
      CandidateChecks = $candidateChecks
    } | ConvertTo-Json -Compress
    exit 0
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 22
  }
}

function Show-GuardMessage([string] $Message, [string] $Title, [int] $Buttons) {
  Add-Type -AssemblyName System.Windows.Forms
  $buttonSet = [System.Enum]::ToObject([System.Windows.Forms.MessageBoxButtons], $Buttons)
  return [System.Windows.Forms.MessageBox]::Show(
    $Message,
    $Title,
    $buttonSet,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
}

try {
  $namedProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$BinaryName'")
  $selection = Get-MatchingProcesses $namedProcesses
  if ($selection.Unresolved.Count -gt 0) {
    if (-not $Silent) {
      [void] (Show-GuardMessage 'Windows could not verify the running process path. Close LoliCode manually and retry the installation.' 'LoliCode Setup' 0)
    }
    exit 2
  }

  if ($selection.Matches.Count -eq 0) {
    exit 0
  }

  if ($Silent) {
    exit 1
  }

  $choice = Show-GuardMessage 'LoliCode is still running from this install folder. Save your work, then choose Yes to close it and continue. Choose No to cancel.' 'LoliCode Setup' 4
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
    exit 1
  }

  foreach ($processInfo in $selection.Matches) {
    $process = Get-VerifiedProcessById ([int] $processInfo.ProcessId) $selection.ExpectedPath
    if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
      try {
        [void] $process.CloseMainWindow()
      } catch [System.InvalidOperationException] {
        # The app exited between the process scan and the close request.
      }
    }
  }

  $closeDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $namedProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$BinaryName'")
    $selection = Get-MatchingProcesses $namedProcesses
    if ($selection.Unresolved.Count -gt 0) {
      [void] (Show-GuardMessage 'Windows could not verify the running process path. Close LoliCode manually and retry the installation.' 'LoliCode Setup' 0)
      exit 2
    }
  } while ($selection.Matches.Count -gt 0 -and [DateTime]::UtcNow -lt $closeDeadline)

  if ($selection.Matches.Count -eq 0) {
    exit 0
  }

  $choice = Show-GuardMessage 'LoliCode did not close normally. Force close it? Unsaved work may be lost.' 'LoliCode Setup' 4
  if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
    exit 2
  }

  foreach ($processInfo in $selection.Matches) {
    $process = Get-VerifiedProcessById ([int] $processInfo.ProcessId) $selection.ExpectedPath
    if ($process) {
      try {
        $process.Kill()
      } catch [System.InvalidOperationException] {
        # The app exited between the process scan and the force-close request.
      }
    }
  }

  $forceDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 250
    $namedProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$BinaryName'")
    $selection = Get-MatchingProcesses $namedProcesses
    if ($selection.Unresolved.Count -gt 0) {
      [void] (Show-GuardMessage 'Windows could not verify the running process path. Close LoliCode manually and retry the installation.' 'LoliCode Setup' 0)
      exit 2
    }
  } while ($selection.Matches.Count -gt 0 -and [DateTime]::UtcNow -lt $forceDeadline)
  if ($selection.Matches.Count -eq 0) {
    exit 0
  }

  [void] (Show-GuardMessage 'LoliCode could not be closed. Close it manually and retry the installation.' 'LoliCode Setup' 0)
  exit 2
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  if (-not $Silent) {
    try {
      [void] (Show-GuardMessage 'The installer could not safely verify or close LoliCode. Close it manually and retry.' 'LoliCode Setup' 0)
    } catch {
      # Preserve the non-zero exit code for NSIS even if a dialog cannot be shown.
    }
  }
  exit 2
}

param(
    [ValidateSet('Debug', 'Release')][string]$Variant = 'Debug',
    [switch]$Test,
    [string]$ToolchainRoot = ''
)
$ErrorActionPreference = 'Stop'
$androidProjectRoot = $PSScriptRoot
$explicitToolchain = ![string]::IsNullOrWhiteSpace($ToolchainRoot)
$taskToolchainRoot = if ($explicitToolchain) { [IO.Path]::GetFullPath($ToolchainRoot) }
    else { [IO.Path]::GetFullPath((Join-Path $androidProjectRoot '..\..\tmp\android-toolchain')) }
$previousJavaHome = $env:JAVA_HOME
$previousAndroidHome = $env:ANDROID_HOME
$gradleTasks = @(':app:assemble' + $Variant)
if ($Test) { $gradleTasks += ':app:testDebugUnitTest' }
try {
    if ($explicitToolchain -and !(Test-Path -LiteralPath $taskToolchainRoot -PathType Container)) {
        throw "ToolchainRoot does not exist: $taskToolchainRoot"
    }
    if ($explicitToolchain -and !(Test-Path -LiteralPath (Join-Path $taskToolchainRoot 'sdk') -PathType Container)) {
        throw 'The explicit ToolchainRoot must contain sdk/. Existing environment variables are not used as a fallback.'
    }
    if (($explicitToolchain -or !$env:JAVA_HOME) -and (Test-Path -LiteralPath $taskToolchainRoot)) {
        $env:JAVA_HOME = Get-ChildItem -LiteralPath $taskToolchainRoot -Directory -Filter 'jdk-17*' | Select-Object -First 1 -ExpandProperty FullName
    }
    if (($explicitToolchain -or !$env:ANDROID_HOME) -and (Test-Path -LiteralPath (Join-Path $taskToolchainRoot 'sdk'))) {
        $env:ANDROID_HOME = Join-Path $taskToolchainRoot 'sdk'
    }
    if (!$env:JAVA_HOME -or !(Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
        throw 'Set JAVA_HOME to JDK 17, or pass -ToolchainRoot containing jdk-17*/ and sdk/.'
    }
    if (!$env:ANDROID_HOME -or !(Test-Path -LiteralPath $env:ANDROID_HOME)) {
        throw 'Set ANDROID_HOME to platform 35 / Build Tools 35.0.0, or pass -ToolchainRoot.'
    }
    Push-Location -LiteralPath $androidProjectRoot
    try {
        & (Join-Path $androidProjectRoot 'gradlew.bat') @gradleTasks --console=plain
        if ($LASTEXITCODE -ne 0) { throw "Android build failed ($LASTEXITCODE)." }
    } finally { Pop-Location }
} finally {
    $env:JAVA_HOME = $previousJavaHome
    $env:ANDROID_HOME = $previousAndroidHome
}

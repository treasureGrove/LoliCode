#requires -Version 7.2
param(
    [string]$InputApk = '',
    [string]$OutputApk = '',
    [string]$AndroidSdk = $env:ANDROID_HOME
)
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'This helper uses Windows current-user DPAPI and NTFS ACLs.' }
$androidProjectRoot = $PSScriptRoot
$taskToolchainRoot = [IO.Path]::GetFullPath((Join-Path $androidProjectRoot '..\..\tmp\android-toolchain'))
if (!$env:JAVA_HOME -and (Test-Path -LiteralPath $taskToolchainRoot)) {
    $env:JAVA_HOME = Get-ChildItem -LiteralPath $taskToolchainRoot -Directory -Filter 'jdk-17*' | Select-Object -First 1 -ExpandProperty FullName
}
if (!$AndroidSdk) { $AndroidSdk = Join-Path $taskToolchainRoot 'sdk' }
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
$buildTools = Join-Path $AndroidSdk 'build-tools\35.0.0'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$aapt = Join-Path $buildTools 'aapt2.exe'
foreach ($tool in @($keytool, $zipalign, $apksigner, $aapt)) {
    if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required signing tool missing: $tool" }
}
if (!$InputApk) { $InputApk = Join-Path $androidProjectRoot 'app\build\outputs\apk\release\app-release-unsigned.apk' }
$InputApk = [IO.Path]::GetFullPath($InputApk)
if (!(Test-Path -LiteralPath $InputApk -PathType Leaf)) { throw 'Build an unsigned release APK before signing.' }
$badging = @(& $aapt dump badging $InputApk)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the unsigned APK.' }
$packageMatch = [regex]::Match(($badging -join "`n"), "package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'")
if (!$packageMatch.Success -or $packageMatch.Groups[1].Value -ne 'art.treasuregrove.lolicode.mobile') { throw 'Refusing to sign a different Android package.' }
$versionName = $packageMatch.Groups[3].Value
if ($versionName -notmatch '^[0-9A-Za-z.-]+$') { throw 'Unsafe APK version name.' }
if (($badging -join "`n") -notmatch "sdkVersion:'26'") { throw 'Unexpected minimum Android SDK.' }
if (!$OutputApk) { $OutputApk = Join-Path (Split-Path $InputApk -Parent) "LoliCode-Android-$versionName.apk" }
$OutputApk = [IO.Path]::GetFullPath($OutputApk)
if ($OutputApk -eq $InputApk) { throw 'The unsigned APK must be preserved.' }
$outputDirectory = Split-Path $OutputApk -Parent
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$alignedApk = Join-Path $outputDirectory "LoliCode-Android-$versionName-aligned.apk"

# This key identifies Android application updates. It is unrelated to Windows
# Authenticode or the desktop updater. Existing keys are never overwritten.
$signingDirectory = Join-Path $env:LOCALAPPDATA 'LoliCode\android-signing'
New-Item -ItemType Directory -Force -Path $signingDirectory | Out-Null
if ((Get-Item -LiteralPath $signingDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected signing directory.' }
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($currentUserSid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($currentUserSid, $systemSid)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $signingDirectory -AclObject $acl
$keyStore = Join-Path $signingDirectory 'lolicode-android.p12'
$passwordFile = Join-Path $signingDirectory 'lolicode-android.password.dpapi'
$existingKeys = @(Get-ChildItem -LiteralPath $signingDirectory -File -Force | Where-Object { $_.Extension -in @('.p12', '.jks', '.keystore') })
if (!(Test-Path -LiteralPath $keyStore) -and $existingKeys.Count -gt 0) { throw 'Existing Android keys were found under another name; refusing to replace them.' }
if ((Test-Path -LiteralPath $keyStore) -and !(Test-Path -LiteralPath $passwordFile)) { throw 'Existing Android key has no saved DPAPI password; refusing to overwrite it.' }

$bstr = [IntPtr]::Zero
$generatedPassword = $null
try {
    if (Test-Path -LiteralPath $passwordFile) {
        $securePassword = ConvertTo-SecureString (Get-Content -LiteralPath $passwordFile -Raw)
    } else {
        $generatedPassword = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
        $securePassword = ConvertTo-SecureString $generatedPassword -AsPlainText -Force
        ConvertFrom-SecureString $securePassword | Set-Content -LiteralPath $passwordFile -Encoding ascii -NoNewline
        $generatedPassword = $null
    }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $env:LOLICODE_ANDROID_STORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if (!(Test-Path -LiteralPath $keyStore)) {
        & $keytool -genkeypair -keystore $keyStore -storetype PKCS12 -alias lolicode-android `
            -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=LoliCode Android,O=LoliCode,C=CN' `
            -storepass:env LOLICODE_ANDROID_STORE_PASSWORD -keypass:env LOLICODE_ANDROID_STORE_PASSWORD -noprompt
        if ($LASTEXITCODE -ne 0) { throw 'Android key generation failed. Existing files are preserved.' }
    }
    & $zipalign -f -P 16 4 $InputApk $alignedApk
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
    & $apksigner sign --ks $keyStore --ks-key-alias lolicode-android `
        --ks-pass env:LOLICODE_ANDROID_STORE_PASSWORD --key-pass env:LOLICODE_ANDROID_STORE_PASSWORD `
        --min-sdk-version 26 --v4-signing-enabled false --out $OutputApk $alignedApk
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & $zipalign -c -P 16 4 $OutputApk
    if ($LASTEXITCODE -ne 0) { throw 'Signed APK alignment verification failed.' }
    $verification = @(& $apksigner verify --verbose --print-certs $OutputApk)
    if ($LASTEXITCODE -ne 0) { throw 'Signed APK verification failed.' }
    $verification | Write-Output
    $certificateMatch = [regex]::Match(($verification -join "`n"), 'Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]+)')
    if (!$certificateMatch.Success) { throw 'Cannot read Android signing certificate fingerprint.' }
    [pscustomobject]@{
        apk = $OutputApk
        applicationId = $packageMatch.Groups[1].Value
        versionName = $versionName
        versionCode = [int]$packageMatch.Groups[2].Value
        minSdk = 26
        bytes = (Get-Item -LiteralPath $OutputApk).Length
        sha256 = (Get-FileHash -LiteralPath $OutputApk -Algorithm SHA256).Hash.ToLowerInvariant()
        certificateSha256 = $certificateMatch.Groups[1].Value.ToLowerInvariant()
        keyStore = $keyStore
    } | ConvertTo-Json
} finally {
    Remove-Item Env:\LOLICODE_ANDROID_STORE_PASSWORD -ErrorAction SilentlyContinue
    if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $generatedPassword = $null
    if ($securePassword) { $securePassword.Dispose() }
}

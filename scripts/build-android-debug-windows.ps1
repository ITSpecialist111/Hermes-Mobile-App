<#
.SYNOPSIS
  Builds a debug Android APK on Windows without Developer Mode.

.DESCRIPTION
  `tauri android build` compiles the Rust library and then symlinks it into jniLibs, which
  Windows refuses without Developer Mode or SeCreateSymbolicLinkPrivilege. This script lets
  Tauri build the frontend and Rust libraries, copies (instead of symlinking) each library
  into jniLibs, strips debug info, and runs Gradle with the Rust tasks skipped.

.EXAMPLE
  .\scripts\build-android-debug-windows.ps1                 # arm64 phones + x86_64 emulator
  .\scripts\build-android-debug-windows.ps1 -Targets aarch64 -Install
#>
[CmdletBinding()]
param(
    [ValidateSet('aarch64', 'x86_64')]
    [string[]]$Targets = @('aarch64', 'x86_64'),
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not $env:NDK_HOME) {
    $ndk = Get-ChildItem (Join-Path $env:ANDROID_HOME 'ndk') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $ndk) { throw "No Android NDK found under $env:ANDROID_HOME\ndk" }
    $env:NDK_HOME = $ndk.FullName
}
$strip = Get-ChildItem (Join-Path $env:NDK_HOME 'toolchains\llvm\prebuilt\*\bin\llvm-strip.exe') | Select-Object -First 1 -ExpandProperty FullName

$map = @{ aarch64 = @('aarch64-linux-android', 'arm64-v8a'); x86_64 = @('x86_64-linux-android', 'x86_64') }
$androidDir = Join-Path $repoRoot 'src-tauri\gen\android'

foreach ($target in $Targets) {
    $triple, $abi = $map[$target]
    Write-Host "== Building Rust library for $target" -ForegroundColor Cyan
    # The symlink step at the end is expected to fail; Tauri only reaches it after cargo succeeded.
    $log = & npx -y pnpm@10 tauri android build --debug --apk --target $target 2>&1
    $buildExit = $LASTEXITCODE
    $lib = Join-Path $repoRoot "src-tauri\target\$triple\debug\libhermes_mobile_app_lib.so"
    $reachedSymlink = ($log | Out-String) -match 'symbolic link'
    if (-not (Test-Path $lib) -or ($buildExit -ne 0 -and -not $reachedSymlink)) {
        $log | Select-Object -Last 40 | Out-Host
        throw "Rust build failed for $target"
    }
    $dest = Join-Path $androidDir "app\src\main\jniLibs\$abi"
    New-Item -ItemType Directory -Force $dest | Out-Null
    $out = Join-Path $dest 'libhermes_mobile_app_lib.so'
    Remove-Item $out -Force -ErrorAction SilentlyContinue
    Copy-Item $lib $out
    if ($strip) { & $strip --strip-debug $out }
}

Write-Host '== Packaging APK with Gradle (Rust tasks skipped)' -ForegroundColor Cyan
Push-Location $androidDir
try {
    $apk = 'app\build\outputs\apk\universal\debug\app-universal-debug.apk'
    # Incremental packaging keeps dead space from earlier libraries; always repackage cleanly.
    Remove-Item $apk -Force -ErrorAction SilentlyContinue
    Remove-Item 'app\build\intermediates\incremental\packageUniversalDebug' -Recurse -Force -ErrorAction SilentlyContinue
    $skip = 'rustBuildUniversalDebug', 'rustBuildArm64Debug', 'rustBuildArmDebug', 'rustBuildX86Debug', 'rustBuildX86_64Debug' | ForEach-Object { '-x', $_ }
    & .\gradlew.bat assembleUniversalDebug @skip --console=plain -q
    if ($LASTEXITCODE -ne 0) { throw 'Gradle packaging failed' }
    $apkPath = (Resolve-Path $apk).Path
    Write-Host ("APK: {0} ({1:N0} MB)" -f $apkPath, ((Get-Item $apkPath).Length / 1MB)) -ForegroundColor Green
    if ($Install) { & adb install -r $apkPath; if ($LASTEXITCODE -ne 0) { throw 'adb install failed' } }
}
finally { Pop-Location }

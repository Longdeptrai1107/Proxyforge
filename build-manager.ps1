param([string]$JavaHome = '', [string]$OutputJar = '')
$ErrorActionPreference = 'Stop'
$candidates = @()
if ($JavaHome) { $candidates += Join-Path $JavaHome 'bin\java.exe' }
$candidates += Join-Path $PSScriptRoot 'toolchain\java\bin\java.exe'
if ($env:JAVA_HOME) { $candidates += Join-Path $env:JAVA_HOME 'bin\java.exe' }
$command = Get-Command java -ErrorAction SilentlyContinue
if ($command) { $candidates += $command.Source }
$java = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $java) { throw 'Install JDK 17+ or pass -JavaHome.' }
$jdk = Split-Path (Split-Path $java -Parent) -Parent
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build.ps1') -JavaHome $jdk
if ($LASTEXITCODE -ne 0) { throw 'Game build failed.' }
$output = Join-Path $PSScriptRoot 'account-manager\bin\java'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$sources = @(Get-ChildItem (Join-Path $PSScriptRoot 'account-manager') -Filter '*.java' -File | ForEach-Object FullName)
$sources = @($sources | Where-Object { (Split-Path $_ -Leaf) -ne 'PackageManager.java' })
$sources += @(Get-ChildItem (Join-Path $PSScriptRoot 'account-manager\qltk') -Filter '*.java' -Recurse -File | ForEach-Object FullName)
& (Join-Path $jdk 'bin\javac.exe') --release 17 -encoding UTF-8 -cp (Join-Path $PSScriptRoot 'lib\microemulator-2.0.4.jar') -d $output @sources
if ($LASTEXITCODE -ne 0) { throw 'Java account manager build failed.' }
if (-not $OutputJar) { $OutputJar = Join-Path $PSScriptRoot 'QLTK.jar' }
& $java (Join-Path $PSScriptRoot 'account-manager\PackageManager.java') $PSScriptRoot $OutputJar
if ($LASTEXITCODE -ne 0) { throw 'Standalone JAR packaging failed.' }
if (([IO.Path]::GetFullPath($OutputJar)) -eq (Join-Path $PSScriptRoot 'QLTK.jar')) {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'release') -Force | Out-Null
    Copy-Item -LiteralPath $OutputJar -Destination (Join-Path $PSScriptRoot 'release\QLTK.jar') -Force
}
Write-Host "Run: java -jar $OutputJar"

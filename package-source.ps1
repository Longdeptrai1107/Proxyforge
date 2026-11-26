param([string]$OutputZip = '')
$ErrorActionPreference = 'Stop'
if (-not $OutputZip) { $OutputZip = Join-Path $PSScriptRoot 'release\nro-qltk-java-source.zip' }
$files = @('.classpath', '.project', '.gitattributes', '.gitignore', 'README.md', 'LICENSE.md',
    'THIRD_PARTY_NOTICES.md', 'QuanLyTaiKhoan.cmd', 'build.ps1', 'eclipse-build.ps1',
    'build-manager.ps1', 'test-manager.ps1', 'run.ps1', 'package-source.ps1', 'toolchain\StandaloneJarBuild.java')
foreach ($directory in @('src', 'config', 'lib', 'LICENSES', '.settings', '.externalToolBuilders')) {
    $base = Join-Path $PSScriptRoot $directory
    $files += @(Get-ChildItem -LiteralPath $base -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1) })
}
$files += @(Get-ChildItem (Join-Path $PSScriptRoot 'account-manager') -File -Filter '*.java' | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1) })
foreach ($directory in @('account-manager\qltk', 'account-manager\tests')) {
    $files += @(Get-ChildItem (Join-Path $PSScriptRoot $directory) -Recurse -File -Filter '*.java' | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1) })
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$target = [IO.Path]::GetFullPath($OutputZip)
New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
$stream = [IO.File]::Open($target, [IO.FileMode]::Create)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in ($files | Sort-Object -Unique)) {
        $source = Join-Path $PSScriptRoot $relative
        $entry = $archive.CreateEntry('nro-qltk-java/' + $relative.Replace('\', '/'), [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $input = [IO.File]::OpenRead($source); $output = $entry.Open()
        try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
} finally { $archive.Dispose(); $stream.Dispose() }
Write-Host "Source ZIP: $target ($((Get-Item -LiteralPath $target).Length) bytes)"

param([string]$Compiler = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root "winforms"
$output = Join-Path $source "ProxyForge.WinForms.exe"
$inputs = @((Join-Path $source "Program.cs"), (Join-Path $source "MainForm.cs"), $MyInvocation.MyCommand.Path)
if ((Test-Path $output) -and -not ($inputs | Where-Object { (Get-Item $_).LastWriteTimeUtc -gt (Get-Item $output).LastWriteTimeUtc })) {
    Write-Host "WinForms is up to date: $output"
    exit 0
}

if (-not $Compiler) {
    $candidates = @(
        (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
    )
    $Compiler = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Compiler -or -not (Test-Path $Compiler)) {
    throw "C# compiler not found. Install .NET Framework 4.8 Developer Pack or Visual Studio Build Tools."
}

$references = @("System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll", "System.Net.Http.dll", "System.Web.Extensions.dll")
$compilerArgs = @("/nologo", "/target:winexe", "/optimize+", "/langversion:5", "/out:$output")
foreach ($reference in $references) { $compilerArgs += "/reference:$reference" }
$compilerArgs += @((Join-Path $source "Program.cs"), (Join-Path $source "MainForm.cs"))
& $Compiler @compilerArgs
if ($LASTEXITCODE -ne 0) { throw "WinForms compilation failed ($LASTEXITCODE)." }
Write-Host "Built $output"

param([string]$DataDirectory = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Application]::EnableVisualStyles()
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $DataDirectory) { $DataDirectory = Join-Path $env:TEMP ("proxyforge-winforms-" + [Guid]::NewGuid().ToString("N")) }
$dataPath = [IO.Path]::GetFullPath($DataDirectory)
if (Test-Path $dataPath) { throw "Use a new directory to keep this smoke test isolated: $dataPath" }
[IO.Directory]::CreateDirectory($dataPath) | Out-Null
$previousData = $env:PROXYFORGE_DATA
$env:PROXYFORGE_DATA = $dataPath
$catalog = Get-Content -LiteralPath (Join-Path $root "proxyforge\sources.json") -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($source in $catalog) { $source.enabled = $false }
$state = @{ version = 1; automation = @{ enabled = $false }; sources = @($catalog); proxies = @(@{
    id = "http://8.8.8.8:9"; host = "8.8.8.8"; port = 9; protocol = "http"; status = "alive";
    countryCode = "VN"; city = "Hanoi"; server = "Smoke test ISP"; asn = 7552; sources = @("manual")
}) }
[IO.File]::WriteAllText((Join-Path $dataPath "state.json"), ($state | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
$assembly = [Reflection.Assembly]::LoadFrom((Join-Path $root "winforms\ProxyForge.WinForms.exe"))
$formType = $assembly.GetType("ProxyForge.WinForms.MainForm", $true)
$form = [Activator]::CreateInstance($formType, $true)
$flags = [Reflection.BindingFlags]"NonPublic,Instance"
function Field([string]$Name) { return $formType.GetField($Name, $flags).GetValue($form) }
function Wait-Ui([scriptblock]$Condition, [string]$Failure) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (& $Condition)) {
        [Windows.Forms.Application]::DoEvents()
        if ($watch.Elapsed.TotalSeconds -gt 20) { throw $Failure }
        Start-Sleep -Milliseconds 15
    }
    [Windows.Forms.Application]::DoEvents()
}
try {
    Write-Host "Starting WinForms and its isolated backend..."
    $form.Show()
    Wait-Ui { (Field "stopButton").Enabled } "Desktop backend did not start automation without a button click."
    if ((Field "collectButton").Visible) { throw "Startup must not ask for a start click." }
    if ((Field "concurrency").SelectedItem -notlike "10,000*") { throw "Expected 10,000 concurrent checks by default." }
    if ((Field "timeout").Text -notlike "3 seconds*" -or (Field "timeout").Enabled) { throw "Expected fixed 3-second timeout." }
    $country = Field "countryFilter"
    $grid = Field "grid"
    if ($country.Items.Count -ne 251) { throw "Expected all/unknown plus 249 countries." }
    if (-not $grid.Columns.Contains("server") -or -not $grid.Columns.Contains("location")) { throw "Server/location columns are missing." }
    Wait-Ui { $grid.Rows.Count -eq 1 } "Saved proxy did not load in the grid."
    if ($grid.Rows[0].Cells["server"].Value -notlike "*Smoke test ISP*" -or $grid.Rows[0].Cells["location"].Value -notlike "*Hanoi*") { throw "Server/location metadata was not displayed." }
    $country.SelectedIndex = 1
    Wait-Ui { $grid.Rows.Count -eq 0 } "Unknown-country filter did not filter the grid."
    $country.SelectedIndex = 0
    Wait-Ui { $grid.Rows.Count -eq 1 } "All-country filter did not restore the grid."
    $client = Field "http"
    $token = Field "token"
    function Post-Api([string]$Path, [string]$Json) {
        $request = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::Post, $Path)
        $request.Headers.Add("X-Proxy-Forge-Token", $token)
        $request.Content = New-Object Net.Http.StringContent($Json, [Text.Encoding]::UTF8, "application/json")
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            try { $response.EnsureSuccessStatusCode() | Out-Null } finally { $response.Dispose() }
        } finally { $request.Dispose() }
    }
    Post-Api "api/stop" '{}'
    Wait-Ui { (Field "collectButton").Enabled -and -not (Field "stopButton").Enabled } "Could not pause the backend before checking the fixture."
    Post-Api "api/check" '{}'
    Wait-Ui { $grid.Rows.Count -eq 0 -and (Field "collectButton").Enabled } "Completed check did not remove the failed proxy."
    $credit = @($form.Controls | ForEach-Object { $_.Controls } | ForEach-Object { $_.Controls } | Where-Object { $_.Text -eq "IP Geolocation by DB-IP" })
    if (-not $credit) { throw "DB-IP attribution is missing." }
    Post-Api "api/sources/toggle" '{"ids":["gcrawlai-web"],"enabled":true}'
    (Field "collectButton").PerformClick()
    Wait-Ui { (Field "stopButton").Enabled -and (Field "autoLabel").Text -like "Backend auto*" } "Resume button did not enable the recurring job."
    (Field "stopButton").PerformClick()
    Wait-Ui { (Field "collectButton").Enabled -and -not (Field "stopButton").Enabled } "Stop button did not disable automation."
    (Field "checkButton").PerformClick()
    Wait-Ui { (Field "stopButton").Enabled } "Immediate collect + check button did not start a refresh."
    (Field "stopButton").PerformClick()
    Wait-Ui { (Field "collectButton").Enabled -and -not (Field "stopButton").Enabled } "Stop did not cancel the immediate refresh."
    Write-Host "PASS: WinForms + real Python backend starts automatically; 10,000 concurrency / 3-second timeout; 249 countries; metadata; live-only grid; pause/resume; immediate refresh."
    Write-Host "QA data: $dataPath"
} finally {
    $form.Close()
    Wait-Ui { $form.IsDisposed } "Desktop did not finish saving and closing its backend."
    $form.Dispose()
    $env:PROXYFORGE_DATA = $previousData
}

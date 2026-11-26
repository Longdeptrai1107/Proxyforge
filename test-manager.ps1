param([string]$JarPath = '')
$ErrorActionPreference = 'Stop'
if (-not $JarPath) { $JarPath = Join-Path $PSScriptRoot 'QLTK.jar' }
$java = (Get-Command java -ErrorAction Stop).Source
$javac = Join-Path (Split-Path $java -Parent) 'javac.exe'
$classes = Join-Path $PSScriptRoot '.build\account-tests'
New-Item -ItemType Directory -Path $classes -Force | Out-Null
$sources = @(Get-ChildItem (Join-Path $PSScriptRoot 'account-manager\tests') -Filter '*.java' -Recurse | ForEach-Object FullName)
$sources += Join-Path $PSScriptRoot 'src\main\java\nro\AccountAutomation.java'
& $javac --release 17 -encoding UTF-8 -cp $JarPath -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'Automation test compilation failed' }
& $java -cp $classes nro.AutomationTest
if ($LASTEXITCODE -ne 0) { throw 'Automation state test failed' }
& $java -cp $classes nro.AutomationTest manual
if ($LASTEXITCODE -ne 0) { throw 'Manual launch regression test failed' }
& $java -jar $JarPath --self-test
if ($LASTEXITCODE -ne 0) { throw 'Standalone JAR integration tests failed' }
& $java -jar $JarPath --flow-test
if ($LASTEXITCODE -ne 0) { throw 'Actual UI/download/play/login socket tests failed' }
& $java -cp "$JarPath;$classes" ProxyIntegrationTest
if ($LASTEXITCODE -ne 0) { throw 'Proxy transport and actual game proxy tests failed' }
& $java -Xms16m -Xmx96m '-XX:+UseSerialGC' '-XX:+DisableExplicitGC' -cp "$JarPath;$classes" RuntimeResourceTest (Join-Path $PSScriptRoot '.build\runtime-resource-test.json')
if ($LASTEXITCODE -ne 0) { throw 'Game resource scheduling and minimized rendering tests failed' }

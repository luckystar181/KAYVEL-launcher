param([Parameter(Mandatory=$true)][string]$Build, [Parameter(Mandatory=$true)][string]$Portable)
$ErrorActionPreference = 'Stop'
$Build = [IO.Path]::GetFullPath($Build)
$Portable = [IO.Path]::GetFullPath($Portable)
$root = Join-Path $env:LOCALAPPDATA ('Temp\opencode\kayvel-embedded-artifact-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition 'public sealed class KayvelQuietProgress : System.IProgress<int> { public void Report(int value) { if (value < 0 || value > 100) throw new System.Exception("Invalid progress"); } }'
$exe = Join-Path $Build 'KAYVEL-Setup-v3S.exe'
$assembly = [Reflection.Assembly]::LoadFile($exe)
$reader = New-Object IO.StreamReader($assembly.GetManifestResourceStream('installer-settings.json'))
try { $embedded = $reader.ReadToEnd() } finally { $reader.Dispose() }
$expected = [IO.File]::ReadAllText((Join-Path $Build 'installer-settings.json'))
if ($embedded -ne $expected) { throw 'Embedded settings differ' }
$config = $embedded | ConvertFrom-Json
$settings = New-Object KayvelSetup.Settings
$settings.Version = $config.Version
$settings.Url = $config.Url
$settings.Bytes = $config.Bytes
$settings.Sha256 = $config.Sha256
$settings.Validate()
$destination = Join-Path $root 'extracted'
$payload = $assembly.GetManifestResourceStream('launcher-payload.zip')
if ($null -eq $payload) { throw 'Missing embedded payload' }
try {
    [KayvelSetup.InstallerCore]::ExtractVerified($payload, $settings, $destination, (New-Object KayvelQuietProgress), [Threading.CancellationToken]::None)
} finally { $payload.Dispose() }
$sourceFiles = @(Get-ChildItem -LiteralPath $Portable -File -Recurse)
$extractedFiles = @(Get-ChildItem -LiteralPath $destination -File -Recurse)
if ($sourceFiles.Count -ne $extractedFiles.Count) { throw 'File count differs' }
foreach ($source in $sourceFiles) {
    $relative = $source.FullName.Substring($Portable.Length).TrimStart('\')
    $target = Join-Path $destination $relative
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $source.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash) { throw ('File differs: ' + $relative) }
}
$package = Get-Content -LiteralPath (Join-Path $destination 'resources\app\package.json') -Raw | ConvertFrom-Json
if ('v' + $package.version + '-v3S' -ne $settings.Version) { throw 'Wrong packaged launcher version' }
$java = Join-Path $destination 'resources\app\bundled\java.zip'
if ((Get-Item -LiteralPath $java).Length -ne 49106397 -or (Get-FileHash -Algorithm SHA256 -LiteralPath $java).Hash.ToLowerInvariant() -ne '2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628') { throw 'Wrong bundled Java' }
if (!(Test-Path -LiteralPath (Join-Path $destination 'resources\app\bundled\jdk-21.0.13+9-jre\legal\java.base\LICENSE')) -or !(Test-Path -LiteralPath (Join-Path $destination 'resources\app\bundled\jdk-21.0.13+9-jre\NOTICE'))) { throw 'Missing unpacked Java notices' }
Write-Output ('PASS: native extraction from actual EXE resource with SHA-256; all ' + $sourceFiles.Count + ' files match portable; pinned Java and notices present. No network, launcher, shortcut or game execution.')
Write-Output ('Extracted app: ' + (Join-Path $destination 'resources\app'))
Get-Content -LiteralPath (Join-Path $Build 'SHA256SUMS.txt')

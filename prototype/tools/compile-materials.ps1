param([string]$Matc = $env:MATC)

$ErrorActionPreference = 'Stop'
if (-not $Matc) { $Matc = 'matc' }
$compiler = (Get-Command $Matc -ErrorAction Stop).Source
$version = (& $compiler --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -ne '56') {
    throw 'Use matc from Filament 1.56.0 (material version 56), matching the Android dependency.'
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    & $compiler --platform mobile --api opengl --api vulkan --optimize-size `
        -o src/main/assets/orb.filamat src/main/materials/orb.mat
    if ($LASTEXITCODE -ne 0) { throw 'Material compilation failed.' }
} finally {
    Pop-Location
}

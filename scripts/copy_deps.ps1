$root = "f:/qvactext/text2/node_modules"
$dest = "f:/qvactext/text2/dist/QVAC Assistant/resources/app/node_modules"

$pkgs = @(
    "@qvac/sdk",
    "bare-rpc", "bare-runtime", "bare-runtime-win32-x64",
    "require-asset", "bare-module-resolve", "bare-semver",
    "safety-catch", "b4a", "compact-encoding"
)

foreach ($pkg in $pkgs) {
    $src = Join-Path $root $pkg
    $dst = Join-Path $dest $pkg
    if (Test-Path $src) {
        New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
        Copy-Item $src $dst -Recurse -Force
        Write-Output "COPIED: $pkg"
    } else {
        Write-Output "NOT FOUND: $pkg at $src"
    }
}
Write-Output "DONE"

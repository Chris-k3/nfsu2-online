# Package installed NFSU2 game for GitHub Codespaces
$sourcePath = "C:\Program Files (x86)\EA GAMES\Need for Speed Underground 2"
$zipPath = Join-Path $PSScriptRoot "game.zip"

if (-not (Test-Path "$sourcePath\SPEED2.EXE")) {
    Write-Host "Error: SPEED2.EXE not found in $sourcePath" -ForegroundColor Red
    exit 1
}

Write-Host "Packaging game files from $sourcePath into $zipPath ..." -ForegroundColor Cyan
Write-Host "This may take 1-2 minutes..." -ForegroundColor Yellow

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# Compress game directory
Compress-Archive -Path "$sourcePath\*" -DestinationPath $zipPath -CompressionLevel Optimal

$sizeMB = (Get-Item $zipPath).Length / 1MB
Write-Host "DONE! Created game.zip ($([math]::Round($sizeMB, 2)) MB)" -ForegroundColor Green
Write-Host "You can drag and drop 'game.zip' directly into your GitHub Codespace file explorer!" -ForegroundColor Cyan

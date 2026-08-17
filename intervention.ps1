$url = "http://example.com"

$chrome = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
    Write-Error "Google Chrome was not found."
    exit 1
}

while ($true) {
    # Wait for an even clock minute.
    do {
        Start-Sleep -Seconds 1
        $now = Get-Date
    } while ($now.Minute % 2 -ne 0)

    $process = Start-Process `
        -FilePath $chrome `
        -ArgumentList "--kiosk `"$url`" --no-first-run --disable-session-crashed-bubble" `
        -PassThru

    Start-Sleep -Seconds 60

    if (!$process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 2
}
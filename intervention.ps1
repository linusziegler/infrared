$url = "http://example.com"

Write-Host "Started: $(Get-Date)"
Write-Host ""

$chrome = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (!(Test-Path $chrome)) {
    Write-Host "ERROR: Chrome was not found at:"
    Write-Host $chrome
    exit 1
}

Write-Host "Chrome executable found."
Write-Host ""

while ($true) {

    # Wait for an even-numbered clock minute
    Write-Host "Waiting for next even clock minute..."

    do {
        Start-Sleep -Seconds 1
    } while ((Get-Date).Minute % 2 -ne 0)

    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Launching Chrome..."

    # Open Chrome
    Start-Process $chrome `
        -ArgumentList "--kiosk `"$url`" --start-fullscreen"

    Write-Host "Chrome launch command sent."

    # Give Chrome time to open
    Write-Host "Waiting 2 seconds for Chrome to initialize..."
    Start-Sleep -Seconds 2

    # Bring Chrome to the foreground
    Write-Host "Attempting to bring Chrome to the foreground..."

    $shell = New-Object -ComObject WScript.Shell

    if ($shell.AppActivate("Google Chrome")) {
        Write-Host "SUCCESS: Chrome is now in the foreground."
    }
    else {
        Write-Host "WARNING: Could not activate Chrome window."
    }

    # Leave it open for 1 minute
    Write-Host "Chrome will remain open for 60 seconds."
    Start-Sleep -Seconds 60

    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Closing Chrome..."

    # Close Chrome
    $chromeProcesses = Get-Process chrome -ErrorAction SilentlyContinue

    if ($chromeProcesses) {
        $chromeProcesses | Stop-Process -Force
        Write-Host "Chrome processes terminated."
    }
    else {
        Write-Host "WARNING: No Chrome process found."
    }

    Write-Host "Cycle complete."
    Write-Host ""

    # Avoid triggering twice during the same minute
    Start-Sleep -Seconds 2
}
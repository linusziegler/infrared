# ============================================================
# Chrome Kiosk Script
# ============================================================

$url = "http://example.com"

# How long Chrome should remain open
$displaySeconds = 60

# Dedicated Chrome profile
$kioskProfile = Join-Path $env:TEMP "ChromeKioskProfile"

# ------------------------------------------------------------
# Initialization
# ------------------------------------------------------------

Write-Host "=========================================="
Write-Host " Chrome Kiosk Script"
Write-Host "=========================================="
Write-Host "URL: $url"
Write-Host ""

# ------------------------------------------------------------
# Find Chrome
# ------------------------------------------------------------

$chrome = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
) |
Where-Object { Test-Path $_ } |
Select-Object -First 1

if (-not $chrome) {
    Write-Host "ERROR: Chrome was not found."
    exit 1
}

Write-Host "Chrome executable found: $chrome"
Write-Host "Chrome profile: $kioskProfile"
Write-Host "Initialization complete."
Write-Host ""

# ------------------------------------------------------------
# Windows API
# ------------------------------------------------------------

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class Win32 {

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(
        IntPtr hWnd,
        out uint processId
    );

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(
        uint idAttach,
        uint idAttachTo,
        bool fAttach
    );

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
}
"@

# ------------------------------------------------------------
# Get Chrome processes belonging to our kiosk profile
# ------------------------------------------------------------

function Get-KioskChromeProcesses {

    try {
        return @(
            Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -like "*$kioskProfile*"
            }
        )
    }
    catch {
        return @()
    }
}

# ------------------------------------------------------------
# Find the visible Chrome window
# ------------------------------------------------------------

function Get-KioskChromeWindow {

    $processes = Get-KioskChromeProcesses

    foreach ($process in $processes) {

        $processId = [uint32]$process.ProcessId

        try {
            $chromeProcess = Get-Process `
                -Id $processId `
                -ErrorAction SilentlyContinue

            if ($chromeProcess -and
                $chromeProcess.MainWindowHandle -ne 0) {

                $hwnd = [IntPtr]$chromeProcess.MainWindowHandle

                if ([Win32]::IsWindowVisible($hwnd)) {
                    return $hwnd
                }
            }
        }
        catch {
            # Process may have exited
        }
    }

    return [IntPtr]::Zero
}

# ------------------------------------------------------------
# Bring Chrome to foreground
# ------------------------------------------------------------

function Set-KioskChromeForeground {

    for ($attempt = 1; $attempt -le 15; $attempt++) {

        $hwnd = Get-KioskChromeWindow

        if ($hwnd -eq [IntPtr]::Zero) {
            Start-Sleep -Milliseconds 500
            continue
        }

        # Restore the window
        [Win32]::ShowWindow($hwnd, 9) | Out-Null

        # Get Chrome's UI thread
        [uint32]$chromeThreadId = 0

        [Win32]::GetWindowThreadProcessId(
            $hwnd,
            [ref]$chromeThreadId
        ) | Out-Null

        # Get our PowerShell thread
        $currentThreadId = [Win32]::GetCurrentThreadId()

        # Temporarily attach input queues
        if ($chromeThreadId -ne 0 -and
            $currentThreadId -ne 0 -and
            $chromeThreadId -ne $currentThreadId) {

            [Win32]::AttachThreadInput(
                $currentThreadId,
                $chromeThreadId,
                $true
            ) | Out-Null
        }

        # Bring Chrome forward
        [Win32]::BringWindowToTop($hwnd) | Out-Null
        [Win32]::SetForegroundWindow($hwnd) | Out-Null

        # Detach input queues
        if ($chromeThreadId -ne 0 -and
            $currentThreadId -ne 0 -and
            $chromeThreadId -ne $currentThreadId) {

            [Win32]::AttachThreadInput(
                $currentThreadId,
                $chromeThreadId,
                $false
            ) | Out-Null
        }

        Start-Sleep -Milliseconds 300

        # Verify foreground window
        if ([Win32]::GetForegroundWindow() -eq $hwnd) {
            return $true
        }

        Start-Sleep -Milliseconds 500
    }

    return $false
}

# ------------------------------------------------------------
# Close only our kiosk Chrome processes
# ------------------------------------------------------------

function Stop-KioskChrome {

    $processes = Get-KioskChromeProcesses

    if (-not $processes) {
        return
    }

    foreach ($process in $processes) {

        try {
            Stop-Process `
                -Id $process.ProcessId `
                -Force `
                -ErrorAction SilentlyContinue
        }
        catch {
            # Process may already have exited
        }
    }

    Start-Sleep -Seconds 1
}

# ------------------------------------------------------------
# Main loop
# ------------------------------------------------------------

while ($true) {

    # Wait for an even-numbered clock minute
    do {
        Start-Sleep -Seconds 1
    }
    while ((Get-Date).Minute % 2 -ne 0)

    # Close any previous kiosk instance
    Stop-KioskChrome

    # Chrome arguments
    $arguments = @(
        "--user-data-dir=`"$kioskProfile`""
        "--kiosk"
        "--start-fullscreen"
        "--new-window"
        "--disable-session-crashed-bubble"
        "--no-first-run"
        "--no-default-browser-check"
        "`"$url`""
    )

    # Launch Chrome
    try {
        Start-Process `
            -FilePath $chrome `
            -ArgumentList $arguments
    }
    catch {
        Write-Host "ERROR: Failed to start Chrome."
        Write-Host $_
        Start-Sleep -Seconds 5
        continue
    }

    # Bring Chrome to foreground
    $focusSuccess = Set-KioskChromeForeground

    if (-not $focusSuccess) {
        Write-Host "WARNING: Could not bring Chrome to foreground."
    }

    # Keep Chrome open
    Start-Sleep -Seconds $displaySeconds

    # Close kiosk Chrome
    Stop-KioskChrome

    # Prevent duplicate trigger during the same minute
    Start-Sleep -Seconds 2
}
# ============================================================
# Chrome Kiosk Display Script
# ============================================================

$url = "http://example.com"

# How long Chrome should remain open
$displaySeconds = 60

# Dedicated Chrome profile for this kiosk script
$kioskProfile = Join-Path $env:TEMP "ChromeKioskProfile"

Write-Host "============================================================"
Write-Host " Chrome Kiosk Script"
Write-Host "============================================================"
Write-Host ""
Write-Host "URL: $url"
Write-Host "Chrome profile: $kioskProfile"
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

Write-Host "Chrome executable found:"
Write-Host $chrome
Write-Host ""

# ------------------------------------------------------------
# Load Windows API functions
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

    $processes = @()

    try {
        $processes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine -like "*$kioskProfile*"
            }
    }
    catch {
        Write-Host "WARNING: Could not query Chrome processes."
    }

    return $processes
}

# ------------------------------------------------------------
# Find the visible Chrome window for our kiosk process
# ------------------------------------------------------------

function Get-KioskChromeWindow {

    $processes = Get-KioskChromeProcesses

    foreach ($process in $processes) {

        $pid = [uint32]$process.ProcessId

        try {
            $p = Get-Process -Id $pid -ErrorAction SilentlyContinue

            if ($p -and $p.MainWindowHandle -ne 0) {

                $hwnd = [IntPtr]$p.MainWindowHandle

                if ([Win32]::IsWindowVisible($hwnd)) {
                    return $hwnd
                }
            }
        }
        catch {
            # Process may have exited between queries
        }
    }

    return [IntPtr]::Zero
}

# ------------------------------------------------------------
# Bring kiosk Chrome to foreground
# ------------------------------------------------------------

function Set-KioskChromeForeground {

    Write-Host "Attempting to bring Chrome to the foreground..."

    for ($attempt = 1; $attempt -le 15; $attempt++) {

        $hwnd = Get-KioskChromeWindow

        if ($hwnd -eq [IntPtr]::Zero) {
            Write-Host "  Chrome window not ready. Attempt $attempt/15..."
            Start-Sleep -Milliseconds 500
            continue
        }

        Write-Host "  Chrome window found."
        Write-Host "  HWND: $hwnd"

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

        Write-Host "  Chrome thread: $chromeThreadId"
        Write-Host "  Current thread: $currentThreadId"

        # Temporarily attach the input queues.
        # This helps bypass Windows foreground restrictions.
        if ($chromeThreadId -ne 0 -and
            $currentThreadId -ne 0 -and
            $chromeThreadId -ne $currentThreadId) {

            [Win32]::AttachThreadInput(
                $currentThreadId,
                $chromeThreadId,
                $true
            ) | Out-Null
        }

        # Bring Chrome to the front
        [Win32]::BringWindowToTop($hwnd) | Out-Null
        [Win32]::SetForegroundWindow($hwnd) | Out-Null

        # Detach again
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

        # Verify actual foreground window
        $foreground = [Win32]::GetForegroundWindow()

        if ($foreground -eq $hwnd) {
            Write-Host ""
            Write-Host "SUCCESS: Chrome is now the foreground window."
            Write-Host ""

            return $true
        }

        Write-Host "  Chrome did not become foreground."
        Write-Host "  Retrying..."

        Start-Sleep -Milliseconds 500
    }

    Write-Host ""
    Write-Host "WARNING: Could not make Chrome the foreground window."
    Write-Host ""

    return $false
}

# ------------------------------------------------------------
# Close only our kiosk Chrome processes
# ------------------------------------------------------------

function Stop-KioskChrome {

    Write-Host "Looking for kiosk Chrome processes..."

    $processes = Get-KioskChromeProcesses

    if (-not $processes) {
        Write-Host "No kiosk Chrome processes found."
        return
    }

    foreach ($process in $processes) {

        $pid = $process.ProcessId

        Write-Host "Stopping kiosk Chrome PID $pid..."

        try {
            Stop-Process -Id $pid -Force -ErrorAction Stop
        }
        catch {
            Write-Host "WARNING: Could not stop PID $pid."
        }
    }

    # Give Chrome a moment to shut down
    Start-Sleep -Seconds 1

    Write-Host "Kiosk Chrome processes terminated."
}

# ------------------------------------------------------------
# Main loop
# ------------------------------------------------------------

while ($true) {

    Write-Host ""
    Write-Host "============================================================"
    Write-Host "Waiting for next even clock minute..."
    Write-Host "Current time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Host "============================================================"

    # Wait until the minute is even
    do {
        Start-Sleep -Seconds 1
    }
    while ((Get-Date).Minute % 2 -ne 0)

    $launchTime = Get-Date

    Write-Host ""
    Write-Host "[$($launchTime.ToString('yyyy-MM-dd HH:mm:ss'))] Launching Chrome..."
    Write-Host ""

    # --------------------------------------------------------
    # Make sure an old kiosk Chrome instance isn't running
    # --------------------------------------------------------

    Stop-KioskChrome

    # --------------------------------------------------------
    # Launch Chrome
    # --------------------------------------------------------

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

    Write-Host "Starting Chrome..."

    try {

        Start-Process `
            -FilePath $chrome `
            -ArgumentList $arguments

        Write-Host "Chrome launch command sent."

    }
    catch {

        Write-Host "ERROR: Failed to start Chrome."
        Write-Host $_

        Start-Sleep -Seconds 5
        continue
    }

    # --------------------------------------------------------
    # Wait for Chrome and force it to foreground
    # --------------------------------------------------------

    Write-Host ""
    Write-Host "Waiting for Chrome to initialize..."

    $focusSuccess = Set-KioskChromeForeground

    if ($focusSuccess) {
        Write-Host "Chrome focus successfully acquired."
    }
    else {
        Write-Host "WARNING: Chrome focus could not be verified."
    }

    # --------------------------------------------------------
    # Keep Chrome visible
    # --------------------------------------------------------

    Write-Host ""
    Write-Host "Chrome will remain open for $displaySeconds seconds."
    Write-Host ""

    Start-Sleep -Seconds $displaySeconds

    # --------------------------------------------------------
    # Close kiosk Chrome
    # --------------------------------------------------------

    $closeTime = Get-Date

    Write-Host ""
    Write-Host "[$($closeTime.ToString('yyyy-MM-dd HH:mm:ss'))] Closing kiosk Chrome..."
    Write-Host ""

    Stop-KioskChrome

    Write-Host ""
    Write-Host "Cycle complete."
    Write-Host ""

    # --------------------------------------------------------
    # Prevent duplicate trigger during the same minute
    # --------------------------------------------------------

    Start-Sleep -Seconds 2
}
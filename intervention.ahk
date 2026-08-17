#Requires AutoHotkey v2.0

; --- CONFIGURATION ---
Url := "https://example.com"
; Set this to a word or phrase that appears in your target website's Window Title
SiteTitle := "Example Domain" 
ChromePath := "C:\Program Files\Google\Chrome\Application\chrome.exe"
; A dedicated folder for the kiosk profile to prevent merging with the user's personal Chrome
ProfilePath := "C:\ChromeKioskProfile" 

SetTitleMatchMode(2) ; Allow partial matching for the window title

; 1. Launch Chrome in Kiosk mode with the dedicated profile
Run('"' ChromePath '" --kiosk "' Url '" --user-data-dir="' ProfilePath '"')

; 2. Wait up to 15 seconds for the website to load and the window to exist
if WinWait(SiteTitle, , 15)
{
    ; 3. THE BULLETPROOF FOCUS TRICK
    ; Briefly forcing the window to be 'Always On Top' bypasses Windows' background-focus protections
    WinSetAlwaysOnTop(1, SiteTitle)
    
    ; Now that it is forcefully on top, grab the actual input focus
    WinActivate(SiteTitle)
    
    ; Remove 'Always On Top' so it acts like a normal fullscreen window again
    WinSetAlwaysOnTop(0, SiteTitle)
}
else
{
    ; Optional: Log an error or restart the process if the internet is down and the title never loads
    ExitApp
}
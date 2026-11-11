$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$notification = [System.Windows.Forms.NotifyIcon]::new()
try {
    $notification.Icon = [System.Drawing.SystemIcons]::Information
    $notification.Text = 'Figma Export'
    $notification.Visible = $true
    $notification.ShowBalloonTip(
        8000,
        'Figma verification required',
        'Switch to Chromium to complete verification.',
        [System.Windows.Forms.ToolTipIcon]::Info
    )
    $end = [DateTime]::UtcNow.AddSeconds(12)
    while ([DateTime]::UtcNow -lt $end) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100
    }
} finally {
    $notification.Visible = $false
    $notification.Dispose()
}


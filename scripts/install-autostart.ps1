# Registers a Windows Scheduled Task that starts the supervised bot at logon.
# Run once from an elevated or normal PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# Remove with scripts\uninstall-autostart.ps1
$root = Split-Path -Parent $PSScriptRoot
$taskName = "HZN-Bot-Auto"
$script = Join-Path $root "scripts\run-bot.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$script`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "HZN Bot Auto supervisor (mode comes from .env; paper by default)" -Force | Out-Null
Write-Host "Scheduled task '$taskName' registered. It starts at your next logon. Start now with: Start-ScheduledTask -TaskName $taskName"
Write-Host "IMPORTANT: Windows sleep/hibernate stops the bot and its software stop-loss. Set Power Options > Sleep = Never while positions are open."

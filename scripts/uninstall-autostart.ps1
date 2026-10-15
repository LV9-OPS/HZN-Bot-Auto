Unregister-ScheduledTask -TaskName "HZN-Bot-Auto" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Scheduled task HZN-Bot-Auto removed (a running bot is not stopped: use npm run stop)."

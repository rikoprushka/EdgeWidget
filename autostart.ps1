# Registers the "EdgeWidget Usage Server" task in Task Scheduler. It starts server.js when you sign in and
# every 5 minutes after that. A copy that finds the server already running exits straight away (the port is
# taken), so the task only brings the server back after something closed it: a Node.js update, a crash,
# a Claude session stopping it. It runs in your own session, like the Startup shortcut, through
# conhost --headless so no console window appears. No administrator rights needed. Run it again after
# moving this folder or reinstalling Node.js elsewhere:
#   powershell -ExecutionPolicy Bypass -File autostart.ps1
$ErrorActionPreference = 'Stop'
$me = "$env:USERDOMAIN\$env:USERNAME"
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument "--headless `"$node`" server.js" `
  -WorkingDirectory $PSScriptRoot
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $me),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
# No time limit: by default Task Scheduler stops a task after 3 days, which would stop the server.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'EdgeWidget Usage Server' -Action $action -Trigger $triggers -Settings $settings `
  -Principal $principal -Description "Keeps the Xeneon Edge usage widget server ($PSScriptRoot\server.js) running." -Force |
  Select-Object TaskName, State

$ports = 22,2222,445,3389,5985,5986,23
foreach ($p in $ports) {
  $r = Test-NetConnection -ComputerName 192.168.100.101 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue
  Write-Host "port $p : $r"
}

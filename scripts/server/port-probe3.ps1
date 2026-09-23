$src = '192.168.100.90'
$target = '192.168.100.101'
foreach ($p in @(22,2222,445,3389,5985,80,443,3000,8080,5432)) {
  $c = New-Object Net.Sockets.TcpClient
  $c.Client.Bind((New-Object Net.IPEndPoint([Net.IPAddress]::Parse($src), 0)))
  try {
    $task = $c.ConnectAsync($target, $p)
    if ($task.Wait(2000) -and $c.Connected) { Write-Host "port $p : OPEN" } else { Write-Host "port $p : closed" }
  } catch { Write-Host "port $p : closed" }
  $c.Close()
}

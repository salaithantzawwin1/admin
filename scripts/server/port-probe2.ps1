foreach ($p in @(80,443,3000,8080,5432,8000,8443,9090)) {
  $c = New-Object Net.Sockets.TcpClient
  try {
    $task = $c.ConnectAsync('192.168.100.101', $p)
    if ($task.Wait(1500) -and $c.Connected) { Write-Host "port $p : OPEN" } else { Write-Host "port $p : closed" }
  } catch { Write-Host "port $p : closed" }
  $c.Close()
}

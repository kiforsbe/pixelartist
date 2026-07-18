# Serves the app on a random unused port (ES modules need a server, file:// won't work)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

npx --yes serve -l $port .

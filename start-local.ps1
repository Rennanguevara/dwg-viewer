# Sobe um servidor HTTP local para a pasta public/ e abre o navegador.
# Uso: powershell -ExecutionPolicy Bypass -File .\start-local.ps1 [-Port 3000]
param([int]$Port = 3000)

Set-Location $PSScriptRoot

if (Get-Command python -ErrorAction SilentlyContinue) {
  python server.py $Port
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  py server.py $Port
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  Start-Process "http://localhost:$Port/"
  npx --yes serve public -l $Port
} else {
  Write-Error 'Instale Python (https://python.org) ou Node.js (https://nodejs.org) para servir os arquivos localmente.'
}

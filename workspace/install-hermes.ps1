param([switch]$ConfigureOnly)
$ErrorActionPreference = 'Stop'
$hermesRoot = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA 'hermes' }
if (-not $ConfigureOnly) {
    $scriptFile = Join-Path ([IO.Path]::GetTempPath()) ('hermes-install-' + [guid]::NewGuid() + '.ps1')
    Invoke-WebRequest 'https://hermes-agent.nousresearch.com/install.ps1' -OutFile $scriptFile
    # Official user-level installation; interactive setup and login are deliberately left to the user.
    & $scriptFile -NonInteractive
    if ($LASTEXITCODE) { throw 'Hermes installation failed' }
}
$installRoot = Join-Path $hermesRoot 'hermes-agent'
. (Join-Path $installRoot 'scripts/desktop-update/runtime.ps1')
$runtimeCommand = @(Get-HermesRuntimeCommand -InstallRoot $installRoot)
$bootstrap = "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); import hermes_bootstrap; runpy.run_path(sys.argv.pop(1), run_name='__main__')"
& $runtimeCommand[0] -I -c $bootstrap $installRoot (Join-Path $PSScriptRoot 'configure-hermes.py') --self-test
if ($LASTEXITCODE) { throw 'Hermes configuration self-check failed' }
& $runtimeCommand[0] -I -c $bootstrap $installRoot (Join-Path $PSScriptRoot 'configure-hermes.py')
if ($LASTEXITCODE) { throw 'Hermes configuration failed' }
# Noninteractive mode answers the optional UAC offer with its default false; Hermes uses its login-item fallback.
$env:HERMES_NONINTERACTIVE = '1'
$env:HERMES_GATEWAY_INSTALL_START_NOW = '0'
$env:HERMES_GATEWAY_INSTALL_START_ON_LOGIN = '1'
& (Join-Path $hermesRoot 'bin/hermes.exe') gateway install
if ($LASTEXITCODE) { throw 'Hermes login service installation failed' }
Write-Output 'Ready for user login: open a new terminal, run hermes model, choose ChatGPT or Codex Subscription; then hermes gateway start.'

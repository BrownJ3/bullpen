# Bullpen installer for Windows.
#
#   irm https://raw.githubusercontent.com/BrownJ3/bullpen/main/install.ps1 | iex
#
# What it does: makes sure Node 24+ is available (installs a private copy in ~\.bullpen\node if not), downloads
# Bullpen to ~\.bullpen\app at the latest release, installs its dependencies, adds a `bullpen` command, starts it
# when you sign in, puts Bullpen in the Start menu, and opens it. Run it again any time; it updates in place.
#
# Options (environment variables): BULLPEN_DIR, BULLPEN_REPO, BULLPEN_REF, BULLPEN_NO_SERVICE (see install.sh).

# Not 'Stop': git and npm write progress to stderr, which Windows PowerShell would treat as a failure. Exit codes are checked.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Repo = if ($env:BULLPEN_REPO) { $env:BULLPEN_REPO } else { 'https://github.com/BrownJ3/bullpen.git' }
$Data = if ($env:BULLPEN_HOME) { $env:BULLPEN_HOME } else { Join-Path $HOME '.bullpen' }
$Dir = if ($env:BULLPEN_DIR) { $env:BULLPEN_DIR } else { Join-Path $Data 'app' }
$NodeDir = Join-Path $Data 'node'
$NodeMajor = 24

function Info($s) { Write-Host "  $s" }
function Die($s) { Write-Host "Error: $s" -ForegroundColor Red; throw "Bullpen install failed." } # not exit: that would close the window

Write-Host 'Installing Bullpen' -ForegroundColor White

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Die 'git is missing. Install it with:  winget install Git.Git   (then open a new terminal and run this again)'
}

# ---------------------------------------------------------------- Node 24+
function NodeOk($exe) {
  try { & $exe -e "process.exit(Number(process.versions.node.split('.')[0]) >= $NodeMajor ? 0 : 1)" 2>$null; return $LASTEXITCODE -eq 0 } catch { return $false }
}
$Node = $null
$private = Join-Path $NodeDir 'node.exe'
if ((Test-Path $private) -and (NodeOk $private)) { $Node = $private }
elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (NodeOk (Get-Command node).Source)) { $Node = (Get-Command node).Source }
if (-not $Node) {
  Info "Node $NodeMajor isn't installed; getting a private copy for Bullpen (in $NodeDir)..."
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/latest-v$NodeMajor.x"
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing -ErrorAction Stop).Content
  $line = ($sums -split "`n") | Where-Object { $_ -match "node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Die "No Node $NodeMajor build for win-$arch." }
  $want, $file = ($line.Trim() -split '\s+')
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("bullpen-" + [guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  Invoke-WebRequest "$base/$file" -OutFile (Join-Path $tmp $file) -UseBasicParsing -ErrorAction Stop
  # Check the download against nodejs.org's published checksum.
  $got = (Get-FileHash (Join-Path $tmp $file) -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) { Die "The Node download didn't match its checksum; try again." }
  Expand-Archive (Join-Path $tmp $file) $tmp -ErrorAction Stop
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $NodeDir
  Remove-Item -Recurse -Force $tmp
  $Node = $private
  Info "Node $(& $Node -v) ready."
}
$NodeBin = Split-Path $Node
$env:Path = "$NodeBin;$env:Path"
$NpmCli = Join-Path $NodeBin 'node_modules\npm\bin\npm-cli.js'

# ---------------------------------------------------------------- the app
if (Test-Path (Join-Path $Dir '.git')) {
  Info "Updating $Dir..."
  git -C $Dir fetch --quiet --tags origin
} else {
  New-Item -ItemType Directory -Force (Split-Path $Dir) | Out-Null
  Info "Downloading Bullpen to $Dir..."
  git clone --quiet $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Die "Couldn't download $Repo." }
}

$Ref = $env:BULLPEN_REF
if (-not $Ref) { $Ref = git -C $Dir tag --list 'v[0-9]*' --sort=-v:refname | Select-Object -First 1 }
if ($Ref) {
  git -C $Dir checkout --quiet $Ref 2>$null
  if ($LASTEXITCODE -ne 0) { git -C $Dir checkout --quiet -B $Ref "origin/$Ref" }
} else {
  git -C $Dir pull --quiet --ff-only
}
Info "Version $(git -C $Dir describe --tags --always)"

Info 'Installing dependencies...'
Push-Location $Dir
& $Node $NpmCli ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
$npmOk = $LASTEXITCODE -eq 0
Pop-Location
if (-not $npmOk) { Die 'npm install failed (see above).' }

# ---------------------------------------------------------------- engines
$have = @('claude', 'codex') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------- command, startup, Start menu
$Cli = Join-Path $Dir 'src\cli.ts'
if ($env:BULLPEN_NO_SERVICE) {
  Write-Host 'Installed (no service, as asked).'
  Info "Run it with: & '$Node' '$Cli'"
} else {
  & $Node $Cli install
  & $Node $Cli open
}

Write-Host ''
if (-not $have) {
  Write-Host 'One more step: Bullpen drives Claude Code or Codex, and neither is installed.' -ForegroundColor White
  Info 'Claude Code:  irm https://claude.ai/install.ps1 | iex     then run `claude` once to sign in'
  Info 'Codex:        npm i -g @openai/codex                       then run `codex login`'
} else {
  Info "Found: $($have -join ', '). Bullpen uses their existing sign-ins."
}
Info 'Open a new terminal to use the `bullpen` command. Update later with: bullpen update'

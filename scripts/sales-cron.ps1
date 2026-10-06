# Lance la journée commerciale sans surveillance (Planificateur de tâches Windows).
#
# Tourne en local : la CLI et data/ sont sur ce PC. Chaque exécution laisse une
# trace dans logs/ (sortie complète) et logs/cron-runs.log (une ligne par lancement),
# en plus du journal habituel data/history/<jour>.jsonl écrit par la CLI.
#
# En mode -p rien ne peut être approuvé à la main : tout outil absent de
# --allowedTools est refusé. La liste reste donc minimale — pas de Write/Edit,
# pas de git push, aucun connecteur mail. Règle 3 : rien ne part sans l'approbation
# de Nicolas ; approve, send et clear-sending sont donc explicitement interdits ici.

# Aussi lancé depuis l'application interactive (node src/cli.ts), menu Agents.
param([string]$Command = '/sales', [string]$Model = 'sonnet')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logs = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$log = Join-Path $logs "sales-$stamp.log"
$runs = Join-Path $logs 'cron-runs.log'

Add-Content $runs "$(Get-Date -Format s)  START  $Command" -Encoding utf8

$allowed = @(
  'Agent', 'Task',
  'Bash(node src/cli.ts *)',
  'WebSearch', 'WebFetch',
  'Read', 'Glob', 'Grep'
)

# 'Bash(node src/cli.ts *)' ci-dessus couvrirait sinon ces commandes. Les lieux
# (trajets, jours sur site) sont des arbitrages de Nicolas : les agents les lisent.
$disallowed = @(
  'Bash(node src/cli.ts outreach:approve *)',
  'Bash(node src/cli.ts outreach:send *)',
  'Bash(node src/cli.ts outreach:clear-sending *)',
  'Bash(node src/cli.ts location:set *)',
  'Bash(node src/cli.ts location:add *)',
  'Bash(node src/cli.ts location:home *)'
)

& "$env:APPDATA\npm\claude.cmd" -p $Command --model $Model --allowedTools $allowed --disallowedTools $disallowed *>&1 | Tee-Object -FilePath $log
$code = $LASTEXITCODE

Add-Content $runs "$(Get-Date -Format s)  END    $Command  exit=$code  log=$(Split-Path -Leaf $log)" -Encoding utf8
exit $code

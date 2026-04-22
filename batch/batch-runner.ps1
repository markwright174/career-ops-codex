[CmdletBinding()]
param(
  [int]$Parallel = 1,
  [switch]$DryRun,
  [switch]$RetryFailed,
  [int]$StartFrom = 0,
  [int]$MaxRetries = 2,
  [string]$WorkerCli = $env:BATCH_WORKER_CLI
)

$ErrorActionPreference = 'Stop'

$script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ProjectDir = Split-Path -Parent $script:ScriptDir
$script:BatchDir = $script:ScriptDir
$script:InputFile = Join-Path $script:BatchDir 'batch-input.tsv'
$script:StateFile = Join-Path $script:BatchDir 'batch-state.tsv'
$script:PromptFile = Join-Path $script:BatchDir 'batch-prompt.md'
$script:LogsDir = Join-Path $script:BatchDir 'logs'
$script:TrackerDir = Join-Path $script:BatchDir 'tracker-additions'
$script:ReportsDir = Join-Path $script:ProjectDir 'reports'
$script:LockFile = Join-Path $script:BatchDir 'batch-runner.pid'

if ([string]::IsNullOrWhiteSpace($WorkerCli)) {
  $WorkerCli = 'claude'
}

$script:WorkerPrintFlag = if ($env:BATCH_WORKER_PRINT_FLAG) { $env:BATCH_WORKER_PRINT_FLAG } else { '-p' }
$script:WorkerSystemPromptFlag = if ($env:BATCH_WORKER_SYSTEM_PROMPT_FLAG) { $env:BATCH_WORKER_SYSTEM_PROMPT_FLAG } else { '--append-system-prompt-file' }
$script:WorkerDangerFlag = if ($env:BATCH_WORKER_DANGER_FLAG) { $env:BATCH_WORKER_DANGER_FLAG } else { '--dangerously-skip-permissions' }
$script:WorkerExtraArgsRaw = $env:BATCH_WORKER_EXTRA_ARGS

function Write-Usage {
  @'
career-ops batch runner (PowerShell) — process job offers in batch via a configurable AI CLI worker

Usage:
  powershell -File .\batch\batch-runner.ps1 [-Parallel N] [-WorkerCli CMD] [-DryRun] [-RetryFailed] [-StartFrom N] [-MaxRetries N]

Notes:
  - Uses the same batch-input.tsv, batch-state.tsv, batch-prompt.md, logs, and tracker-additions flow as batch-runner.sh
  - Runs sequentially for safety on Windows; if -Parallel is greater than 1, the script warns and continues sequentially
  - Worker CLI behavior can be tuned via:
      BATCH_WORKER_CLI
      BATCH_WORKER_PRINT_FLAG
      BATCH_WORKER_SYSTEM_PROMPT_FLAG
      BATCH_WORKER_DANGER_FLAG
      BATCH_WORKER_EXTRA_ARGS
'@ | Write-Output
}

function Ensure-Prerequisites {
  if (-not (Test-Path $script:InputFile)) {
    throw "ERROR: $script:InputFile not found. Add offers first."
  }

  if (-not (Test-Path $script:PromptFile)) {
    throw "ERROR: $script:PromptFile not found."
  }

  if (-not (Get-Command $WorkerCli -ErrorAction SilentlyContinue)) {
    throw "ERROR: Worker CLI '$WorkerCli' not found in PATH."
  }

  New-Item -ItemType Directory -Force -Path $script:LogsDir, $script:TrackerDir, $script:ReportsDir | Out-Null
}

function Ensure-StateFile {
  if (-not (Test-Path $script:StateFile)) {
    "id`turl`tstatus`tstarted_at`tcompleted_at`treport_num`tscore`terror`tretries" | Set-Content -Path $script:StateFile
  }
}

function Read-StateRows {
  Ensure-StateFile
  $lines = Get-Content -Path $script:StateFile
  $rows = @()
  foreach ($line in $lines | Select-Object -Skip 1) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", 9
    while ($parts.Count -lt 9) { $parts += '' }
    $rows += [pscustomobject]@{
      id = $parts[0]
      url = $parts[1]
      status = $parts[2]
      started_at = $parts[3]
      completed_at = $parts[4]
      report_num = $parts[5]
      score = $parts[6]
      error = $parts[7]
      retries = $parts[8]
    }
  }
  return $rows
}

function Write-StateRows([object[]]$rows) {
  $output = @("id`turl`tstatus`tstarted_at`tcompleted_at`treport_num`tscore`terror`tretries")
  foreach ($row in $rows) {
    $output += "{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}`t{8}" -f `
      $row.id, $row.url, $row.status, $row.started_at, $row.completed_at, $row.report_num, $row.score, $row.error, $row.retries
  }
  Set-Content -Path $script:StateFile -Value $output
}

function Get-Status([string]$Id) {
  $row = Read-StateRows | Where-Object { $_.id -eq $Id } | Select-Object -First 1
  if ($null -eq $row) { return 'none' }
  if ([string]::IsNullOrWhiteSpace($row.status)) { return 'none' }
  return $row.status
}

function Get-Retries([string]$Id) {
  $row = Read-StateRows | Where-Object { $_.id -eq $Id } | Select-Object -First 1
  if ($null -eq $row -or [string]::IsNullOrWhiteSpace($row.retries)) { return 0 }
  return [int]$row.retries
}

function Get-NextReportNumber {
  $maxNum = 0

  if (Test-Path $script:ReportsDir) {
    Get-ChildItem -Path $script:ReportsDir -Filter '*.md' -File | ForEach-Object {
      if ($_.BaseName -match '^(\d{3})-') {
        $n = [int]$matches[1]
        if ($n -gt $maxNum) { $maxNum = $n }
      }
    }
  }

  foreach ($row in Read-StateRows) {
    if ($row.report_num -and $row.report_num -ne '-') {
      $n = [int]$row.report_num
      if ($n -gt $maxNum) { $maxNum = $n }
    }
  }

  return ('{0:d3}' -f ($maxNum + 1))
}

function Update-StateRow {
  param(
    [string]$Id,
    [string]$Url,
    [string]$Status,
    [string]$StartedAt,
    [string]$CompletedAt,
    [string]$ReportNum,
    [string]$Score,
    [string]$Error,
    [int]$Retries
  )

  $rows = @(Read-StateRows)
  $found = $false

  foreach ($row in $rows) {
    if ($row.id -eq $Id) {
      $row.url = $Url
      $row.status = $Status
      $row.started_at = $StartedAt
      $row.completed_at = $CompletedAt
      $row.report_num = $ReportNum
      $row.score = $Score
      $row.error = $Error
      $row.retries = [string]$Retries
      $found = $true
      break
    }
  }

  if (-not $found) {
    $rows += [pscustomobject]@{
      id = $Id
      url = $Url
      status = $Status
      started_at = $StartedAt
      completed_at = $CompletedAt
      report_num = $ReportNum
      score = $Score
      error = $Error
      retries = [string]$Retries
    }
  }

  Write-StateRows $rows
}

function Acquire-Lock {
  if (Test-Path $script:LockFile) {
    $oldPid = Get-Content -Path $script:LockFile -ErrorAction SilentlyContinue
    if ($oldPid) {
      try {
        $existing = Get-Process -Id ([int]$oldPid) -ErrorAction Stop
        throw "ERROR: Another batch-runner is already running (PID $($existing.Id)). If this is stale, remove $script:LockFile"
      } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        Remove-Item -Path $script:LockFile -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $PID | Set-Content -Path $script:LockFile
}

function Release-Lock {
  if (Test-Path $script:LockFile) {
    Remove-Item -Path $script:LockFile -Force -ErrorAction SilentlyContinue
  }
}

function Resolve-PromptFile {
  param(
    [string]$Id,
    [string]$Url,
    [string]$ReportNum,
    [string]$DateStamp,
    [string]$JdFile
  )

  $resolvedPrompt = Join-Path $script:BatchDir ".resolved-prompt-$Id.md"
  $content = Get-Content -Path $script:PromptFile -Raw
  $content = $content.Replace('{{URL}}', $Url)
  $content = $content.Replace('{{JD_FILE}}', $JdFile)
  $content = $content.Replace('{{REPORT_NUM}}', $ReportNum)
  $content = $content.Replace('{{DATE}}', $DateStamp)
  $content = $content.Replace('{{ID}}', $Id)
  Set-Content -Path $resolvedPrompt -Value $content
  return $resolvedPrompt
}

function Invoke-WorkerCli {
  param(
    [string]$ResolvedPrompt,
    [string]$Prompt,
    [string]$LogFile
  )

  $argList = New-Object System.Collections.Generic.List[string]

  if (-not [string]::IsNullOrWhiteSpace($script:WorkerExtraArgsRaw)) {
    foreach ($arg in ($script:WorkerExtraArgsRaw -split '\s+' | Where-Object { $_ })) {
      $argList.Add($arg)
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($script:WorkerDangerFlag)) {
    $argList.Add($script:WorkerDangerFlag)
  }

  if (-not [string]::IsNullOrWhiteSpace($script:WorkerSystemPromptFlag)) {
    $argList.Add($script:WorkerSystemPromptFlag)
    $argList.Add($ResolvedPrompt)
  }

  if (-not [string]::IsNullOrWhiteSpace($script:WorkerPrintFlag)) {
    $argList.Add($script:WorkerPrintFlag)
  }

  $argList.Add($Prompt)

  $output = & $WorkerCli @($argList.ToArray()) 2>&1
  $exitCode = $LASTEXITCODE
  $output | Set-Content -Path $LogFile
  return $exitCode
}

function Process-Offer {
  param(
    [pscustomobject]$Offer
  )

  $startedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $retries = Get-Retries $Offer.id
  $reportNum = Get-NextReportNumber
  Update-StateRow -Id $Offer.id -Url $Offer.url -Status 'processing' -StartedAt $startedAt -CompletedAt '-' -ReportNum $reportNum -Score '-' -Error '-' -Retries $retries

  $dateStamp = Get-Date -Format 'yyyy-MM-dd'
  $jdFile = Join-Path ([System.IO.Path]::GetTempPath()) "batch-jd-$($Offer.id).txt"
  $logFile = Join-Path $script:LogsDir "$reportNum-$($Offer.id).log"
  $prompt = "Procesa esta oferta de empleo. Ejecuta el pipeline completo: evaluación A-F + report .md + PDF + tracker line. URL: $($Offer.url) JD file: $jdFile Report number: $reportNum Date: $dateStamp Batch ID: $($Offer.id)"

  Write-Output "--- Processing offer #$($Offer.id): $($Offer.url) (report $reportNum, attempt $($retries + 1))"
  $resolvedPrompt = Resolve-PromptFile -Id $Offer.id -Url $Offer.url -ReportNum $reportNum -DateStamp $dateStamp -JdFile $jdFile

  try {
    $exitCode = Invoke-WorkerCli -ResolvedPrompt $resolvedPrompt -Prompt $prompt -LogFile $logFile
  } finally {
    Remove-Item -Path $resolvedPrompt -Force -ErrorAction SilentlyContinue
  }

  $completedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

  if ($exitCode -eq 0) {
    $score = '-'
    $logContent = Get-Content -Path $logFile -Raw -ErrorAction SilentlyContinue
    $match = [regex]::Match($logContent, '"score"\s*:\s*([\d.]+)')
    if ($match.Success) {
      $score = $match.Groups[1].Value
    }

    Update-StateRow -Id $Offer.id -Url $Offer.url -Status 'completed' -StartedAt $startedAt -CompletedAt $completedAt -ReportNum $reportNum -Score $score -Error '-' -Retries $retries
    Write-Output "    Completed (score: $score, report: $reportNum)"
  } else {
    $nextRetries = $retries + 1
    $errorSnippet = ''
    if (Test-Path $logFile) {
      $tail = Get-Content -Path $logFile | Select-Object -Last 5
      $errorSnippet = (($tail -join ' ') -replace '\s+', ' ').Trim()
      if ($errorSnippet.Length -gt 200) {
        $errorSnippet = $errorSnippet.Substring(0, 200)
      }
    }
    if ([string]::IsNullOrWhiteSpace($errorSnippet)) {
      $errorSnippet = "Unknown error (exit code $exitCode)"
    }

    Update-StateRow -Id $Offer.id -Url $Offer.url -Status 'failed' -StartedAt $startedAt -CompletedAt $completedAt -ReportNum $reportNum -Score '-' -Error $errorSnippet -Retries $nextRetries
    Write-Output "    Failed (attempt $nextRetries, exit code $exitCode)"
  }
}

function Merge-Tracker {
  Write-Output ''
  Write-Output '=== Merging tracker additions ==='
  & node (Join-Path $script:ProjectDir 'merge-tracker.mjs')
  Write-Output ''
  Write-Output '=== Verifying pipeline integrity ==='
  & node (Join-Path $script:ProjectDir 'verify-pipeline.mjs')
}

function Print-Summary {
  $rows = Read-StateRows
  $total = $rows.Count
  $completed = @($rows | Where-Object { $_.status -eq 'completed' }).Count
  $failed = @($rows | Where-Object { $_.status -eq 'failed' }).Count
  $pending = $total - $completed - $failed

  Write-Output ''
  Write-Output '=== Batch Summary ==='
  Write-Output "Total: $total | Completed: $completed | Failed: $failed | Pending: $pending"

  $scores = @()
  foreach ($row in $rows) {
    if ($row.score -and $row.score -ne '-' -and [double]::TryParse($row.score, [ref]([double]0))) {
      $scores += [double]$row.score
    }
  }
  if ($scores.Count -gt 0) {
    $avg = [Math]::Round((($scores | Measure-Object -Average).Average), 1)
    Write-Output "Average score: $avg/5 ($($scores.Count) scored)"
  }
}

try {
  Ensure-Prerequisites
  Ensure-StateFile

  if ($Parallel -gt 1) {
    Write-Warning "Parallel processing is not yet implemented in batch-runner.ps1. Continuing sequentially."
  }

  if (-not $DryRun) {
    Acquire-Lock
  }

  $offers = Import-Csv -Path $script:InputFile -Delimiter "`t"
  $offers = @($offers | Where-Object { $_.id -and $_.url })

  if ($offers.Count -eq 0) {
    Write-Output "No offers in $script:InputFile. Add offers first."
    exit 0
  }

  Write-Output '=== career-ops batch runner (PowerShell) ==='
  Write-Output "Parallel requested: $Parallel | Max retries: $MaxRetries"
  Write-Output "Worker CLI: $WorkerCli"
  Write-Output "Input: $($offers.Count) offers"
  Write-Output ''

  $pending = New-Object System.Collections.Generic.List[object]
  foreach ($offer in $offers) {
    $id = [int]$offer.id
    if ($id -lt $StartFrom) { continue }

    $status = Get-Status $offer.id
    if ($RetryFailed) {
      if ($status -ne 'failed') { continue }
      if ((Get-Retries $offer.id) -ge $MaxRetries) {
        Write-Output "SKIP #$($offer.id): max retries ($MaxRetries) reached"
        continue
      }
    } else {
      if ($status -eq 'completed') { continue }
      if ($status -eq 'failed' -and (Get-Retries $offer.id) -ge $MaxRetries) {
        Write-Output "SKIP #$($offer.id): failed and max retries reached (use -RetryFailed to force)"
        continue
      }
    }

    $pending.Add($offer)
  }

  if ($pending.Count -eq 0) {
    Write-Output 'No offers to process.'
    Print-Summary
    exit 0
  }

  Write-Output "Pending: $($pending.Count) offers"
  Write-Output ''

  if ($DryRun) {
    Write-Output '=== DRY RUN (no processing) ==='
    foreach ($offer in $pending) {
      $status = Get-Status $offer.id
      Write-Output "  #$($offer.id): $($offer.url) [$($offer.source)] (status: $status)"
    }
    Write-Output ''
    Write-Output "Would process $($pending.Count) offers"
    exit 0
  }

  foreach ($offer in $pending) {
    Process-Offer -Offer $offer
  }

  Merge-Tracker
  Print-Summary
}
finally {
  if (-not $DryRun) {
    Release-Lock
  }
}

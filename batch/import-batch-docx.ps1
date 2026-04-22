[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputDocx,

  [string]$OutputTsv = '',

  [string]$Source,

  [string]$Notes = '',

  [switch]$Append
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

if ([string]::IsNullOrWhiteSpace($OutputTsv)) {
  $OutputTsv = Join-Path $PSScriptRoot 'batch-input.tsv'
}

function Get-DocxText {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    throw "Input file not found: $Path"
  }

  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $Path))
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' } | Select-Object -First 1
    if ($null -eq $entry) {
      throw "word/document.xml not found in DOCX: $Path"
    }

    $reader = New-Object System.IO.StreamReader($entry.Open())
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  } finally {
    $zip.Dispose()
  }
}

function Get-UrlsFromDocx {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $xml = Get-DocxText -Path $Path
  $matches = [regex]::Matches($xml, '<w:t[^>]*>(https?://[^<]+)</w:t>')
  $urls = New-Object System.Collections.Generic.List[string]
  $seen = @{}

  foreach ($match in $matches) {
    $url = $match.Groups[1].Value
    $url = $url -replace '&amp;', '&'
    $url = $url.Trim()

    if (-not $seen.ContainsKey($url)) {
      $seen[$url] = $true
      $urls.Add($url)
    }
  }

  return $urls
}

function Get-NextId {
  param(
    [string]$Path,
    [bool]$AppendMode
  )

  if (-not $AppendMode -or -not (Test-Path $Path)) {
    return 1
  }

  $lines = Get-Content -Path $Path | Select-Object -Skip 1
  $max = 0
  foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", 2
    if ($parts.Count -ge 1 -and $parts[0] -match '^\d+$') {
      $value = [int]$parts[0]
      if ($value -gt $max) {
        $max = $value
      }
    }
  }
  return ($max + 1)
}

function Write-BatchInput {
  param(
    [string[]]$Urls,
    [string]$Path,
    [string]$ResolvedSource,
    [string]$ResolvedNotes,
    [bool]$AppendMode
  )

  $lines = New-Object System.Collections.Generic.List[string]

  if ($AppendMode -and (Test-Path $Path)) {
    $existing = Get-Content -Path $Path
    foreach ($line in $existing) {
      $lines.Add($line)
    }
  } else {
    $lines.Add("id`turl`tsource`tnotes")
  }

  $nextId = Get-NextId -Path $Path -AppendMode $AppendMode
  foreach ($url in $Urls) {
    $lines.Add(("{0}`t{1}`t{2}`t{3}" -f $nextId, $url, $ResolvedSource, $ResolvedNotes))
    $nextId++
  }

  Set-Content -Path $Path -Value $lines
}

$resolvedInput = Resolve-Path $InputDocx
$resolvedSource = if ($PSBoundParameters.ContainsKey('Source') -and -not [string]::IsNullOrWhiteSpace($Source)) {
  $Source
} else {
  [System.IO.Path]::GetFileNameWithoutExtension($resolvedInput.Path)
}

$urls = Get-UrlsFromDocx -Path $resolvedInput.Path

if ($urls.Count -eq 0) {
  throw "No URLs found in DOCX: $resolvedInput"
}

Write-BatchInput -Urls @($urls) -Path $OutputTsv -ResolvedSource $resolvedSource -ResolvedNotes $Notes -AppendMode $Append.IsPresent

Write-Output "Imported $($urls.Count) URLs from $resolvedInput"
Write-Output "Wrote batch input: $OutputTsv"
if ($Append) {
  Write-Output "Mode: append"
} else {
  Write-Output "Mode: replace"
}

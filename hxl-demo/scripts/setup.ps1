# -----------------------------------------------------------------------------
# HXL demo - deploy the Salesforce side.
#
# Assumes you have already authenticated your org (sf org login web) and set it
# as the default. This script does NOT authenticate for you.
#
#   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1                 # deploy to the default org
#   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -TargetOrg dev  # deploy to a named org alias
#   powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -SkipTests      # faster redeploys while iterating
# -----------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string] $TargetOrg,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- Prerequisites ----------------------------------------------------------
Step 'Checking the Salesforce CLI'
if (-not (Get-Command sf -ErrorAction SilentlyContinue)) {
    Write-Host 'sf not found. Install it with:' -ForegroundColor Yellow
    Write-Host '    npm install --global @salesforce/cli' -ForegroundColor Yellow
    throw 'Salesforce CLI is required.'
}
sf --version

$orgArgs = @()
if ($TargetOrg) { $orgArgs = @('--target-org', $TargetOrg) }

Step 'Confirming the target org'
sf org display @orgArgs
if (-not $?) { throw 'No org resolved. Run "sf org login web" and set a default, or pass -TargetOrg.' }

# --- Deploy -----------------------------------------------------------------
Step 'Deploying HXL metadata (object, fields, Apex REST, permission set)'
$deployArgs = @('project', 'deploy', 'start', '--source-dir', 'force-app') + $orgArgs
if ($SkipTests) {
    $deployArgs += @('--test-level', 'NoTestRun')
} else {
    $deployArgs += @('--test-level', 'RunSpecifiedTests', '--tests', 'HXL_OrderAPITest')
}
sf @deployArgs
if (-not $?) { throw 'Deploy failed.' }

# --- Permission set ---------------------------------------------------------
Step 'Assigning HXL_Customer_Access to the running user'
# The Experience Cloud *customer* users need this too - assign it to the site's
# profile in Setup, or via a permission set license assignment for portal users.
sf org assign permset --name HXL_Customer_Access @orgArgs
if (-not $?) { Write-Host 'Permission set assignment skipped (likely already assigned).' -ForegroundColor Yellow }

# --- Node side --------------------------------------------------------------
Step 'Installing front-end dependencies'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required.' }
npm install
if (-not $?) { throw 'npm install failed.' }

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "`nCreated .env from .env.example - fill in SF_SITE_URL, SF_CLIENT_ID and SF_CLIENT_SECRET." -ForegroundColor Yellow
}

Write-Host @'

Salesforce side is deployed. Remaining manual steps (see README "Org setup"):
  1. Create/enable an Experience Cloud site and note its URL.
  2. Create the connected app with the Authorization Code and Credentials Flow.
  3. Turn on the headless APIs on the site (Login, Registration, Passwordless,
     Forgot Password) and grant the site profile access to HXL_OrderAPI.
  4. Fill in .env, then:  npm start

'@ -ForegroundColor Green

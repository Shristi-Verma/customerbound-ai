# -----------------------------------------------------------------------------
# HXL demo - pre-flight check.
#
# Verifies everything the Salesforce CLI can actually see, then prints a
# checklist for the click-work it cannot inspect. Run this before a demo.
#
#   powershell -ExecutionPolicy Bypass -File scripts/verify-setup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/verify-setup.ps1 -TargetOrg hxl
#
# Nothing here changes your org - it only reads.
# -----------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string] $TargetOrg
)

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$script:Failures = 0
$script:Warnings = 0

function Pass($msg)  { Write-Host "  [ ok ] $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  [warn] $msg" -ForegroundColor Yellow; $script:Warnings++ }
function Fail($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $script:Failures++ }
function Section($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }

$orgArgs = @()
if ($TargetOrg) { $orgArgs = @('--target-org', $TargetOrg) }

# Runs an sf command with --json and returns the parsed `result`, or $null.
function Invoke-Sf {
    param([string[]] $SfArgs)
    try {
        $raw = & sf @SfArgs --json 2>$null | Out-String
        if (-not $raw.Trim()) { return $null }
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.status -ne 0) { return $null }
        return $parsed.result
    } catch {
        return $null
    }
}

function Invoke-Soql {
    param([string] $Soql)
    $res = Invoke-Sf (@('data', 'query', '--query', $Soql) + $orgArgs)
    # The leading comma stops PowerShell unrolling a single-element array back
    # into a bare object - a PSCustomObject has no .Count, so every one-record
    # result would otherwise read as zero.
    if ($null -eq $res) { return ,@() }
    return ,@($res.records)
}

Write-Host "`nHXL POC - configuration check" -ForegroundColor White

# --- 1. CLI + org connection ------------------------------------------------
Section '1. Salesforce CLI and org'

if (-not (Get-Command sf -ErrorAction SilentlyContinue)) {
    Fail 'sf not found. Install with: npm install --global @salesforce/cli'
    Write-Host "`nCannot continue without the CLI.`n" -ForegroundColor Red
    exit 1
}
Pass "CLI present ($((& sf --version) -replace '\s+', ' '))"

$org = Invoke-Sf (@('org', 'display') + $orgArgs)
if ($null -eq $org) {
    Fail 'No org resolved. Run: sf org login web --alias hxl   then: sf config set target-org hxl'
    Write-Host "`nCannot continue without an org.`n" -ForegroundColor Red
    exit 1
}
Pass "Connected as $($org.username)"
Write-Host "         instance: $($org.instanceUrl)" -ForegroundColor DarkGray

# --- 2. Deployed metadata ---------------------------------------------------
Section '2. Deployed metadata (scripts/setup.ps1)'

$classes = Invoke-Soql "SELECT Name FROM ApexClass WHERE Name IN ('HXL_OrderAPI','HXL_OrderAPITest')"
$classNames = @($classes | ForEach-Object { $_.Name })
if ($classNames -contains 'HXL_OrderAPI') { Pass 'Apex class HXL_OrderAPI deployed' }
else { Fail 'HXL_OrderAPI missing - run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1' }
if ($classNames -contains 'HXL_OrderAPITest') { Pass 'Apex class HXL_OrderAPITest deployed' }
else { Warn 'HXL_OrderAPITest missing' }

$obj = Invoke-Sf (@('sobject', 'describe', '--sobject', 'HXL_Order__c') + $orgArgs)
if ($null -eq $obj) { Fail 'Custom object HXL_Order__c missing - run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1' }
else { Pass 'Custom object HXL_Order__c present' }

$permsets = Invoke-Soql "SELECT Name FROM PermissionSet WHERE Name = 'HXL_Customer_Access'"
if ($permsets.Count -gt 0) { Pass 'Permission set HXL_Customer_Access present' }
else { Fail 'HXL_Customer_Access missing - run: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1' }

# --- 3. Prerequisites that are easy to forget -------------------------------
Section '3. Org prerequisites (SETUP.md steps 4-5)'

$me = Invoke-Soql "SELECT Id, Name, UserRoleId FROM User WHERE Username = '$($org.username)'"
if ($me.Count -gt 0 -and $me[0].UserRoleId) {
    Pass 'Your admin user has a role (required for self-registration)'
} else {
    Fail 'Your admin user has NO ROLE. Self-registration will fail. SETUP.md step 4.'
}

$profiles = Invoke-Soql "SELECT Name, UserType FROM Profile WHERE UserType IN ('CspLitePortal','PowerCustomerSuccess','CustomerSuccess')"
if ($profiles.Count -gt 0) {
    Pass "External-user profile(s) available: $(($profiles | ForEach-Object { $_.Name }) -join ', ')"
} else {
    Warn 'No community/portal profile found. Clone "Customer Community User" - SETUP.md step 5.'
}

$accts = Invoke-Soql "SELECT Name FROM Account WHERE Name = 'HXL Demo Customers'"
if ($accts.Count -gt 0) { Pass 'Account "HXL Demo Customers" exists' }
else { Warn 'Account "HXL Demo Customers" not found - SETUP.md step 5.' }

# --- 4. Experience Cloud site -----------------------------------------------
Section '4. Experience Cloud site (SETUP.md step 6)'

$networks = Invoke-Soql 'SELECT Name, Status, UrlPathPrefix FROM Network'
if ($networks.Count -eq 0) {
    Fail 'No Experience Cloud site found. Enable Digital Experiences and create a site.'
} else {
    foreach ($n in $networks) {
        $label = "site '$($n.Name)' (/$($n.UrlPathPrefix)) status=$($n.Status)"
        if ($n.Status -eq 'Live') { Pass $label }
        else { Fail "$label - must be Live. Publish it in Workspaces > Builder." }
    }
}

$domains = Invoke-Soql 'SELECT Domain FROM Domain'
$siteDomain = $domains | Where-Object { $_.Domain -like '*my.site.com' } | Select-Object -First 1
if ($siteDomain) {
    Write-Host "         site domain: $($siteDomain.Domain)" -ForegroundColor DarkGray
}

# --- 5. Connected app -------------------------------------------------------
Section '5. Connected app (SETUP.md step 7)'

$apps = Invoke-Soql 'SELECT Name FROM ConnectedApplication'
if ($apps.Count -eq 0) {
    Warn 'No connected apps visible. Create one - SETUP.md step 7.'
} else {
    Pass "Connected app(s): $(($apps | ForEach-Object { $_.Name }) -join ', ')"
    Write-Host '         (the CLI cannot read OAuth flags or policies - verify by hand)' -ForegroundColor DarkGray
}

# --- 6. Local .env ----------------------------------------------------------
Section '6. Local configuration (.env)'

if (-not (Test-Path .env)) {
    Fail '.env missing. Copy .env.example to .env and fill it in.'
} else {
    $envMap = @{}
    foreach ($line in Get-Content .env) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
    }

    foreach ($key in @('SF_SITE_URL', 'SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_REDIRECT_URI')) {
        $val = $envMap[$key]
        if ([string]::IsNullOrWhiteSpace($val) -or $val -like '*YOURDOMAIN*') {
            Fail "$key is not set"
        } else {
            Pass "$key set"
        }
    }

    $siteUrl = $envMap['SF_SITE_URL']
    if ($siteUrl -and $siteUrl -notlike '*YOURDOMAIN*') {
        if ($siteUrl -like '*.my.salesforce.com*' -or $siteUrl -like '*login.salesforce.com*') {
            Fail 'SF_SITE_URL points at the instance/login URL. It must be the my.site.com site URL.'
        }
        if ($siteUrl.EndsWith('/')) {
            Warn 'SF_SITE_URL has a trailing slash - harmless here, but keep URLs exact.'
        }
        try {
            $probe = Invoke-WebRequest -Uri $siteUrl -Method Head -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
            Pass "Site reachable (HTTP $($probe.StatusCode))"
        } catch {
            $code = $null
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            if ($code) { Warn "Site responded HTTP $code - check it is published" }
            else { Fail "Could not reach $siteUrl" }
        }
    }

    $redirect = $envMap['SF_REDIRECT_URI']
    if ($redirect -and $redirect.EndsWith('/')) {
        Fail 'SF_REDIRECT_URI has a trailing slash. It must match the connected app callback byte for byte.'
    }
}

# --- 7. Things only you can check -------------------------------------------
Section '7. Manual checks (not visible to the CLI)'

@(
    'Setup > OAuth and OpenID Connect Settings > Allow Authorization Code and Credentials Flows  [step 3]',
    'Setup > Deliverability > Access to Send Email = All email  (otherwise no OTP arrives)       [step 3]',
    'Connected app > Enable Authorization Code and Credentials Flow                              [step 7]',
    'Connected app > Manage > Edit Policies > Admin approved users are pre-authorized            [step 7]',
    'Connected app > Manage > Manage Profiles > HXL Customer added                               [step 7]',
    'Site > Workspaces > Administration > Members > HXL Customer profile added                   [step 6]',
    'Site > Login & Registration > self-registration on, profile + account selected              [step 8]',
    'Site > Login & Registration > headless Registration / Forgot Password / Passwordless on     [step 8]'
) | ForEach-Object { Write-Host "  [ ? ] $_" -ForegroundColor DarkGray }

# --- Summary ----------------------------------------------------------------
Write-Host ''
if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) failure(s), $($script:Warnings) warning(s). Fix the FAILs above, then re-run.`n" -ForegroundColor Red
    exit 1
} elseif ($script:Warnings -gt 0) {
    Write-Host "No failures, $($script:Warnings) warning(s). Probably demo-ready - walk the manual list.`n" -ForegroundColor Yellow
    exit 0
} else {
    Write-Host "All automated checks passed. Walk the manual list, then: npm start`n" -ForegroundColor Green
    exit 0
}

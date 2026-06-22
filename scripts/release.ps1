# Release script for halin classroom desktop app.
#
# Usage (from anywhere):
#   .\scripts\release.ps1 0.7.0
#   .\scripts\release.ps1 0.7.0 -Message "fix kanji recognition bug"
#   .\scripts\release.ps1 0.7.0 -DryRun       # show what would happen, don't push
#
# What it does:
#   1. Verify working tree is clean (or only the 3 version files are modified).
#   2. Pull --rebase to stay in sync with origin.
#   3. Bump version in src-tauri/Cargo.toml + src-tauri/tauri.conf.json + package.json.
#   4. Show diff and ask for confirmation.
#   5. Commit "chore: bump to vX.Y.Z" and push to main.
#   6. Create annotated tag vX.Y.Z and push the tag.
#   7. The tag push triggers .github/workflows/release.yml — installers and the
#      latest.json manifest land in the GitHub Release ~15-20 minutes later.
#   8. Open the Actions page in the browser so you can watch the build.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true, Position=0)]
    [string]$Version,

    [string]$Message = "",

    [switch]$DryRun,

    [switch]$SkipPull
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Warn($msg) {
    Write-Host "WARN: $msg" -ForegroundColor Yellow
}

function Write-Error-Exit($msg) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    exit 1
}

# ── Validate version ──────────────────────────────────────────────────
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error-Exit "Version must be x.y.z (got: $Version)"
}
$Tag = "v$Version"

# ── Locate desktop repo root (parent of /scripts) ─────────────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    Write-Host "Repo: $RepoRoot"

    # Verify we're inside the right repo by looking for tauri.conf.json
    if (-not (Test-Path "src-tauri\tauri.conf.json")) {
        Write-Error-Exit "Not a Tauri repo (no src-tauri/tauri.conf.json). Wrong directory?"
    }

    # ── Verify clean working tree ────────────────────────────────────
    Write-Step "Checking working tree status"
    $dirty = git status --porcelain
    if ($dirty) {
        Write-Host $dirty
        Write-Error-Exit "Working tree is dirty. Commit or stash first."
    }

    # ── Verify branch ─────────────────────────────────────────────────
    $branch = (git branch --show-current).Trim()
    if ($branch -ne "main") {
        Write-Error-Exit "Not on main branch (on '$branch'). Switch first."
    }
    Write-Host "Branch: main"

    # ── Pull latest ───────────────────────────────────────────────────
    if (-not $SkipPull) {
        Write-Step "Pulling latest from origin/main (--rebase)"
        git fetch origin
        if ($LASTEXITCODE -ne 0) { Write-Error-Exit "git fetch failed" }
        git pull --rebase origin main
        if ($LASTEXITCODE -ne 0) {
            Write-Error-Exit "git pull --rebase failed — resolve conflicts then re-run with -SkipPull"
        }
    } else {
        Write-Warn "Skipping pull as requested"
    }

    # ── Verify tag doesn't already exist ──────────────────────────────
    Write-Step "Checking tag $Tag"
    git fetch origin --tags 2>$null
    $existingTag = git tag -l $Tag
    if ($existingTag) {
        Write-Error-Exit "Tag $Tag already exists locally. Delete it first if intentional: 'git tag -d $Tag' then 'git push origin :refs/tags/$Tag'"
    }
    $remoteTag = git ls-remote --tags origin "refs/tags/$Tag"
    if ($remoteTag) {
        Write-Error-Exit "Tag $Tag already exists on remote."
    }

    # ── Bump version files ────────────────────────────────────────────
    Write-Step "Bumping version to $Version"

    $cargoPath = "src-tauri\Cargo.toml"
    $tauriPath = "src-tauri\tauri.conf.json"
    $pkgPath = "package.json"
    # The Settings UI hardcodes the version in this <span> because we haven't wired
    # the live Tauri getVersion() API in yet; bump it here so the About page stays
    # in sync with the compiled binary. When index.html switches to reading the
    # version dynamically, remove this file from the bump list.
    $htmlPath = "src\index.html"

    foreach ($f in @($cargoPath, $tauriPath, $pkgPath, $htmlPath)) {
        if (-not (Test-Path $f)) {
            Write-Error-Exit "Missing file: $f"
        }
    }

    # 1. Cargo.toml — `version = "x.y.z"` at top-level [package] table.
    $cargoContent = Get-Content $cargoPath -Raw
    $cargoNew = $cargoContent -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`""
    if ($cargoNew -eq $cargoContent) {
        Write-Error-Exit "Failed to update version in $cargoPath (regex didn't match)"
    }
    Set-Content -Path $cargoPath -Value $cargoNew -NoNewline -Encoding UTF8
    Write-Host "  patched $cargoPath"

    # 2. tauri.conf.json — `"version": "x.y.z"`
    $tauriContent = Get-Content $tauriPath -Raw
    $tauriNew = $tauriContent -replace '"version"\s*:\s*"[^"]+"', "`"version`": `"$Version`""
    if ($tauriNew -eq $tauriContent) {
        Write-Error-Exit "Failed to update version in $tauriPath"
    }
    Set-Content -Path $tauriPath -Value $tauriNew -NoNewline -Encoding UTF8
    Write-Host "  patched $tauriPath"

    # 3. package.json — first `"version": "x.y.z"` (top-level).
    $pkgContent = Get-Content $pkgPath -Raw
    # Use [Regex]::Replace with count=1 so we don't accidentally clobber a dep
    # named "version" inside dependencies.
    $regex = [System.Text.RegularExpressions.Regex]::new('"version"\s*:\s*"[^"]+"')
    $pkgNew = $regex.Replace($pkgContent, "`"version`": `"$Version`"", 1)
    if ($pkgNew -eq $pkgContent) {
        Write-Error-Exit "Failed to update version in $pkgPath"
    }
    Set-Content -Path $pkgPath -Value $pkgNew -NoNewline -Encoding UTF8
    Write-Host "  patched $pkgPath"

    # 4. src/index.html — the About section hardcodes the version label as
    # `<span id="about-version">vX.Y.Z</span>`. Match by id attribute so we
    # don't touch other version strings (e.g. in release notes) that may live
    # elsewhere in the HTML.
    $htmlContent = Get-Content $htmlPath -Raw
    $htmlPattern = '(<span[^>]*id="about-version"[^>]*>)v[^<]+(</span>)'
    $htmlReplacement = '${1}v' + $Version + '${2}'
    $htmlNew = [System.Text.RegularExpressions.Regex]::Replace($htmlContent, $htmlPattern, $htmlReplacement)
    if ($htmlNew -eq $htmlContent) {
        Write-Error-Exit "Failed to update version in $htmlPath (no <span id='about-version'> match)"
    }
    Set-Content -Path $htmlPath -Value $htmlNew -NoNewline -Encoding UTF8
    Write-Host "  patched $htmlPath"

    # ── Show diff ─────────────────────────────────────────────────────
    Write-Step "Diff"
    git --no-pager diff -- $cargoPath $tauriPath $pkgPath $htmlPath

    if ($DryRun) {
        Write-Step "Dry run — reverting changes and exiting"
        git checkout -- $cargoPath $tauriPath $pkgPath $htmlPath
        Write-Host "No commit / tag / push made."
        exit 0
    }

    # ── Confirm ───────────────────────────────────────────────────────
    Write-Host ""
    $confirm = Read-Host "Proceed with release $Tag? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "Aborted by user. Reverting bumped files."
        git checkout -- $cargoPath $tauriPath $pkgPath $htmlPath
        exit 0
    }

    # ── Commit + push ─────────────────────────────────────────────────
    Write-Step "Committing"
    git add $cargoPath $tauriPath $pkgPath $htmlPath
    if ($LASTEXITCODE -ne 0) { Write-Error-Exit "git add failed" }
    git commit -m "chore: bump to $Tag"
    if ($LASTEXITCODE -ne 0) { Write-Error-Exit "git commit failed" }

    Write-Step "Pushing commit to main"
    git push origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Error-Exit "git push failed — fix the issue then run: 'git tag -a $Tag -m $Tag' then 'git push origin $Tag'"
    }

    # ── Tag + push tag ────────────────────────────────────────────────
    Write-Step "Creating tag $Tag"
    $tagMsg = if ($Message) { $Message } else { $Tag }
    git tag -a $Tag -m $tagMsg
    if ($LASTEXITCODE -ne 0) { Write-Error-Exit "git tag failed" }

    Write-Step "Pushing tag (triggers build)"
    git push origin $Tag
    if ($LASTEXITCODE -ne 0) {
        Write-Error-Exit "git push tag failed — tag exists locally but not on remote. Run: git push origin $Tag"
    }

    Write-Host ""
    Write-Host "RELEASE $Tag PUSHED." -ForegroundColor Green
    Write-Host ""

    # Try to read the remote URL to construct the actions page.
    $remoteUrl = git config --get remote.origin.url
    $actionsUrl = ""
    if ($remoteUrl -match 'github\.com[:/](.+?)(\.git)?$') {
        $repoSlug = $Matches[1]
        $actionsUrl = "https://github.com/$repoSlug/actions"
        $releasesUrl = "https://github.com/$repoSlug/releases"
        Write-Host "Watch build:  $actionsUrl"
        Write-Host "Release page: $releasesUrl"
        Write-Host ""
        Write-Host "Build typically takes 15-20 minutes for macOS + Windows."
        # Open browser
        Start-Process $actionsUrl
    }
} finally {
    Pop-Location
}

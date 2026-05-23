# Patrol Report: Sidra Full Codebase

**Date:** 2026-03-27
**Dependency addendum:** 2026-05-23
**Auditor:** Dibble (code security auditor)
**Scope:** Full codebase (`src/`, `assets/`, `build/`), all 22 TypeScript source files, 3 injected scripts, 2 HTML files, 1 build hook, dependency manifests
**Prior report:** 2026-03-27 (same-day re-audit after remediations)

## Methodology

**Phases completed:** All five (Scope/Context, Automated Scanning, Manual Review, Triage, Report).

**Automated tools run:**
- Semgrep v1.143.0: `p/security-audit`, `p/owasp-top-ten`, `p/cwe-top-25` (0 findings, 332 rules on 235 targets)
- Gitleaks: `detect` and `git` modes (404 commits, 1.80 MB scanned, 0 findings)
- OSV-Scanner: recursive scan (473 packages, 0 findings)

**Dependency addendum tools run on 2026-05-23:**
- Reviewed merged Dependabot and dependency PRs: #70, #71, #75, #76, #92, #102
- `npm audit --package-lock-only --json`
- `osv-scanner scan source -r . --format json`

**Dependency remediation verification run on 2026-05-23:**
- `npm audit --package-lock-only --json` (0 vulnerabilities)
- `osv-scanner scan --recursive . --format json` (0 findings)

**Technology stack:**
- CastLabs Electron (Chromium fork with Widevine CDM), TypeScript, electron-builder
- Runtime deps: `@holusion/dbus-next`, `@xhayper/discord-rpc`, `electron-conf`, `electron-log`, `electron-updater`
- No LLM libraries present

**Threat model:** External attacker with no prior access targeting the desktop application.

**Limitations:**
- Runtime behaviour not tested (no dynamic analysis)
- Deployment configuration not reviewed (CI/CD pipelines, server infrastructure)
- Apple Music page CSP and behaviour not auditable (third-party origin)
- Git history audited by Gitleaks only (no manual commit-level review)

---

## Resolved Findings (from prior report)

All seven findings from the prior report have been remediated and verified:

### W2. [CWE-350] Protocol validation on update URL - `src/update.ts:86-91` - RESOLVED

Protocol validation added. `releaseUrl` is parsed with `new URL()` and checked for `https:`/`http:` protocol before passing to `shell.openExternal()`. Malformed URLs are caught and silently ignored. The same validation is applied in the tray menu update link (`src/tray.ts:382-384`) using `parsed.toString()` for the final URL, preventing prototype pollution of the original string.

### W3. [CWE-265] Main BrowserWindow sandbox - `src/main.ts:226` - RESOLVED

`sandbox: true` added to the main window's `webPreferences`. All three BrowserWindow instances (splash at line 116, about at line 174 in `src/tray.ts`, main at line 226) set `sandbox: true`.

### O1. [CWE-942] Wildcard postMessage target origin - `src/preload.ts:39` - RESOLVED

Target origin changed from `'*'` to `'https://music.apple.com'`. Messages are now scoped to the expected origin.

### O2. [CWE-78] Shell interpolation in build hook - `build/afterPack.cjs:29` - RESOLVED

`execSync` replaced with `execFileSync` and an argument array. Shell interpretation is no longer possible.

### O4. [CWE-20] MPRIS OpenUri validation - `src/integrations/mpris/index.ts:519-529` - RESOLVED

Prefix-based `startsWith()` check replaced with `new URL()` parsing, explicit `hostname` (`music.apple.com`) and `protocol` (`https:`) validation. Malformed URIs are caught and rejected.

### O5. [CWE-209] Debug log level controllable via environment variable - `src/main.ts:38-43` - RESOLVED

`ELECTRON_LOG_LEVEL` is now validated against a `Set` of known log levels (`error`, `warn`, `info`, `debug`, `silly`) before use. Invalid values are silently ignored.

### GHSA-f886-m6hf-6m8v: brace-expansion ReDoS - RESOLVED

`package.json` override `"brace-expansion": ">=5.0.6"` forces a version that resolves both known `brace-expansion` advisories. `package-lock.json` confirms `brace-expansion` at version 5.0.6.

### GHSA-jxxr-4gwj-5jf2 / CVE-2026-45149: brace-expansion resource exhaustion - RESOLVED

The 2026-05-23 dependency addendum initially found `brace-expansion` 5.0.5 vulnerable to resource exhaustion when large numeric ranges defeat the documented `max` protection. The override has been raised from `>=5.0.5` to `>=5.0.6`, and the lockfile now resolves `brace-expansion` to 5.0.6.

### Post-report dependency remediations - RESOLVED

The following dependency security updates landed after the 2026-03-27 report. These were verified from merged PR metadata and the current lockfile.

| PR | Dependency | Path | Remediation |
|----|------------|------|-------------|
| [#70](https://github.com/wimpysworld/sidra/pull/70) | `vite` 8.0.3 → 8.0.5 | Indirect dev dependency via Vitest | Fixed Vite development-server file access issues, including path traversal in the optimised dependency sourcemap handler and missing `server.fs` checks. |
| [#71](https://github.com/wimpysworld/sidra/pull/71) | `lodash` 4.17.23 → 4.18.1 | Indirect dev dependency via electron-builder tooling | Fixed `_.unset` / `_.omit` prototype pollution (`GHSA-f23m-r3pf-42rh`) and `_.template` code injection via `imports` keys (`GHSA-r5fr-rjxr-66jc`, `CVE-2026-4800`). |
| [#75](https://github.com/wimpysworld/sidra/pull/75) | CastLabs Electron 40.7.0+wvcus → 40.8.6+wvcus | Direct app shell dependency | Picked up the Electron 40.8.5+ security fixes and cleared the high-severity `npm audit` advisory set affecting the previous pinned CastLabs build. |
| [#76](https://github.com/wimpysworld/sidra/pull/76) | `@xmldom/xmldom` 0.8.12 → 0.8.13 | Indirect dev dependency via electron-builder tooling | Fixed XML serializer injection issues (`GHSA-j759-j44w-7fr8`, `GHSA-x6wf-f3px-wcqx`, `GHSA-f6ww-3ggp-fr8h`) and deeply nested DOM traversal denial of service (`GHSA-2v35-w6hq-6mfw`). |
| [#92](https://github.com/wimpysworld/sidra/pull/92) | `fast-uri` 3.1.0 → 3.1.2 | Indirect runtime dependency via `electron-conf` / `ajv` | Fixed fast-uri security releases `GHSA-q3j6-qgpj-74h6` and `GHSA-v39h-62p7-jpjc`, including malformed fragment decoding now handled as a parse error. |
| [#102](https://github.com/wimpysworld/sidra/pull/102) | `ws` 8.20.0 → 8.20.1 | Indirect runtime dependency via Discord RPC | Fixed uninitialised memory disclosure in `websocket.close()` when passed unsupported typed-array close reasons. |

---

## Critical Findings

None.

---

## Warnings

### W1. [CWE-295] Disabled update signature verification on Windows - `src/autoUpdate.ts:50`

**Confidence:** Confirmed
**Status:** Carried forward from prior report (unresolved)

`verifyUpdateCodeSignature` is set to `false` on Windows, disabling Authenticode signature verification on downloaded update binaries. Combined with `autoDownload: true` (line 47), the app downloads and prompts the user to install updates without cryptographic proof of origin.

**Exploitation path:**
1. Attacker compromises the HTTPS transport (corporate proxy MITM, DNS hijack, or compromised CDN edge node)
2. Serves a malicious binary in place of the legitimate update
3. User clicks "Restart Now" in the dialog or the notification, installing the payload

The HTTPS connection to GitHub provides the primary integrity guarantee. Code-signed builds would provide a second layer. The AGENTS.md documents this as intentional (`verifyUpdateCodeSignature: false` is required because the app is unsigned).

**Impact:** Remote code execution via malicious update binary.

**Fix:** Sign Windows builds and remove `verifyUpdateCodeSignature = false`. Until then, the HTTPS transport to GitHub is the sole integrity control.

---

## Observations

### O3. [OWASP A06:2021] Broad macOS entitlements - `build/entitlements.mac.plist`

**Status:** Carried forward from prior report (inherent to Electron + Widevine)

The entitlements include:
- `com.apple.security.cs.allow-jit` - JIT compilation
- `com.apple.security.cs.allow-unsigned-executable-memory` - unsigned memory execution
- `com.apple.security.cs.disable-library-validation` - load unsigned libraries

All three are required by Electron and the Widevine CDM. These entitlements weaken macOS hardened runtime protections but cannot be removed without breaking functionality.

### O6. [CWE-319] Discord Client ID exposed as constant - `src/integrations/discord-presence/index.ts:11`

**Confidence:** Confirmed

```typescript
const CLIENT_ID = '1485248818688688318';
```

The Discord application client ID is hardcoded. This is a public identifier (not a secret) - Discord client IDs are inherently public and visible in any Discord Rich Presence integration. No remediation needed. Documented for completeness.

---

## Dependencies

### Original OSV-Scanner result: 0 findings

At the 2026-03-27 scan point, all 473 packages in `package-lock.json` were free of known vulnerabilities. The `brace-expansion` and `undici` overrides were both effective for the advisories known at that time.

### Dependency addendum scan: 0 current findings

The 2026-05-23 lockfile scan initially reported one moderate dependency advisory:

| Advisory | Package | Current version | Fixed version | Scope | Status |
|----------|---------|-----------------|---------------|-------|--------|
| `GHSA-jxxr-4gwj-5jf2` / `CVE-2026-45149` | `brace-expansion` | 5.0.6 | 5.0.6 | Dev dependency | Resolved |

This is a separate advisory from the earlier `GHSA-f886-m6hf-6m8v` ReDoS finding. Raising the override to `>=5.0.6` and regenerating `package-lock.json` clears both npm audit and OSV-Scanner.

Resolved dependency findings since the prior report:

- Electron advisory set affecting CastLabs Electron 40.7.0+wvcus - resolved by #75
- `vite` development-server file access issues - resolved by #70
- `lodash` prototype pollution and template code injection - resolved by #71
- `@xmldom/xmldom` XML injection and DOM traversal denial of service issues - resolved by #76
- `fast-uri` malformed URI handling advisories - resolved by #92
- `ws` uninitialised memory disclosure - resolved by #102
- `brace-expansion` resource exhaustion - resolved by the `>=5.0.6` override and lockfile update

### Supply chain observations

| Concern | Detail | Risk |
|---------|--------|------|
| Caret version ranges | All 5 runtime deps use `^` ranges in `package.json` | Mitigated by `package-lock.json`; a missing or stale lock file would pull untested versions |
| CastLabs Electron fork | `electron` pinned to `v40.8.6+wvcus` from `castlabs/electron-releases` | Pinned to a specific tag, actively maintained; April 2026 audit advisory set resolved |
| `undici` override | `"undici": ">=6.24.0"` forces a minimum version | Addresses a prior vulnerability; the override is correct |
| `brace-expansion` override | `"brace-expansion": ">=5.0.6"` forces the fixed version | `GHSA-f886-m6hf-6m8v` and `GHSA-jxxr-4gwj-5jf2` resolved |
| No `postinstall` scripts | No runtime dependencies declare `postinstall` hooks | No supply chain execution risk at install time |

---

## Beat Summary

**Scope:** 22 TypeScript source files, 2 injected JavaScript scripts, 1 injected CSS file, 2 HTML files, 1 build hook (`afterPack.cjs`), `package.json`, `package-lock.json`, and macOS entitlements. 404 git commits scanned for secrets.

**Files patrolled:** 235 (Semgrep), 30 (manual review of all source, asset, and build files).

**Overall security posture:** Strong for an Electron application of this scope.

Seven findings from the prior report have been remediated correctly:
- W2 (protocol validation on update URL) - verified
- W3 (main window sandbox) - verified
- O1 (postMessage target origin) - verified
- O2 (shell interpolation in build hook) - verified
- O4 (MPRIS OpenUri validation) - verified
- O5 (log level environment variable validation) - verified
- GHSA-f886-m6hf-6m8v (brace-expansion ReDoS) - verified

No new findings discovered. The manual review covered all nine vulnerability categories (access control, authentication, injection, cryptography, input validation, configuration, error handling, supply chain, resource limits) and identified no new issues.

The codebase follows Electron security best practices consistently:
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on all windows
- IPC channel allowlists in both directions (preload and renderer)
- Command allowlist in the renderer bridge (`musicKitHook.js`)
- Protocol validation on all external URL opening (`shell.openExternal`, `setWindowOpenHandler`, tray links, update notifications)
- Parsed URL hostname validation on MPRIS OpenUri
- Input validation on all IPC payloads in `player.ts`
- Proper cleanup of event listeners and timers on `will-quit`
- No secrets in source or git history
- No `eval()`, `Function()`, or dynamic code generation from user input
- HTML files use `.textContent` assignment, not `.innerHTML`
- CSP headers on local HTML files (splash, about)
- Scoped postMessage target origin
- `ELECTRON_LOG_LEVEL` validated against known values

**Repeat-offender patterns:** None identified. No systemic security issues across the codebase.

**Dependency addendum status:** The named Dependabot security updates have been merged and are reflected in `package-lock.json`. The newer moderate `brace-expansion` advisory has been resolved as of 2026-05-23.

## Remediation Roadmap

| Priority | Finding | Effort | Action |
|----------|---------|--------|--------|
| 1 | W1 - Disabled update signature verification | High | Sign Windows builds, remove `verifyUpdateCodeSignature = false` |
| 2 | O3 - Broad macOS entitlements | N/A | Cannot remediate; required by Electron + Widevine |

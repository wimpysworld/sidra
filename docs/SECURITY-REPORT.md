# Patrol Report: Sidra Full Codebase

**Date:** 2026-03-27
**Auditor:** Dibble (code security auditor)
**Scope:** Full codebase (`src/`, `assets/`, `build/`), all 22 TypeScript source files, 3 injected scripts, 2 HTML files, 1 build hook, dependency manifests

## Methodology

**Phases completed:** All five (Scope/Context, Automated Scanning, Manual Review, Triage, Report).

**Automated tools run:**
- Semgrep: `p/security-audit`, `p/owasp-top-ten`, `p/cwe-top-25` (332 rules, 233 files scanned, 1 finding)
- Gitleaks: `detect` and `git` modes (395 commits, 1.78 MB scanned, 0 findings)
- OSV-Scanner: recursive scan (477 packages, 3 medium findings)

**Limitations:**
- Runtime behaviour not tested (no dynamic analysis)
- Deployment configuration not reviewed (CI/CD pipelines, server infrastructure)
- Apple Music page CSP and behaviour not auditable (third-party origin)
- Git history audited by Gitleaks only (no manual commit-level review)

---

## Critical Findings

None.

---

## Warnings

### W1. [CWE-295] Disabled update signature verification on Windows - `src/autoUpdate.ts:50`

**Confidence:** Confirmed

`verifyUpdateCodeSignature` is set to `false` on Windows, disabling Authenticode signature verification on downloaded update binaries. Combined with `autoDownload: true` (line 47), the app downloads and prompts the user to install updates without cryptographic proof of origin.

**Exploitation path:**
1. Attacker compromises the HTTPS transport (corporate proxy MITM, DNS hijack, or compromised CDN edge node)
2. Serves a malicious binary in place of the legitimate update
3. User clicks "Restart Now" in the dialog or the notification, installing the payload

The HTTPS connection to GitHub provides the primary integrity guarantee. Code-signed builds would provide a second layer.

**Impact:** Remote code execution via malicious update binary.

**Fix:** Sign Windows builds and remove `verifyUpdateCodeSignature = false`. Until then, the HTTPS transport to GitHub is the sole integrity control. Document this risk in a comment at the assignment site.

---

### W2. [CWE-350] Missing protocol validation on update notification URL - `src/update.ts:85-86`

**Confidence:** Confirmed

```typescript
notification.on('click', () => {
  shell.openExternal(releaseUrl);
});
```

`releaseUrl` comes from the GitHub API field `html_url`. The code passes it directly to `shell.openExternal()` without validating the protocol. Compare with `src/tray.ts:382-386`, which correctly validates `https:`/`http:` before calling `shell.openExternal()`.

**Exploitation path:**
1. Attacker controls the GitHub API response (compromised mirror, DNS poisoning, or a supply chain attack on the repo)
2. Sets `html_url` to a `file:`, `smb:`, or custom protocol handler URL
3. User clicks the update notification, triggering the malicious protocol handler

**Impact:** Protocol handler abuse, potential local file disclosure or code execution via registered handlers.

**Fix:** Apply the same protocol validation used in `tray.ts`:
```typescript
notification.on('click', () => {
  try {
    const parsed = new URL(releaseUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      shell.openExternal(releaseUrl);
    }
  } catch { /* ignore malformed URL */ }
});
```

---

### W3. [CWE-265] Main BrowserWindow missing sandbox flag - `src/main.ts:218-224`

**Confidence:** Confirmed

The main BrowserWindow sets `contextIsolation: true` and `nodeIntegration: false` but omits `sandbox: true`. The splash and about windows correctly set `sandbox: true`.

```typescript
webPreferences: {
  partition: 'persist:sidra',
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
  plugins: true,
  // sandbox: true is absent
},
```

The main window loads remote content from `music.apple.com` and is the highest-risk renderer. Without `sandbox: true`, the preload script process retains access to some Node.js primitives even though `nodeIntegration` is off.

**Exploitation path:**
1. Attacker achieves code execution in the renderer (XSS on music.apple.com, or Chromium renderer exploit)
2. Exploits the unsandboxed preload process to access Node.js APIs not available in sandboxed mode
3. Escalates to full main-process capabilities

**Impact:** Increased blast radius from a renderer compromise.

**Fix:** Add `sandbox: true` to the main window's `webPreferences`. Verify the preload script still functions correctly - sandboxed preloads can use `contextBridge` and `ipcRenderer` from `electron`. The `plugins: true` flag (required for Widevine CDM) may conflict; test DRM playback after the change.

---

## Observations

### O1. [CWE-942] Wildcard postMessage target origin - `src/preload.ts:39`

**Semgrep rule:** `javascript.browser.security.wildcard-postmessage-configuration`

```typescript
window.postMessage({ type: 'sidra:command', channel, args }, '*');
```

The target origin `'*'` means any frame in the window could receive these messages. In practice, this is safe here: the message stays within the same window, `contextIsolation` prevents cross-world access, and `musicKitHook.js` validates `event.source === window` and the `sidra:command` type before dispatching.

No exploitable path exists because no cross-origin frames are loaded in the main window. If Apple Music ever embeds third-party iframes, those frames could observe these messages.

**Fix (defence-in-depth):** Replace `'*'` with the page's own origin:
```typescript
window.postMessage({ type: 'sidra:command', channel, args }, 'https://music.apple.com');
```

---

### O2. [CWE-78] Shell string interpolation in build hook - `build/afterPack.cjs:29`

```javascript
execSync(`uvx --from castlabs-evs evs-vmp sign-pkg "${appOutDir}"`, { stdio: 'inherit' });
```

`appOutDir` is sourced from the electron-builder context, not user input. The double quotes around the interpolated variable prevent most shell metacharacter injection. This is a build-time script that does not run in the distributed application.

A path containing `"$(...)` or backticks could still escape the quotes. The risk is low because the electron-builder context controls `appOutDir`.

**Fix (defence-in-depth):** Use `execFileSync` with an argument array to avoid shell interpretation entirely:
```javascript
const { execFileSync } = require('child_process');
execFileSync('uvx', ['--from', 'castlabs-evs', 'evs-vmp', 'sign-pkg', appOutDir], { stdio: 'inherit' });
```

---

### O3. [OWASP A06:2021] Broad macOS entitlements - `build/entitlements.mac.plist`

The entitlements include:
- `com.apple.security.cs.allow-jit` - JIT compilation
- `com.apple.security.cs.allow-unsigned-executable-memory` - unsigned memory execution
- `com.apple.security.cs.disable-library-validation` - load unsigned libraries

All three are required by Electron and the Widevine CDM. These entitlements weaken macOS hardened runtime protections but cannot be removed without breaking functionality. Documented for completeness.

---

### O4. [CWE-20] MPRIS OpenUri prefix-only validation - `src/integrations/mpris/index.ts:519-523`

```typescript
OpenUri(uri: string): void {
  if (!uri.startsWith('https://music.apple.com/')) {
    mprisLog.warn('OpenUri rejected non-Apple Music URI:', uri);
    return;
  }
```

Validates only the URL prefix. A URI like `https://music.apple.com/@redirect?url=https://evil.com` would pass validation and navigate the main window. The actual risk depends on whether music.apple.com has open redirects. The D-Bus attack surface is local-only (other processes on the same user session).

**Fix (defence-in-depth):** Parse the URI and validate the hostname explicitly:
```typescript
try {
  const parsed = new URL(uri);
  if (parsed.hostname !== 'music.apple.com' || parsed.protocol !== 'https:') {
    mprisLog.warn('OpenUri rejected:', uri);
    return;
  }
} catch { return; }
```

---

## Dependencies

### GHSA-f886-m6hf-6m8v: brace-expansion ReDoS (Medium, CVSS 6.5)

| Field | Value |
|-------|-------|
| Package | `brace-expansion` |
| Affected versions | 1.1.12, 2.0.2, 5.0.4 (all dev dependency chains) |
| Fixed in | 5.0.5 |
| Ecosystem | npm |

This is a **dev-only** transitive dependency. It does not ship in the packaged application. The ReDoS vulnerability requires crafted input to `brace-expansion`, which is used by glob/minimatch in build tooling. No runtime impact.

**Fix:** Run `npm audit fix` or update the transitive dependency chain. Low priority.

### Supply chain observations

| Concern | Detail | Risk |
|---------|--------|------|
| Caret version ranges | All 5 runtime deps use `^` ranges in `package.json` | Mitigated by `package-lock.json`; a missing or stale lock file would pull untested versions |
| CastLabs Electron fork | `electron` pinned to git commit `3412c2d` from `castlabs/electron-releases` | Pinned to a specific commit hash, which is good; the CastLabs fork is actively maintained |
| `undici` override | `"undici": ">=6.24.0"` forces a minimum version | Addresses a prior vulnerability; the override is correct |
| No `postinstall` scripts | No runtime dependencies declare `postinstall` hooks | No supply chain execution risk at install time |

---

## Beat Summary

**Scope:** 22 TypeScript source files, 2 injected JavaScript scripts, 1 injected CSS file, 2 HTML files, 1 build hook (`afterPack.cjs`), `package.json`, `package-lock.json`, and macOS entitlements. 395 git commits scanned for secrets.

**Files patrolled:** 233 (Semgrep), 26 (manual review of all source and asset files).

**Overall security posture:** Strong for an Electron application of this scope.

The codebase follows Electron security best practices consistently:
- `contextIsolation: true` and `nodeIntegration: false` on all windows
- IPC channel allowlists in both directions (preload and renderer)
- Command allowlist in the renderer bridge (`musicKitHook.js`)
- Protocol validation on external URL opening (`setWindowOpenHandler`, tray links)
- Input validation on all IPC payloads in `player.ts`
- Proper cleanup of event listeners and timers on `will-quit`
- No secrets in source or git history
- No `eval()`, `Function()`, or dynamic code generation from user input
- HTML files use `.textContent` assignment, not `.innerHTML`
- CSP headers on local HTML files (splash, about)

**Repeat-offender patterns:** None identified. The two missing protocol validation instances (W2 and the Semgrep wildcard postMessage) are isolated rather than systemic.

## Remediation Roadmap

| Priority | Finding | Effort | Action |
|----------|---------|--------|--------|
| 1 | W2 - Missing protocol validation on update URL | Low | Add `https:`/`http:` check before `shell.openExternal()` in `update.ts:85` |
| 2 | W3 - Main window missing sandbox | Medium | Add `sandbox: true`, verify Widevine CDM and preload still function |
| 3 | W1 - Disabled update signature verification | High | Sign Windows builds, remove `verifyUpdateCodeSignature = false` |
| 4 | O1 - Wildcard postMessage origin | Low | Replace `'*'` with `'https://music.apple.com'` |
| 5 | O2 - Shell interpolation in build hook | Low | Switch to `execFileSync` with argument array |
| 6 | O4 - MPRIS OpenUri prefix validation | Low | Parse URL and validate hostname explicitly |
| 7 | GHSA-f886-m6hf-6m8v | Low | `npm audit fix` for dev dependency |

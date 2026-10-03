# DeepSeek Harness Integration

[Back to the setup guide](setup-guide.md)

Clawd's first DeepSeek Harness (DSH) integration is experimental and supports the
DSH `web` profile. A Clawd-managed plugin runs inside DSH and uses public APIs
for both state observation and ordinary blocking approvals. Clawd does not read
DSH's projection files and does not install a second monitor.

The compatibility gate is intentionally narrow while DSH remains a developer
preview. Clawd keeps an explicit table of verified DSH releases, each bound to its
own npm artifact and integrity:

| DSH version | npm artifact | npm integrity (sha512) |
| --- | --- | --- |
| `0.1.5-rc.3` (preferred for new installs) | `@deepseek-ai/dsh@0.1.5-rc.3` | `sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==` |
| `0.1.5-rc.1` | `@deepseek-ai/dsh@0.1.5-rc.1` | `sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg==` |
| `0.1.1-rc.2` | `@deepseek-ai/dsh@0.1.1-rc.2` | `sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==` |
| `0.1.0-rc.6` | `@deepseek-ai/dsh@0.1.0-rc.6` | `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==` |

Install and Repair select the contract matching the detected host (or the owned
marker when no CLI probe is available); new installs prefer `0.1.5-rc.3`.
Uninstall and manual `npx` commands select the contract of the installed
marker. Pre-release versions are exact-pinned — a broad `>=0.1.x` range would
admit artifacts this bridge has not verified. The public seams were first
audited against upstream commit `47f9438`, then rechecked in the compiled
rc.6 artifact; that commit is a source baseline, not a claimed tag mapping.
The `0.1.5-rc.1` row was added after re-checking the same four public seams
(`session/created`, `session/event`, `session/disposed`, and the
`approval/request` waterfall) in the published `0.1.5-rc.1` artifact. The
optional title and context-pressure projections were also checked against
the published rc.1 packages. A
controlled macOS session and approval smoke against a localhost mock Clawd
endpoint followed; its scope is
described below. The `0.1.5-rc.3` row was added after re-checking the same four
public seams (`session/created`, `session/event`, `session/disposed`, and the
`approval/request` waterfall) plus the optional title and context-pressure
projections in the published rc.3 artifact; a macOS real-machine run using the
real Clawd UI followed (see below).
Unlisted versions fail before Clawd changes the DSH profile.

## Behavior

The plugin observes `session/created`, `session/event`, and `session/disposed`.
It sends a minimal allowlisted payload to Clawd's dynamically discovered local
port; prompts, reasoning, tool arguments, tool results, environment variables,
and credentials are never forwarded. Per-session FIFO delivery plus DSH's
persistent event sequence prevents a late tool event from reviving a disposed
session.

| DSH public event | Clawd event / state |
| --- | --- |
| session created | `SessionStart` / `idle` |
| turn started | `UserPromptSubmit` / `thinking` |
| tool call | `PreToolUse` / `working` |
| successful tool result | `PostToolUse` / `working` |
| failed tool result | `PostToolUseFailure` / `error` |
| turn ended | `Stop` / `attention` (or `StopFailure` / `error`) |
| session disposed | `SessionEnd` / `sleeping` |

DSH's `session/title` event supplies the Session HUD and Dashboard title. When
the public session projection service is present, the plugin also follows
`contextPressure` changes and reads its current value when a session is
created. Clawd displays the same reference occupancy as DSH's ContextMeter:
`(projectedTokens ?? pressureTokens) / contextWindow`, rounded and capped at
100%. It appears only after DSH has reported both usage and model capacity.
The projection is a reference estimate, especially after content changes or a
model switch. Projection updates annotate an existing Clawd session without
creating a card or changing its activity time. If DSH no longer reports both
operands, Clawd clears the old percentage instead of displaying a stale one.
The standard completion bell appears when a finished DSH session is unread.

The quota coin is separate account telemetry. DSH does not currently expose
a five-hour usage bucket through this plugin's public session APIs, so Clawd
does not invent a DSH `5h` percentage. DeepSeek's
[API balance](https://api-docs.deepseek.com/api/get-user-balance/) is an amount
of money and cannot be represented as that rolling-window percentage.

For ordinary `approval/request`, the plugin prepends a blocking listener:

- Clawd **Allow** returns DSH `allowed-once`.
- Clawd **Deny** returns DSH `rejected`.
- HTTP 204, timeout, invalid response, DND, disabled integration, or unavailable
  Clawd calls `next()` so DSH's native web answerer remains authoritative.
- DSH cancellation aborts the pending HTTP request.
- `policy="never"` is enforced by DSH before listener dispatch and cannot be
  overridden by Clawd.

`ask_user_question` stays entirely in DSH's native provider. Clawd does not
replace private provider state, create a second question bubble, or auto-answer
questions. DSH approvals also remain manual when Clawd auto-tools or unattended
mode is enabled; per-session grants are not offered in this experimental release.

## Requirements

- DSH `0.1.5-rc.3` (preferred), `0.1.5-rc.1`, `0.1.1-rc.2`, or `0.1.0-rc.6` on the same machine.
- The `web` profile.
- `pnpm`, because the official DSH plugin command delegates profile mutation to
  pnpm.
- Preferably a global `dsh` CLI on `PATH` for automatic install, repair, and
  uninstall.
- **Node.js `>=22.19.0`** on the `0.1.x` patched line. This is the range the
  bridge is tested against. Lower patch releases install and pass `--version`,
  but `npm warn EBADENGINE` from a dependency (`undici@8.11.2`,
  `@earendil-works/pi-ai@0.85.1`, both requiring `>=22.19.0`) means a
  contract-pinned install on an older `22.x` minor is unverified.

`DSH_HOME` is honored when it is a trimmed non-empty value; otherwise Clawd uses
`~/.dsh`.

### Windows: PATH and restarts

Two Windows-specific details decide whether an otherwise correct install appears
to work.

**Clawd needs the npm global bin directory on the *user-level* PATH.** Clawd is a
GUI (Electron) process: it never sources a shell profile, so a `dsh` CLI that only
an interactive shell can resolve — because `%APPDATA%\npm` is on the
machine-level PATH but missing from `HKCU\Environment` — is invisible to the
installer. On Windows Clawd therefore ensures `%APPDATA%\npm` is present on the
user-level PATH. The change is additive: existing entries are preserved and the
directory is appended, never reordered. If the registry cannot be read or written,
the install still proceeds unchanged.

**A PATH change cannot reach a running Clawd.** Electron caches `process.env` at
startup, so a PATH edit made after launch has no effect on the current process —
even after `WM_SETTINGCHANGE` is broadcast. **Fully quit and relaunch Clawd**
(confirm no `Clawd on Desk` processes remain) after any PATH change. Restart
`dsh web` as well, so it picks up the newly installed plugin generation.

### Which `dsh` gets probed

Clawd enumerates the `dsh` candidates on `PATH` and prefers one whose reported
version is in its contract table, instead of taking the first hit. This matters
on Windows because the desktop bundle ships its own `dsh` shim which can resolve
first and report a version the bridge does not support; without enumeration a
correctly installed contract-matching CLI later on the same `PATH` would be
ignored. If no candidate reports a contract version, Clawd falls back to the
first resolved candidate and reports it as unsupported rather than silently
skipping it. The contract table is exact-match and is never widened at runtime.

Note that installing the contract version can make the terminal's `dsh` and the
desktop bundle's internal CLI report different versions. That is expected: they
are independent surfaces, each correct for its own consumer.

## Install and repair

Open **Settings → Agents**, find **DeepSeek Harness (web, experimental)**, and
click **Install**. Install succeeds only after Clawd has:

1. copied the packaged bridge into an immutable hash generation under
   `~/.clawd/integrations/deepseek-harness/homes/<dsh-home-hash>/generations/`;
2. called `dsh plugin --profile web add <generation>`;
3. verified both DSH profile rows, the final profile-local package resolution,
   the Clawd ownership marker, protocol, compatibility range, and bundle hash.

The `plugin add` target is the **generation directory**
(`…/generations/<bundle-hash>`), which is the plugin root and carries its
`package.json`. The `homes/<dsh-home-hash>/` directory above it is only a
namespace: it holds `generations/` and the marker file, no `package.json`, so
passing it to `plugin add` fails even with a working CLI.

The same operation is available for development:

```bash
npm run install:dsh
node hooks/dsh-install.js --repair
```

The `<dsh-home-hash>` namespace is derived from the canonical `DSH_HOME` path.
Separate DSH homes therefore never share a generation that one home's uninstall
or cleanup could delete.

If DSH is only used through `npx`, Clawd does not download it automatically.
Settings returns an exact manual `npx @deepseek-ai/dsh@<contract> plugin ... add`
command (the contract matching the staged generation — `0.1.5-rc.3` for a
preferred-contract install, or the marker's own version
`0.1.5-rc.1`, `0.1.1-rc.2`, or `0.1.0-rc.6` otherwise) pointing at the staged managed generation and explicitly setting the
canonical target `DSH_HOME` (PowerShell on Windows, POSIX environment-prefix
syntax elsewhere). This keeps an alternate home from accidentally mutating the
default `~/.dsh` when the command is pasted into a fresh terminal. After that command succeeds,
Install can verify the existing marker-owned plugin without requiring a global
CLI. The generation is protected by a Clawd-owned manual reference until it is
verified, replaced, or explicitly uninstalled; its marker records that the DSH
version was assumed at staging because no CLI version probe was available. A
malformed, foreign, or concurrently replaced reference fails closed, reports its
exact path, and retains managed generations for manual inspection.

Startup sync repairs only an already opted-in, installed-and-enabled integration.
It never initializes a missing DSH profile. Settings Install or explicit Doctor
Repair may allow the official CLI to initialize that profile. A running `dsh web`
process may need a restart after install or repair — restart it so the new
plugin generation is actually loaded.

### pnpm `allowBuilds` placeholder

`dsh plugin add` can abort in the profile directory with:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @aiwayds/dsh-subagent-registry@<version>
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

The cause is usually a profile's `pnpm-workspace.yaml` shipping pnpm's
human-facing placeholder instead of a decision:

```yaml
allowBuilds:
  '@aiwayds/dsh-subagent-registry': set this to true or false
```

pnpm writes that placeholder when it cannot decide whether a dependency's build
scripts may run. pnpm `11.4.0` then treats the value as unset and fails closed.
Edit the file and set each entry explicitly — `true` to allow the build scripts,
or `false` to keep them blocked:

```yaml
allowBuilds:
  '@aiwayds/dsh-subagent-registry': false
```

`false` is the safe choice when you do not need that package's build step; the
install then completes. Only use `true` for a dependency you trust. This is a
file in your own DSH profile under `~/.dsh/profiles/<profile>/`; Clawd does not
rewrite it for you.

### Mutation lock recovery

Install, Repair, Uninstall, and cleanup share a per-`DSH_HOME` mutation lock.
Clawd automatically recovers a stranded lock only when its owner metadata is
valid, it is older than twice the operation timeout recorded by that owner, and
an OS PID probe returns `ESRCH` (the recorded process definitely no longer exists). A live
PID, `EPERM`, an unknown liveness result, or malformed/foreign owner metadata is
never taken over.

Lock errors include the exact `mutation.lock` path. If automatic recovery refuses
the lock, close every Clawd instance using that DSH home, verify the reported PID
is no longer running, and inspect `owner.json` at that exact path. Do not delete a
lock owned by a live or unknown process. Preserve malformed or foreign contents
for inspection; Clawd never recursively removes a canonical lock during owner
write failure or release, and only removes the exact isolated owner file plus an
empty lock directory.

## Uninstall and ownership safety

Use Settings → Agents → Uninstall, or:

```bash
npm run uninstall:dsh
```

Clawd verifies ownership before it calls the official remove command. A user
package or fork with the same package name is reported as a conflict and is never
overwritten or removed. Settings commits the uninstalled preference only after
the dependency row, bundle row, and resolved Clawd package are all gone.

`$DSH_HOME/profiles/node_modules` is DSH/pnpm's shared dependency fallback, not a
Clawd ownership anchor or cleanup target. Clawd may report what resolves there,
but it never rewrites or deletes that tree; pnpm owns any fallback-link cleanup.

Doctor reports DSH host detection separately from managed plugin disk health.
Disk health cannot prove that an already-running DSH process loaded the new
generation, so restart guidance remains conservative.

The installer and Doctor accept only a listed DSH version before changing the
profile; each operation resolves its contract from the detected host version or
the owned marker, never from a broad range. DSH does not currently expose a public host-version/activation seam to
external plugins, so an already-installed bridge cannot reliably disable itself
before listener registration if DSH is upgraded in place. This is an explicit
experimental limitation: restart after changes, heed Doctor compatibility
warnings, and rely on DSH's native web flow whenever Clawd yields no decision.

## Scope and fallback

- Windows x64 native DSH web is the first target. Real rc.6 install, config
  composition, web boot, uninstall, and packaged-app source loading were verified
  on 2026-08-14.
- On 2026-08-29, **rc.6 source-checkout** runs on Windows x64 and macOS
  verified real API-backed DSH web sessions plus manual Clawd **Allow Once**
  and **Deny** round trips. macOS also verified Settings Install under a
  Finder-like GUI `PATH`. These are source-run results, not packaged API-session
  verification ([#962](https://github.com/rullerzhou-afk/clawd-on-desk/pull/962)).
- Separately, the 2026-08-29 **Windows x64 rc.2 packaged-app** evidence covered
  install, web boot, and `/state` plus Allow/Deny round trips driven directly
  through the bridge's `clawd-client`. It did not demonstrate an API-backed rc.2
  DSH session. On 2026-08-31, maintainer validation also covered the rc.2 Windows
  install/uninstall lifecycle through isolated pnpm and the real rc.6 macOS
  lifecycle, including no-CLI commands
  ([#938](https://github.com/rullerzhou-afk/clawd-on-desk/pull/938)).
  Automated installer coverage includes rc.1 installation, rc.3 installation,
  first install below
  a symlinked parent, rc.6 retention, rc.2 installation, cross-contract
  generation migration, and unlisted-version rejection.
- On 2026-09-23, a **macOS rc.1 source-run** used isolated `HOME` and `DSH_HOME`,
  real `dsh web` sessions created and prompted through DSH's public API, and a
  localhost mock Clawd endpoint. Without the bridge, the baseline session
  emitted no `/state` request. With the bridge, the endpoint received
  `SessionStart`, `UserPromptSubmit`, and `Stop`; a controlled ordinary approval
  request sent to `/permission` resolved to `allowed-once` for Allow and
  `rejected` for Deny. An HTTP 204 left the request pending until DSH session
  cancellation produced `cancelled`. The probe ended before any model step.
  This verifies the bridge and DSH API behavior, not the real Clawd UI or a
  packaged app.
- On 2026-09-24, a second isolated rc.1 Web API run verified `session/title`
  forwarding and live `contextPressure` updates. A local fake SSE endpoint
  supplied controlled model usage, so no real model call or user DSH profile
  was involved. A synthetic 500013-token prompt against DSH's 1000000-token
  context window produced `context_usage: { used: 500013, limit: 1000000,
  percent: 50 }` at a mock Clawd `/state` endpoint, alongside SessionStart,
  UserPromptSubmit, and Stop. This verifies the DSH-to-bridge calculation and
  delivery, not a real user's usage, the Clawd UI, or a packaged app.
- On 2026-09-27, a **macOS rc.3 source-run** used macOS 26.6.2 on Apple silicon
  with the globally npm-installed `@deepseek-ai/dsh@0.1.5-rc.3`
  (`dsh --version` printed `0.1.5-rc.3`) running `dsh web`. It used the
  maintainer's everyday DSH profile rather than an isolated `DSH_HOME`, and Clawd
  ran from this branch's source at commit `691e2ee3`, not a packaged app. Clawd's
  startup sync replaced the managed bridge generation left by an older Clawd
  build with the rc.3 generation (manifest `installedDshVersion: 0.1.5-rc.3`,
  range `=0.1.5-rc.3`), and DSH web listed `clawd-bridge` as an enabled global
  plugin. The real conversation used DSH's official DeepSeek provider with
  `deepseek-flash`, the default `workspace-write` permission preset, and the
  `ask` approval policy. Clawd received `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop` from the bridge.
  Clawd's Session HUD showed the DSH-generated session title and the context
  occupancy percentage (confirmed visually). For an approval, asking DSH to
  create a file outside the workspace made the model request sandbox escalation
  to `danger-full-access` for bash, which raised `approval/request` and showed a
  Clawd approval bubble. Choosing **Allow** recorded `allowed-once` in DSH, the
  command ran, and the file was created. Choosing **Deny** recorded `rejected`,
  the tool call failed (Clawd showed `PostToolUseFailure`), and the command did
  not run (the Deny prompt targeted the file created in the Allow step, and its
  modification time did not change). This verifies install via startup sync,
  session state, HUD metadata, and Allow/Deny with the real Clawd UI on a source
  run. It did not cover a packaged app, a first install through Settings,
  Uninstall, DND, or the HTTP 204 hand-back and cancellation paths; the last two
  were exercised against a mock endpoint in the 2026-09-23 rc.1 run and were not
  retested on rc.3.
- Linux, WSL, remote SSH, non-web profiles, macOS packaging, and ARM64 packaging
  remain unverified.
- There is no terminal-focus action because DSH web is a browser surface.
- Closing the local bubble does not deny the request. If a configured Telegram
  or Feishu/Lark remote channel takes it, that channel may decide; otherwise DSH
  receives no Clawd decision and continues its native flow.
- Hiding the pet is not DND, so a new approval may still show a bubble. DND
  returns control to DSH without deciding.

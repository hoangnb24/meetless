# Local MAS Development

Use the existing simple development loop. This guide governs local development;
release/App Store validation remains separate under
[ADR0005](decisions/0005-mac-app-store-and-revenuecat.md).

## Choose the operation

| Need | Existing command | Effect |
| --- | --- | --- |
| Open the installed app again | `npm run dev:mas:launch` | Opens through LaunchServices and checks the real Meetless plugin; no build, install or runtime reset. |
| Update while keeping recordings | `npm run dev:mas:update` | Builds, signs and validates, quits the installed app, verifies it is stopped, backs up app/runtime, replaces the app and checks readiness; runtime data stays in place. |
| Install the already validated current candidate | `npm run dev:mas:update -- --reuse-current` | Skips build/sign/publication, revalidates the durable artifact against current environment configuration, then uses the same preserving update and installed-signature/readiness checks. |
| Build and install fresh with disposable test data | `npm run dev:mas` | Builds, signs, validates, publishes a durable artifact, resets the canonical runtime, replaces the app, opens it and checks plugin readiness. |

**`dev:mas` deletes the canonical runtime, including its recordings.** Run it
only when the owner has authorized resetting the current disposable test state.
Do not infer permission from an earlier test reset or a request to fix/build the
app. Use `dev:mas:update` when recordings must survive an update. It requires an
existing app and runtime directory and refuses legacy evidence, a held host
lock, a running host, open app/runtime files or a listener on port 16777.

The update holds the existing stable host lock through backup, replacement and
any app rollback, then releases it before launch. Replacement uses the current
user’s permissions after validating `/Applications` and app ownership; it never
requests administrator privileges or falls back to elevation. Permission failures
stop and retain the backup. The updater validates a staged sibling before moving
the previous whole app to a unique retained `/Applications` sibling, then moves
the candidate into place using no-replace renames. It never recursively deletes
the installed app or changes receipt permissions. An unlocked lock file is normal
and stays in place.

Updates retain the previous app and runtime under
`.artifacts/macos-mas-development/update-backups/backup-*`. A replacement or
signature failure preserves the failed candidate and restores the previous whole
app when directory identities and the held lock prove a safe rollback. Ambiguous
state stops with all retained paths reported. The previous whole app remains at
its reported `/Applications/.Meetless-previous-*.app` path after success.
Runtime data is never reset or
automatically restored. If launch/readiness fails, retain the reported backup
and diagnose before another operation. Do not delete retained backups without
separate authorization.

The commands require Apple-silicon macOS, the existing development signing
identity/profile, and the configured public RevenueCat SDK key and Convex URL
in `.env.local`. Follow the existing script's diagnostics for missing inputs;
never print credentials or substitute a different identity or service.

## Normal loop and evidence

The implementation owner is
[`scripts/macos-mas-development-loop.mjs`](../scripts/macos-mas-development-loop.mjs).
It builds in disposable scratch space and retains the validated artifact at
`.artifacts/macos-mas-development/current`. The installed app is
`/Applications/Meetless.app`; writable state is the `Meetless` directory under
the app container's `Data/Library/Application Support`.

After an authorized fresh install, use the launch command for repeated opens.
`owner-test-ready` proves startup and a real plugin `listMeetings` response.
It does not prove recording, purchase, transcription, relaunch persistence or
release readiness. Test the requested behavior through the real app and bind
the result to the exact artifact under the
[production-evidence rule](patterns/production-evidence.md).

## Existing data or legacy blockers

Legacy session remnants block this route; they are not a reason to switch to
the old coordinator, replay a handoff, edit a journal, or design a new transaction
schema. Preserve the data and report the exact blocker. Disposition of retained
state requires its own bounded authorization; this guide grants no cleanup.

Check [the active plan](plans/active/v1-paseo-foundation.md) for any current
blocker before operating the app. The completed issue #8 ad hoc disposition is
historical evidence, not a reusable reset or recovery command.

The owner accepted this simplified route on 2026-09-10 and rejected the
transaction-v3 proposal. Historical coordinator run IDs and one-time reset
permissions do not govern the normal loop; ADR0005 is the current authority.

# Issue #9: recording feedback validation

Accepted 2026-09-12. Independent reviewer and Lead **ACCEPTS** the issue #9
completion criteria on the exact development-signed MAS artifact below.

## Accepted candidate

- Manifest SHA-256:
  `6dde5d9ce4da9cf788fd91f2ba267d96ef506c75e5981890ec659e537f0a7b97`.
- Producer source HEAD: `6eaa779ed09c36edae8311e84cf5826f6862b41a`, with
  the retained working-tree baseline identified by snapshot digest
  `b08f7ca6cae099a0d74df7228eef2fd132446da6181f375e7cf4f3e5ff9082fb`.
- Installed host cdHash: `3239bf26559a41ffc826cb1a4dc05e2733be0db6`, matching
  the manifest. Installed deep/strict signature verification passed.
- Actual producer/consumer route: `npm run dev:mas:update`, through build,
  packaging, signing, preserving installation and fresh-process installed-client
  readiness. The complete run exited 0. No fixture or alternate runtime route
  supplied this acceptance.

Source commits `8aadef0` and `6eaa779` provide immediate save/retry feedback,
latest-attempt diagnostics, bounded readable details and truthful selected-meeting
status. Saved audio clears historical errors. Known-unsaved audio does not claim
that a saved file exists or offer misleading saved-audio copy. Stop, startup and
consent do not automatically schedule transcription, following the accepted #7
policy. Minimal source integrations were reviewed separately from the retained
dirty baseline; this artifact acceptance does not accept unrelated #10 changes.

## Observed behavior

- Ordinary Stop on this exact artifact showed Saving with disabled controls,
  then saved audio without intervention. Its MP3 identity matched the runtime
  record; the preceding six recordings and files remained unchanged.
- A separate new microphone/system recording exercised actual save failure.
  Only its signed ffmpeg finalizer, matched by recording ID and native ancestry,
  was paused and terminated after identity rechecks. Existing audio was untouched.
- Global controls, selected sidebar row, header and transcript pane consistently
  reported unsaved audio. Long real diagnostics wrapped in a bounded scroll area;
  the end remained reachable while the summary and Retry button stayed visible.
- Retry immediately showed pending and disabled the button. A duplicate click
  did not create a second finalizer. A targeted repeated failure displayed the
  latest attempt diagnostic, and all 153 durable session files remained unchanged.
- The next ordinary Retry saved the audio and cleared the error/details/Retry
  action. No transcription or purchase was initiated.
- Ordinary quit proved the old process tree absent. Relaunch created a new host
  and retained the whole store and all six then-saved MP3s byte-for-byte. The
  selected recording reopened as saved without historical errors. The final
  direct-Stop check appended the seventh saved recording without changing those six.

## Preserving update

The corrected full update independently passed and is also **ACCEPTED** by Lead
for its bounded development purpose. All 21 pre-update store/audio files, including
five MP3s, were byte-identical after installation. Runtime inode `51230577` and
stable lock inode `51230576` were retained. Backup `backup-1CNfvc` contains the
previous app and runtime; no cleanup is authorized by this record.

`e33aa3b` added the preserving route and `b80cd1c` corrected readiness to use a
fresh process with the installed client. Local proof includes 41 route/profile
tests and 24 subsequent readiness tests, including a real Node ESM-cache
regression using synthetic modules. The complete actual run above, rather than
those tests alone, establishes preserving-update acceptance.

## Earlier failures retained

- An initial updater unnecessarily requested admin and was canceled before app
  mutation. Process absence, native lock release and original data were verified.
- Reusing that candidate failed closed when shipped source inputs changed.
- Candidate `1193570cd5f6342c6b19e0043f94f3dd8ed8ca65b9cbad59ba7580ca2d3f0f26`
  installed but its long-lived updater failed the repo-local readiness import: it
  held prebuild contracts in the ESM cache. Installed exports were correct; a
  separate ordinary fresh launch passed. That does not change the failed run.
- Actual UI review on that candidate found broken expanded-details layout and a
  misleading Recording label. It was rejected for #9; the accepted candidate
  above resolves these findings. Missed test interceptions sent no signals and
  are retained as attempts, not negative-path proof.
- Direct signed-ffmpeg shell decode probes trapped. `afinfo` read metadata only;
  no playback or full decode claim is derived from those probes.

## Evidence and limits

Private evidence is retained under `.artifacts/issue9/corrected/`, especially
`candidate-manifest.json`, `update.log`, `live-validation-handback.md`,
`post-update-state.json`, `retry-failed-state.json`, `after-relaunch-state.json`,
`direct-stop-proof.json` and the corresponding UI/process/identity inventories.
Earlier failed evidence stays under `.artifacts/issue9/`. Source extraction,
101 focused correction tests, typechecks and the private browser preview are in
`.artifacts/issue9/live-fix-source/`; original 125-test source proof is in
`.artifacts/issue9/source-integration/`. Audio, raw logs and screenshots are not
committed or attached to the public issue.

#14 has partial second-launch evidence but no proven background-to-foreground
transition and no reboot test. #6 still requires owner-driven monthly sandbox,
Restore and entitlement convergence. This acceptance excludes #6, #10, billing,
managed production and release readiness. No CI run or externally enforced
branch-protection result is claimed.

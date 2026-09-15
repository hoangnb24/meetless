# Execution Plan: Meetless V1

Updated: 2026-09-15

## Production preparation — owner decision 2026-09-14

The owner selected production preparation as the next work: upload a Mac App
Store build, configure RevenueCat for real App Store purchases, and use Convex
production. Freeze the current source before beginning this work.

GitHub execution breakdown: [Epic #21](https://github.com/hoangnb24/meetless/issues/21), new sub-issues #22–#28 and retained #14–#17/#20. Native dependencies own the execution order; #22/#23 are the first inputs. Website #28 supplies final URLs to #17 and can proceed alongside app testing. This link does not change the frozen source.

### Current execution checkpoint — 2026-09-15, Apple processing complete

This checkpoint supersedes historical missing-login/key/empty-production and
failed-artifact observations below. #22–#26 are accepted, including the corrected
exact distribution package and actual Apple validation. Upload succeeded with
delivery/build `0816cc3b-8b69-4357-bf0d-32537ec34b8b`. At 01:23:16 UTC,
Apple reports upload COMPLETE and binary VALID, with no errors or warnings.
After the owner explicitly approved the exact standard-encryption/non-France
answers, the declaration was saved. At 02:24:21 UTC the API confirms internal
READY_FOR_BETA_TESTING and external READY_FOR_BETA_SUBMISSION, with
usesNonExemptEncryption false. Epic #21 remains in progress; no launch/billing/App
Review or public release is inferred from this processing result.

| Public release input | Verified value |
| --- | --- |
| Frozen baseline | `production-baseline-2026-09-14`, `6b051116af4dbf8a22337f51b995e120454b79d0`; never move |
| Deployed successor source | `63b3768ed334c68cb79dcfc87545b523349ed353`, isolated `/tmp/meetless-production-63b3768` |
| Apple app / bundle / team | `6807070739` / `com.meetless.app` / `63M98WD275` |
| Candidate version / build | `1.0` / `1`, MAC_OS; upload COMPLETE, binary VALID; internal TestFlight ready, external beta submission still separate |
| Packaged source / package | `41cfc34382f95dcf3b08fca74347cccb673b15be` / SHA-256 `b6f0fde5bf1e80c5254a80e3c0151be4f05f167d7b04bc699700bff7c50b5da7` |
| ASC upload key | `V8ZBF889R7`, dedicated Developer role explicitly approved; protected and Git-ignored |
| RevenueCat project / app | `0d7b4465` / `appe0ef526253`; existing monthly/annual, premium/default catalog retained |
| Convex project / region | `2906735`, `hoang-bang:meetless`, `aws-us-east-1` |
| Production | `content-bulldog-967`, `https://content-bulldog-967.convex.cloud` |
| Store-testing Sandbox | named reference `store-testing`, `posh-mink-212`, `https://posh-mink-212.convex.cloud` |
| Production webhook | `whintgr3085ebc4c2`, `https://content-bulldog-967.convex.site/webhooks/revenuecat`, Production only |
| Store-testing webhook | `whintgrb51603f89e`, `https://posh-mink-212.convex.site/webhooks/revenuecat`, Sandbox only |
| Current Apple IAP verification key ID / issuer | `WZ7MKM8T9D` / `69a6de8c-6878-47e3-e053-5b8c7c11a4d1`; replaced and revoked `U48V6LU6X3` |
| Production provisioning | Portal `8CS67VVGJM`, UUID `1db987ef-8549-4c4f-afdd-4b0ee82d135d`, Meetless Mac App Store Production 2026-09-14; downloaded bytes accepted |

- Both new webhooks are active, app-filtered to Meetless, HMAC enabled with
  distinct secrets, and subscribe to Initial purchase, Renewal, Product change,
  Cancellation, Billing issue, Uncancellation and Expiration. No Events observed;
  real provider delivery and Apple transaction verification remain #15 evidence.
  Existing development webhook `whintgr572df9a8f6` remains unchanged.
- Production configuration uses 28,800 seconds/month, trial 18,000 seconds over
  seven days, `production-config` and Apple PRODUCTION verification. Store-testing
  uses 1,800 seconds per allocation including trial, accelerated periods and
  Apple SANDBOX verification. Infra deployment type is production for both;
  runtime store-testing mode is `hosted-development`/`store-testing-sandbox`.
  Prices and purchase terms come from the Store catalog; no price or term was
  changed here. No existing periods, usage or reservations were reset.
- The distribution producer binds version `1.0` and build `1` into signed
  `CFBundleShortVersionString` and `CFBundleVersion`, and records both in its
  configuration and release manifest alongside source commit/snapshot and
  configuration digest. These bindings were independently checked in the exact
  corrected package; Apple validation passed with no errors or warnings.
- Separate JWT key pairs/audiences/issuers and HMAC secrets were applied through
  protected local files. The existing backend OpenAI credential was reused for
  the same Meetless provider purpose; it remains backend-only. Public Apple
  certificate roots were reused; development JWT/HMAC credentials were not.
  Secret source files, deployment tokens, signing keys and passwords are under
  ignored `keys/` (directory 0700, files 0600), never in the app or Git. Signed
  app configuration contains only public SDK key, endpoints, identity/version
  and source/config provenance. Provider/Apple private keys and auth-signing
  keys are backend-only; installer/app private keys remain in the local keychain.
- Both actual deployment preflights passed and 65 functions deployed per target
  from the isolated reviewed source. Public `/managed-auth/jwks.json` returned 200 and matched the
  intended key; unsigned webhook returned 401; unauthenticated device query
  returned an error whose internal cause Convex conceals. Public deployment
  evidence is retained locally at `keys/convex-deployment-evidence-2026-09-14.json`.
  Independent public checks confirmed those HTTP results; Lead ACCEPTS deployment
  availability only. `/.well-known/jwks.json` is not an implemented route (404).
  No purchase, transcription/provider request or live Apple status lookup was
  made. Availability does not establish billing or production acceptance.
- Default production selection remains `content-bulldog-967`; `.env.local`
  SHA256 remains `0326adef4a05a85502b2af08a375f8d92afa8a7819615a24f9e73de166585227`.
  Development `frugal-mandrill-646`, installed app and recordings were preserved.
  Recovery: retain exact source/config inputs; redeploy the reviewed source to
  the explicitly selected target using its scoped deployment token. Do not
  point sandbox at production or replay transactions into development. Before
  any rollback with data/schema impact, inspect the live state and compatible
  prior source; no data rollback or deletion is authorized by this checkpoint.
- A reviewer assertion accidentally exposed the newly created Apple API private
  key `U48V6LU6X3` in tool output before deployment. Root informed the owner,
  created the same-scope replacement `WZ7MKM8T9D`, verified the old key appears
  under Apple's Revoked keys, and updated both configurations before deployment.
  Only that key was exposed; existing RevenueCat credentials were not changed.
  Subsequent secret checks emit generic boolean failures, never compared values.
- Isolated release keychain imports and actual synthetic app/installer signing
  passed, including tampered-app and unsigned-package rejection. Lead ACCEPTS
  local signing usability only, based on independent review of exact evidence
  `.artifacts/production-preparation/signing-smoke-20260914T132202Z/`.
  Search list/default keychain were restored and release keychain locked.
  Owner subsequently downloaded the new matching provisioning profile into
  `keys/`; its actual bytes are accepted in the checkpoint below. The old profile
  does not match the new certificate and must not substitute for the new one.
- Lead ACCEPTS source-only routing preparation in `63b3768` after independent
  review: verified StoreKit context selects fixed signed endpoints with isolated
  credentials/upload state; focused plugin tests, TypeScript and native boundary
  proof passed. Review then identified an Apple-delivered signature launch gate
  and retained-identity transition issue, subsequently corrected by the Swift author.
  Lead subsequently ACCEPTS the exact two-file correction in `c6a1a2b` after
  independent review: strict submission signature or documented Apple Store
  `.1.9`/public TestFlight `.1.25.1`, exact bundle and Apple trust, authenticated
  optional team/app fields, and only canonical known-submission identity
  transitions. Development and unknown delivered identity transitions remain
  rejected. Swift build and full native debug tests passed; no delivered-app
  acceptance is implied.
- Lead ACCEPTS source/local packaging preparation in `3a815f5` after independent
  review of the exact five files. Production producer mandates clean build with
  source snapshot checks before/after, removes the desktop TypeScript cache
  outside `dist`, signs app and installer and verifies extracted payload equality.
  Reviewer ran 41/41 focused tests including actual TypeScript stale-cache
  reproduction and corrected regeneration. Actual complete producer, provisioning
  bytes, distribution artifact and Apple delivery remain untested.
- Actual clean-build attempt at `3a815f5` failed before JavaScript compilation:
  native integration tests need `packages/runtime/dist/cli.js`, but the top-level
  build ordered native before its JavaScript prerequisites. Clean removal exposed
  a dependency previously masked by retained outputs. Evidence retained at
  `.artifacts/production-preparation/distribution-clean-build-20260914T134649969Z/`.
  No test was skipped or weakened. Independent reviewer and Lead ACCEPTS the
  one-line build ordering correction in `579dc55`: Paseo and Meetless TypeScript
  compile before native integration tests, then the app export runs. The actual
  clean rerun is recorded separately under
  `.artifacts/production-preparation/distribution-clean-build-20260914T135119280Z/`;
  it PASSED at `579dc55f62dc26c108ab984369ea0a977be00f9b`, including native
  debug/release boundary tests and Expo export. Source snapshots before/after
  are identical `0117e9c6a203bb13705ccb84588314c2d36473a3c5e0b894894b5fa0e80c1b5f`;
  result manifest SHA256 is
  `1bdcfa00a85ecfd02d2addf9e9a43fcb66a980ad6e90801f1a1b53aa73e77a2d`.
  This exercised the actual clean-build helper, not the full signed package
  producer. Independent reviewer checked the retained logs/result/snapshots;
  Lead ACCEPTS actual clean-build evidence only. Profile, app/package signing
  and upload remain pending.
- RevenueCat Apps UI public SDK key for `appe0ef526253` was copied and compared
  to the existing local build input: exact match. Protected staging copy is
  `keys/revenuecat-public-sdk-key.txt`; this is a public app key, not a backend
  secret. Test Store key was not selected.
- Independent reviewer and Lead ACCEPTS this public configuration handoff for
  #22: exact identities, preserved baseline, region/targets, Store price/term
  authority, version/build binding contract, public/secret boundary and recovery
  are recorded. Lead ACCEPTS #24 configuration readiness from the observed
  catalog/valid-credential state, exact SDK binding and persisted per-environment
  HMAC integrations. Lead ACCEPTS #25 deployment readiness from actual scoped
  deployment/configuration evidence and independently checked availability.
  These input gates do not accept real Apple authentication, successful webhook
  delivery, billing, transcription, a packaged artifact or release.
  GitHub #22, #24 and #25 are closed/Done after this acceptance. Epic #21 stays
  open; #23/#26 remain In Progress and #27 stays blocked by the artifact gate.

### Provisioning received and package execution — 2026-09-14

- Owner supplied `keys/Meetless_Mac_App_Store_Production_20260914.provisionprofile`.
  Independent reviewer and Lead ACCEPTS the actual profile for #23: macOS,
  correct team/app, no development devices/debug entitlement, matching selected
  Apple Distribution certificate, expires `2027-09-14T12:44:40Z`. SHA256:
  `903f031904f19a31f2e5dac52ed75e5bd174d62e139500dfbeab09dd97181659`.
  Wrong certificate/team and expired-profile controls reject. File mode 0600,
  ignored by Git. Evidence:
  `.artifacts/production-preparation/profile-20260914T145253Z/validation.json`.
  Apple portal review confirms In-App Purchase enabled. App Sandbox is in the
  signing contract; team-prefixed macOS App Group does not require a profile
  entitlement ([Apple documentation](https://developer.apple.com/documentation/xcode/accessing-app-group-containers)).
  Final signed entitlements and actual StoreKit behavior remain separate proof.
- ASC recheck still shows version 1.0 and TestFlight No Builds. Local Xcode
  supplies `altool` for validation/upload. Available local Apple key is an
  In-App Purchase key, not an App Store Connect upload key. Root prepared the
  unsubmitted `Meetless Upload 2026-09-14` Team API key form with Developer role.
  Owner explicitly approved the new Developer scope, including team-wide app
  access. Created `Meetless Upload 2026-09-14`, key ID `V8ZBF889R7`; downloaded
  once and saved as `keys/AuthKey_V8ZBF889R7.p8`, owner-only and Git-ignored.
  No existing RevenueCat/Expo/IAP key is changed. ASC recheck still shows No
  Builds; actual Apple validation of the accepted 1.0/build1 package is running.
  Evidence: `.artifacts/app-store-upload/20260914-build1/`.
- Actual Installer smoke output exposed a status wording mismatch in the new
  package validator. Independent reviewer and Lead ACCEPTS correction `2af425e`
  tied to the selected certificate, its installer purpose, fingerprint and Apple
  trust. Actual smoke package and OS certificate trust pass; unsigned package
  fails and 41/41 focused tests pass. Public fixtures retain the observed output
  and public certificate only. This is validator acceptance, not a completed
  production package. #23 is closed/Done; #26 continues to actual packaging.
- Actual distribution producer started at
  `8b3cc723e9dcd5e801ea134aba44e2d19e1a332f`, package-source snapshot
  `b3edf85d23afa1a67d23480fec827ddb4d88ba5ab9eafff70ed524e9f5da19c4`.
  Original disposable proof root:
  `/private/tmp/meetless-mas-distribution-20260914T145923938Z`; durable attempt
  record `.artifacts/macos-mas-distribution/20260914T145923938Z/`.
  Inputs are accepted profile, explicit release keychain, version 1.0/build 1,
  verified public SDK key and the two approved signed endpoints. No installation
  or app launch is part of this producer. This first attempt used the main
  checkout, so it cannot satisfy #26's isolated-checkout criterion. It passed
  mandatory build/composition but stalled at codesign after the keychain had
  been unlocked about eight minutes earlier. The keychain creator confirms its
  unchanged default is lock-on-sleep with a 300-second timeout. Computer Use
  explicitly refused access to macOS SecurityAgent; no UI bypass was attempted.
  Root authorized cancellation of only this run's waiting codesign and diagnostic
  processes, retaining partial artifacts and allowing cleanup to restore the
  search list and lock the keychain. Cleanup completed; the failed result records
  keychain locked, search list restored and source unchanged. Independent reviewer
  and Lead ACCEPTS `2f6248a`: unlock at preflight and immediately before app and
  installer signing, with no ACL/timeout change. Synthetic credential failure
  through the actual extracted helper proves errors are sanitized. The next
  actual producer uses a detached checkout at this exact commit, pinned Paseo
  source from the verified bundle and genuine npm workspace dependencies. No
  root `node_modules` symlink or development env copy is allowed.
- Isolated checkout `/private/tmp/meetless-production-2f6248a` is detached at
  `2f6248af5440b031fad0cb2eb72bec35f431a654`. Verified pinned Paseo source/bundle;
  actual `npm ci` installed 1,277 packages, all 17 workspace links resolve inside
  this checkout, source status is clean and no development env was copied.
  Actual package-source snapshot:
  `cee2ce498db470e558f31802c8ab0751118dad0d605ca237bf2f7bb76ed1c3e9`.
  Actual isolated producer attempt
  `.artifacts/macos-mas-distribution/20260914T151337692Z/` FAILED in native debug
  attestation tests before app composition. Unlike the earlier missing-output
  failure, compiled JavaScript and native outputs exist; source is unchanged.
  Keychain locked/search list restored are confirmed in the retained result.
  Native author owns diagnosis of this isolated-path failure; no checks are
  weakened or skipped and no signed/uploadable package is accepted.


- Native isolated-path correction accepted by independent reviewer and Lead:
  process inspection now uses Darwin `realpath` rather than Foundation alias
  normalization. The test producer stages an exact byte-verified fixture only
  when Foundation would rewrite its argv path; strict argv/metadata/hash checks
  remain intact. Direct `/private/tmp` identity regression is retained.
  Full native suite executed from a real `/private/tmp` binary passed, including
  real Node attestation and negative identity cases. Evidence:
  `.artifacts/production-preparation/native-private-tmp-path-proof-YKveiD/result.json`.
  Accepted source SHA-256: `ae78c9aa033c5df327a73249ec555cbec6484e9ca6888b2dcf80e134e849dac9`
  (inspector), `2420bd3e2f4c02d55b42c1d73f92064ec4407348bbd03cb585a7d2ee28161591`
  (tests). This accepts source and the path regression only; a fresh isolated
  production producer and artifact review remain required.

- Fresh isolated producer started from `174d23974a973f613d77cf0f34adf40b8b9a1244`
  in `/private/tmp/meetless-production-174d239`, with all 17 workspace links
  resolving inside that checkout and no development env copied. Input snapshot:
  `33a0637e41ef951473c750d8f2b62009d222c7c637d022f4bce4b827f897b57b`.
  Attempt evidence: `.artifacts/macos-mas-distribution/20260914T152926594Z/`;
  original proof: `/private/tmp/meetless-mas-distribution-isolated-20260914T152926594Z`.
  FAILED before composition: debug native checks completed, but the Release
  `MeetlessHostTests` process exited with SIGPIPE. Prior path assertions did not
  recur. Source unchanged, keychain locked and search list restored are recorded
  in `result.json`. The native author and independent reviewer are investigating
  the actual Release failure; no package is accepted and no check is skipped.


- Independent reviewer and Lead ACCEPTS the bounded closed-peer socket fix.
  A deterministic Release fixture calling actual capability handling died with
  SIGPIPE before the fix. Per-socket `SO_NOSIGPIPE` now leaves disconnection as a
  bounded write failure; setup failure closes the socket. No process-wide signal
  policy or authentication/identity/argv rule changed. Healthy requests still
  return success after a closed peer. The exact site of the earlier intermittent
  producer SIGPIPE remains unknown; this does not retroactively prove its cause.
  Regression and full native Release suite from `/private/tmp` pass with no
  signal; evidence `.artifacts/production-preparation/native-release-closed-peer-proof-k3QdV0/`.
  Accepted source hashes: `e928c6ba63aeef911fc3f6c5b7d861bd89a34a63fb340daab00ed97fda4a84e6`
  (inspector/socket handling), `77b9e66f46b921e0573fa93f7cc9ee218922b8a2d676aaf5f505a1afdefa6546`
  (tests). Actual fresh isolated packaging still required.


- Fresh producer retry uses detached `a329304df4d72fe572085ab78c81a6b5c06a63ab`
  at `/private/tmp/meetless-production-a329304`; all 17 workspace links verified
  inside checkout. Source snapshot:
  `14dd6bf057af48f28a18707254a75d8ef3624d96029ca173a154b6d8c0f7821d`.
  Evidence `.artifacts/macos-mas-distribution/20260914T153929124Z/`, original
  proof `/private/tmp/meetless-mas-distribution-isolated-20260914T153929124Z`.
  Actual producer PASSED full clean build (including native debug/Release),
  composition, app/42 nested Mach-O signing and strict validation, Installer
  trust/purpose/signature checks and expanded payload/app inventory equality.
  Source unchanged, release keychain locked, search list restored. Durable exact
  `Meetless-1.0-1.pkg` SHA-256:
  `5e6c1636ef2340603d676078acba0ff1f1617d9ac498b39c934c65f8af0ec1d4`
  (319,830,262 bytes). Manifest SHA-256:
  `439c1c3498f420056e23ec2ec0eeb0675797ddadb99c8e4cc95f18f0ca6ceb7a`.
  Signed routing/version/endpoints/public SDK input checks pass; no legacy
  endpoint or credential file names found in the bounded bundle check. This is
  not a universal secret scan. Independent reviewer and Lead ACCEPTS #26 for
  these exact package/manifest bytes and the actual isolated producer. Reviewer
  independently verified OS trust/pkgutil, strict app/payload signatures, all 42
  Mach-O signer/CDHash/arm64 identities, sandbox/app group entitlements, signed
  config/profile/source provenance and identical payload inventory digest
  `bb3b6bad35e8f339ea9520c2e8d43f69dca822b89e32b8a8266ea90f729d6526`.
  Accepted targeted negative proof (tampered resources/unsigned package) remains
  retained. Lead rechecked durable hashes and clean exact isolated checkout.
  This acceptance is packaging/signing/provenance only.
  Prior failed proofs remain retained. No install, launch or upload performed.


- Actual Apple `altool --validate-app` rejected the retained package with errors
  90236 (ICNS 512pt@2x representation missing), 90242 (`LSApplicationCategoryType`
  missing), 90255 (payload root-only readable files), and warning 90886 (signed
  application identifier missing versus provisioning profile, blocking TestFlight).
  No upload occurred. Prior local #26 acceptance remains historical, but this
  candidate is not upload-ready. Packaging owner is correcting the actual route
  and validator with independent review; original bytes and rejection are retained.
  Category authority is owner-selected Productivity in ADR0005.


- Resumed on 2026-09-15: prior broad 65-case regression processes are gone and
  no final result was retained; their outcome is unknown, not a pass. Root ran
  distribution/development/contract/signature focused tests: 92/92 passed.
  Two targeted shared-profile evidence cases both failed because the new icon
  input binding was incorrectly required for the unchanged development fixture.
  Durable stdout/stderr/exit results are in
  `.artifacts/production-preparation/apple-submission-source-fixes/resumed-20260915/`.
  The packaging owner is correcting distribution-only input propagation while
  keeping development v1 unchanged; independent review remains pending.
  ASC Productivity was saved and observed selected; category UI evidence remains
  in `.artifacts/app-store-upload/20260914-build1/category-ui-evidence.json`.


- Store submission preparation: `docs/release/app-store-submission.md` contains
  en-US copy, proposed review flow, screenshot shot list and explicitly missing
  business/legal inputs. Root independently reviewed the revised draft and
  ACCEPTS it as preparation only; metadata/publication and live-review claims
  are not authorized by the draft. Final candidate and account readback still
  govern any later submission. No storefront copy was published.


- Independent reviewer and Lead ACCEPTS the corrected eight-file source set.
  Distribution-only input propagation preserves development v1/profile 0400;
  distribution requires ICNS, signed application/team IDs, Productivity category
  and readable profile 0444. Reviewer observed 27 distribution + 19 development
  tests pass after correction and both targeted shared-profile tests pass
  (116.49s), including rejected absent/mutated/substituted profile proof.
  Exact accepted file hashes and scope are retained in
  `resumed-20260915/source-review-acceptance.json` under the source-fixes evidence
  directory. Prior failures remain retained. No new artifact or Apple acceptance
  is inferred from these source checks; fresh isolated production build follows.


- Accepted source correction committed as `0e1018c`; draft/plan checkpoint
  committed as `41cfc34382f95dcf3b08fca74347cccb673b15be`. Root took actual
  producer execution ownership after interrupting the prior implementation
  agent to prevent duplicate builds. Fresh detached checkout:
  `/private/tmp/meetless-production-41cfc34`; pinned Paseo bundle/hash/commit and
  genuine `npm ci` succeeded with no development env copied. All 17 workspace
  links are isolated. Producer source snapshot:
  `bddb986b3026ec899d0d9efe0dabd77f3ad9e1bbaf21bc34de75f2429c89c560`.
  Actual producer evidence `.artifacts/macos-mas-distribution/20260915T003311276Z/`;
  original proof `/private/tmp/meetless-mas-distribution-isolated-20260915T003311276Z`.
  Actual full build/sign/package PASSED; source unchanged, keychain locked and
  original search list restored. Exact durable new package SHA-256:
  `b6f0fde5bf1e80c5254a80e3c0151be4f05f167d7b04bc699700bff7c50b5da7`
  (319,883,948 bytes), manifest SHA-256:
  `76b45c4aaf97d159aeb6da6aa8aba5e1f5f9303f7f57ad1a9c9865968e9fb6fc`.
  Actual submission checks pass ICNS512pt@2x, Productivity category, readable
  payload (16,177 files/2,150 directories) and signed application/team IDs.
  Independent reviewer and Lead ACCEPTS the exact copied artifact after actual
  expanded-payload/signature/profile/icon/permission/source/config checks.
  Actual Apple `altool --validate-app` exited 0 with no errors or warnings;
  pre-upload ASC API read returned HTTP 200 and an empty build list. The CLI
  build-status-by-version alternative failed locally demanding a delivery ID,
  so it is not treated as a remote status result. Evidence is retained in
  `.artifacts/app-store-upload/20260915-build1/`. Root has started the authorized
  exact-package upload, which exited 0 with no errors and delivery UUID
  `0816cc3b-8b69-4357-bf0d-32537ec34b8b`; 319,883,948 bytes transferred.
  ASC buildUploads API independently confirms the same delivery, version 1.0,
  build 1 and platform MAC_OS. At 2026-09-15T01:23:16.219Z, upload state is
  COMPLETE with empty errors/warnings and the matching build is VALID.
  Both TestFlight states are MISSING_EXPORT_COMPLIANCE, with
  usesNonExemptEncryption null. Evidence: `api-builds-processing-08.json`
  under the same upload evidence directory. Earlier empty/PROCESSING responses
  remain as history. The owned read-only altool
  status query was terminated after the direct API supplied current state;
  this did not cancel the completed upload or remote processing. No launch yet.
  Logs are retained under
  `.artifacts/production-preparation/isolated-41cfc34-setup/`.
- Independent reviewer ACCEPTS the upload/processing handoff against the exact
  prior accepted package, upload byte count/delivery UUID and final normalized
  Apple API record. Lead ACCEPTS #27 for upload, binary processing and build
  mapping only; TestFlight export compliance remains a separate open gate.
- Lead reviewed and ACCEPTS the corrected factual draft
  `docs/release/privacy-data-inventory.md` (SHA-256
  `7913f16a74b9a260369db4626279b1e0524b858d5abef3c7d33da52ddf93ec89`).
  Review corrected the Sandbox deployment fact, Ask workspace lifecycle and
  backend audio cleanup timing. This is a source inventory, not a legal
  classification or measured production retention acceptance. The content,
  support/privacy URLs and actual App Privacy declarations remain #17 work.
- Export-compliance factual review found third-party encryption in the exact
  payload: `@getpaseo/relay`, `@getpaseo/client` and `tweetnacl`; relay
  `vendor/paseo/packages/relay/src/crypto.ts` implements Curve25519 plus
  XSalsa20-Poly1305, and the client relay transport uses it. Therefore the
  candidate cannot be described as using only Apple OS encryption. This is
  an inventory finding, not an exemption ruling. Apple's current documentation
  matrix distinguishes standard third-party encryption and requires the French
  declaration for that category only when distributing in France:
  https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption
  Owner subsequently decided not to distribute in France for the first release.
  This resolves the storefront intent, not the remaining questionnaire answers.
  After inspecting the actual questionnaire, the owner explicitly approved its
  two prepared answers: standard encryption outside/in addition to Apple OS,
  and France No. The browser operator saved those exact answers. Root's
  independent API read `api-builds-after-export-owner-approval-01.json` confirms
  the same build is VALID with usesNonExemptEncryption false, internal
  READY_FOR_BETA_TESTING and external READY_FOR_BETA_SUBMISSION. Lead ACCEPTS
  the declaration/eligibility result only. No tester invite, installation,
  purchase or review submission occurred. This sets the server declaration;
  the signed artifact and Info.plist are unchanged. Before public submission,
  #17 must align actual storefront availability with the non-France decision.
  Subsequent read-only ASC UI inspection found no internal testing groups,
  Testers (0), and exact-build Groups (0)/Individual Testers (0). The header
  displays the Meetless icon; binary metadata is Validated and non-exempt
  encryption No. Eligibility is therefore established but owner installation
  access has not been arranged. Request the owner's intended Apple Account
  email before configuring its tester access or sending an invitation; the
  logged-in display name alone is insufficient. No invitation was sent.
- Website #28 was explicitly authorized as a separate Epic sub-issue, hosted on
  the owner's Cloudflare account. The owner has a domain and will configure the
  subdomain and provide the support email. Root owns `website/`, using authored
  static pages and the existing logo/design contract; the app build and root npm
  workspaces remain unchanged. Native dependency #17 blocked-by #28 is recorded.
  Cloudflare Wrangler 4.131.2 reports an authenticated OAuth session and one
  account; no credential file was read or copied. Website publication remains
  pending the actual contact/domain and complete privacy inputs. The local
  preview is served at `http://127.0.0.1:4179/`; its Codex panel open request was
  queued. Local checks pass the required routes, metadata and links/assets;
  eight HTTP checks pass including missing-route 404. Wrangler dry-run passes;
  public deployment check deliberately rejects four unresolved content markers.
  Evidence: `.artifacts/website-preparation/local-draft-evidence.json`.
  This is local draft proof, not public HTTPS or browser visual acceptance.
  A mistakenly launched repository-wide check was stopped (exit 143), with no
  tracked application source change or installation; it is not counted as a
  complete test-suite pass. Independent source/content review accepted the draft
  and requested two wording refinements, applied before integration.
  The reviewer re-accepted support SHA-256
  `8db6a1e850be7f4b17aba8df5970845abd127614a42c39fe2daf89b2dd356c33`
  and privacy SHA-256
  `0024b795ca33fccc4ff5e0db7b8bfc9006dca54563efd6e32ec4fec1d3cc98f2`.
  Lead ACCEPTS this exact local source/content draft only. #28 remains open
  until contact/privacy inputs, actual Cloudflare deployment and final-domain
  HTTPS/route evidence are complete.
  Read-only Cloudflare deployment lookup returned code 10007 for
  `meetless-website` (Worker does not exist); first deployment will create a
  new Worker, rather than update an existing application.
- Owner supplied the website origin `https://meetless.2m0r.com`, public support
  email `hoang@2m0r.com`, and the intended private Apple Account address in
  response to the TestFlight invitation question. The website
  root/support/privacy canonical URLs and contact links were updated; the
  tester email is not placed in public website assets. The owner subsequently
  supplied `Hoang Nguyen Bang` as the responsible individual. Public DNS shows Cloudflare
  nameservers for `2m0r.com` and no existing A/CNAME for the Meetless subdomain.
  No DNS mutation occurred. The recipient already has a Developer role but
  initially lacked Meetless app access. The owner explicitly approved adding
  only Meetless to that existing app scope, preserving the role and other
  apps, then sending the requested internal TestFlight invitation. The Apple
  operator owns this bounded change; no broader permissions are authorized.
  The website notice now names the individual and contact, describes current
  normalized-record retention without an automatic expiry promise, and gives
  a contact for deletion requests without inventing an automatic backend path
  or response-time commitment. No backend retention behavior was changed.

- Owner-approved ASC access and internal invitation completed: only Meetless was
  added to the existing Developer user's app access; prior role/apps retained.
  Group `Meetless Internal` (`5c7491b1-1c64-4077-abd1-2bd3e28c075b`) contains
  only build `0816cc3b-8b69-4357-bf0d-32537ec34b8b`; manual build distribution.
  Independent root API GETs all returned 200, exact build VALID, one intended
  tester matched privately, state INVITED/type EMAIL. UI shows Ready to Test.
  Lead ACCEPTS this access/invitation result; inbox delivery and installation
  are unverified. Evidence: `.artifacts/app-store-upload/20260915-build1/api-internal-group-invitation-verification.json`.
- Final website content review ACCEPT by `website_content_review`; rendered UI
  review ACCEPT by `apple_package_review` at desktop 2560×1178 and mobile 390×844.
  Three routes/navigation/anchors and all seven FAQ keyboard toggles passed;
  no horizontal overflow. Final release check passes seven files with no pending
  owner inputs; Wrangler 4.131.2 dry-run exits 0. Lead ACCEPTS the exact source
  identified in `.artifacts/website-preparation/final-source-evidence.json`
  for initial Cloudflare deployment. This does not yet prove public hosting.

- Actual first Cloudflare deployment completed from source
  `dc91fe53b7d26db875da3b5b65dccdb89cde4c86` through `npm run deploy` and
  Wrangler 4.131.2, uploading seven files to Worker `meetless-website`.
  Version `80acd7a1-3b17-462b-bb12-6ce12a5fb954` serves 100% traffic at
  `https://meetless-website.frosty-base-76ce.workers.dev`.
  Public HTTPS curl checks returned 200 and exact reviewed SHA-256 bytes for
  homepage/support/privacy plus CSS/logo/favicon; a nonexistent route returned
  the exact reviewed custom 404 with HTTP 404. Initial urllib attempt returned
  uniform 403; cause unknown, retained as failed evidence separately.
  `apple_package_review` independently opened public homepage/privacy in Chrome,
  confirmed final identity/contact and absence of access interstitials.
  Lead ACCEPTS this exact public workers.dev deployment. Evidence:
  `.artifacts/website-preparation/cloudflare-public-verification.json`;
  prior failure: `cloudflare-deployment-evidence.json`. Local release validation
  passed; no CI/hook/branch-protection enforcement claimed. Website source is
  unchanged after review/deployment. No app/backend rebuild or installation.
  Owner still needs to attach `meetless.2m0r.com` in Cloudflare Worker Settings →
  Domains & Routes → Add → Custom Domain, in the account containing that domain.
  No DNS change was made. Final-domain HTTPS verification remains open in #28,
  then URLs can be entered in #17; no App Review/public app submission occurred.

- Cloudflare account correction: the owner could not find the Worker in the
  domain account. Earlier deployment used the preexisting login's account
  `fb07a240a78ae90c2749829f40a2c484`; no domain-account match had been proved.
  That endpoint's HTTP acceptance remains bounded to its actual location, and
  is not acceptance of the requested final-domain hosting account.
  Owner reauthenticated Wrangler. Authenticated GET `/zones?name=2m0r.com`
  returned HTTP 200, active zone `c4a00099227adaee669d3a51666798dc`, account
  `6031f1f85e189c44fb3bcd150ca65920`. Evidence:
  `.artifacts/website-preparation/corrected-account-zone.json`.
  Pin this verified account in `website/wrangler.jsonc`; public asset bytes are
  unchanged. Target Worker lookup returned 10007 (absent), so this is a new
  deployment, not an overwrite. Release check and Wrangler dry-run passed.
  Old-account Worker is retained; no DNS mutation or app/backend change.

- Corrected-account deployment completed: source
  `b7477ebb0558f94a4781db2253736b9444bc97fa`, Worker `meetless-website`, version
  `38ac4662-b0c8-4d95-8a78-27fc326a5418` at
  `https://meetless-website.longmaba.workers.dev`. Wrangler deployment readback
  confirms this version serves 100% in the pinned domain account. Independent
  reviewer ACCEPTS the one-line account target and actual HTTPS homepage/privacy
  rendering. All seven root HTTP checks pass with exact source hashes, including
  missing-route HTTP 404. Lead ACCEPTS this exact deployment in the verified
  domain account. Evidence: `.artifacts/website-preparation/corrected-cloudflare-public-verification.json`.
  Public assets remain identical to the earlier reviewed source. No new hook,
  CI or branch-protection enforcement is claimed; account_id is the native
  Wrangler target configuration, not an authentication or permission change.
  Owner handoff: select Longmaba@gmail.com's Account → Workers & Pages →
  meetless-website → Settings → Domains & Routes → Add → Custom Domain →
  meetless.2m0r.com. Final-domain HTTPS remains pending; previous-account copy
  has not been deleted. #28/#17/Epic URLs and release packet are corrected.

- Owner completed custom-domain attachment. Root authenticated API readback
  confirms `meetless.2m0r.com` enabled on `meetless-website` / production in the
  accepted account/zone, previews disabled. Final HTTPS checks pass all three
  pages/assets with exact reviewed bytes and custom missing-route HTTP 404.
  Independent `apple_package_review` ACCEPTS actual final-domain browser
  navigation homepage → Support → Privacy → Overview, identity/contact, and
  absence of access interstitials. Lead ACCEPTS final-domain website #28.
  Evidence: `.artifacts/website-preparation/final-domain-verification.json` and
  `final-domain-binding.json`. Final URLs are handed to release packet/#17;
  storing those URLs in ASC is a distinct operation. Existing remote domain
  settings are mirrored in Wrangler config for later deploys; independent reviewer
  and Lead ACCEPT the exact config against native API readback. No new remote
  deployment/DNS mutation. Correct website release check and Wrangler4.131.2
  dry-run pass. An initial wrong-root invocation failed with missing script /
  workspace-root detection before deployment; this is not counted as a pass.

- ASC draft URL handoff completed by `apple_export_form`: Support/Marketing
  saved on macOS 1.0/en-US; Privacy Policy URL saved on App Privacy. Independent
  root read-only App Store Connect API checks returned HTTP 200 for version
  localizations and app-info localizations, confirming exact persisted values:
  `https://meetless.2m0r.com/support/`, `https://meetless.2m0r.com/`, and
  `https://meetless.2m0r.com/privacy/`. Lead ACCEPTS these three saved URL fields.
  Evidence: `.artifacts/app-store-upload/20260915-build1/api-website-urls-final-domain.json`.
  No App Privacy answers, pricing, availability, agreements or App Review/public
  submission changed. Website #28 closed and Project status Done; #17 remains
  open for other store/legal/runtime obligations.

- Owner explicitly authorized continuing store preparation after website/URL
  completion. Work ownership: `apple_export_form` owns factual en-US draft
  metadata save/readback; `apple_package_review` independently checks copy;
  `privacy_submission_draft` owns a review-ready App Privacy recommendation
  based on actual inventory and current Apple definitions, without submission;
  `screenshot_route` identifies a supported authentic-candidate screenshot route
  without touching the installed app/recordings. Root owns integration, owner
  questions, and subsequent evidence. No new App Review/publication permission
  is inferred; routine draft metadata preparation is authorized by this turn.
  Independent copy reviewer ACCEPTS exact subtitle/promotional/description/
  keywords against product contracts and Apple field limits. Root prepared
  `docs/release/screenshot-capture-brief.md` with original fictional meeting
  script and the five accepted UI states; independent reviewer and Lead ACCEPT
  this capture input only. No screenshot has yet been captured or accepted.
  Owner supplied the private App Review phone; it is kept only in ignored
  owner inputs and passed to the ASC operator for that destination.
  Source explorer found the exact MAS route requires LaunchServices at
  `/Applications/Meetless.app` with the canonical per-user container; copied
  bundles are rejected and no packaged runtime-root override is supported.
  Historical/fixture screenshots are not acceptable current store assets.
  A second macOS user alone does not preserve the shared installed app path.
  Owner explicitly chose this Mac and approved backing up first, then replacing
  the installed app. `testflight_capture` owns consistent backup/recovery and
  TestFlight readiness first; independent backup acceptance is required before
  installation. No reset or destructive cleanup authorized. Authentic screenshots
  remain pending actual Apple-distributed app launch and fictional-data capture.
  En-US copy was saved by `apple_export_form`; independent root API readback
  confirms subtitle/promotional/description/keywords exactly match reviewed
  blocks, and previously accepted URLs remain correct. Lead ACCEPTS these
  draft metadata fields. Evidence: `.artifacts/app-store-upload/20260915-build1/store-copy-acceptance.json`.
  Private App Review contact saved; root independent API readback confirms
  first/last name, email and phone match owner-provided inputs. Lead ACCEPTS
  these saved contact fields. Evidence `api-contact-build-preparation.json`
  contains booleans only. Operator subsequently associated exact accepted build
  `0816cc3b-8b69-4357-bf0d-32537ec34b8b` and set demoAccountRequired false because
  Meetless has no app-account sign-in (provider configuration for Ask remains
  separate). Root API `api-contact-build-post-preparation.json` verifies exact
  build VALID, contact matches, demoAccountRequired false and version state
  PREPARE_FOR_SUBMISSION. Lead ACCEPTS this draft association and factual flag;
  no App Review submission or verified Ask reviewer-flow claim.

- App Privacy preparation: `docs/release/app-privacy-draft.md` reviewed at
  SHA-256 `2a052269a0cf3b637f05b073fc90d3fe9a8ac5917ac7e2e3fe6d697f9be74595`.
  Independent reviewer required Other Diagnostic Data because hosted lifecycle/
  quota logs are off-device diagnostics; the author added it and re-review
  ACCEPTS staging seven categories, all App Functionality / Linked Yes /
  Tracking No. Lead ACCEPTS this review-ready staging proposal only, not Publish
  or unverified provider-retention claims. ASC operator owns saving draft form
  only if separate Publish remains; no App Review/publication allowed here.
- Backup producer reports verified original app plus canonical/legacy data in
  `.artifacts/macos-mas-development/update-backups/backup-EgNIyA`, manifest hash
  `2da9a03a98457d1de6345ffd6632ba9ed3c221d98a1919d1c5653d1ae23e5654`.
  App was not running and all recordings were saved before copying; backup
  acceptance is assigned to a separate reviewer before Meetless replacement.
  TestFlight client was absent; operator may install official Apple TestFlight
  first, pausing at credential or binding-terms prompts. No Meetless install
  is authorized to proceed until backup acceptance. Original synthetic audio
  (61.37 seconds) was rendered locally to an ignored file for later system-audio
  capture; it has not been played or uploaded. Screenshot data remains pending.

- Independent backup reviewer ACCEPTS exact backup manifest above. Native
  `scripts/lib/macos-package-transaction.mjs:fingerprintPath` confirmed each
  source/backup pair equal; its digest encoding differs from the producer's
  richer tree digest, so the two digest sets are not compared directly.
  Strict deep backup signature and stopped-state helper pass. Lead ACCEPTS
  this bounded backup gate; no restore rehearsal or app replacement yet.
  Separate evidence `backup-EgNIyA/independent-acceptance.json` retains the native
  digest set and constraints. Keep backups and preserve any subsequent state
  before recovery; do not use dev:mas reset.
  Official Apple TestFlight client is now installed and opens, but Meetless
  is not listed. Root ASC API still shows the intended tester INVITED; owner
  was asked to accept the original email invitation on this Mac. This is the
  current blocker to Apple-distributed installation/capture, not backup readiness.

- ASC App Privacy operator saved all seven reviewed data types. Independent
  reviewer inspected a separate Chrome tab: seven persisted cards, each App
  Functionality / Linked Yes, no tracking section, zero remaining Set Up,
  correct final Privacy URL. Publish enabled but untouched. Lead ACCEPTS
  persisted draft fields only. Evidence: `app-privacy-staging-readback.json`
  under the ignored upload evidence directory; reviewed proposal hash above
  still identifies the staged content (subsequent source status text updated).
  Named-provider evidence review remains before final Publish readiness.

- Provider review found a material omission in the preceding privacy draft:
  RevenueCat requires Purchase History to include Analytics for its dashboard
  features as well as App Functionality for receipt/entitlement processing.
  Official provider guidance was independently opened by Lead. The preceding
  App Functionality-only acceptance is superseded for this row; seven data
  types and Linked Yes / Tracking No remain unchanged. Source correction hash
  `f79fe931c8440a303d76db8fc5ca615001b669cf3ea340a01a34ae42066722a4`; ASC operator
  saved and reloaded Purchase History with both purposes, all other rows
  unchanged. Final reviewer reopened the actual Purchase History wizard and
  initially found linkage No despite summary Linked Yes. Lead rejected the
  speculative SDK-manifest explanation; operator explicitly corrected to Yes,
  saved/reloaded/reopened. Independent reviewer then confirmed both purposes,
  linkage Yes, Tracking No and preview only Linked Purchases. Lead ACCEPTS
  corrected source and actual persisted wizard/preview, not Publish.
  No Publish or App Review occurred. Evidence and provider authority are in
  `app-privacy-purpose-correction.json` under ignored upload artifacts.
  Read-only Convex Settings/Integrations inspection reached both accepted
  US East deployments but showed only the provider catalog, with no explicit
  enabled/configured destination state. This does not prove integrations are
  absent; actual integration settings remain unverified. No logs or secrets
  were read and no backend setting changed.

- Owner subsequently installed/opened the TestFlight app and reported Electron
  quitting unexpectedly. Installed inspection found the Apple-distributed
  1.0 (1) candidate at `/Applications/Meetless 2.app` (TestFlight Beta
  Distribution, CDHash `49fd58dc3f482b550dbc6eb152fa72aad2361d39`, receipt present,
  deep strict signature PASS); `/Applications/Meetless.app` still holds the
  original development 0.1.0 (1), matching the original backup CDHash.
  Three captured .ips reports refer to OLD installed nested Electron, not the
  TestFlight path, and trap in `_libsecinit_appsandbox` before main, parent
  launchd. Do not attribute those reports to the Apple-distributed candidate.
  Read-only NSWorkspace bundle-ID lookup resolves old nested Electron instead
  of MeetlessHost; root and nested Electron duplicate `com.meetless.app` in both
  installed versions. Evidence: `testflight-launch-crash/` under ignored
  upload artifacts. #14 now tracks this observed launch ambiguity.
  `testflight_capture` owns preserving the old app and exact TestFlight app,
  checking accepted backup/quiescence, putting the Apple-distributed app at
  the required canonical path, then testing explicit-path LaunchServices
  startup without recording/upload/billing. No data reset, re-signing or
  destructive cleanup. `screenshot_route` owns source diagnosis; root owns
  correction/review coordination. The invitation is no longer the blocker.

- Authorized app-path repair completed: original installed app retained at
  `backup-EgNIyA/original-installed-Meetless.app`, exact Apple-distributed app
  renamed to `/Applications/Meetless.app`, same TestFlight CDHash and strict
  signature verified, no runtime move/reset or re-signing. Explicit-path launch
  at 2026-09-15T04:49:44Z started MeetlessHost PID 45718, then exited normally
  at 04:49:48Z without runtime readiness or a new .ips. This is a second startup
  failure, distinct from the earlier old-Electron crash. System logs include
  an application-groups entitlement diagnostic; causality is not yet proven.
  Evidence: backup `path-repair-manifest.json` and ignored upload evidence
  `testflight-launch-crash/explicit-path-startup-exit.json`.
  Native startup-guard source diagnosis is assigned to `testflight_host_exit`;
  independent app-preservation/identity check to `backup_acceptance`. Packaging
  duplicate-ID correction is assigned to `screenshot_route`, including focused
  regression validation, without altering sandbox inheritance. Independent
  reviewer matched retained original to accepted backup using native fingerprint,
  checked both strict signatures and exact TestFlight identity/receipt presence.
  Lead ACCEPTS path preservation only; startup remains failed. Manifest hash
  `24eab2d4f4f95dfe0336a9ac123917f2a153c1551cf9bb7ee65d0b5989e25da`.

- One hypothesis-directed explicit-path LaunchServices retry with separate
  stdout/stderr capture confirmed the native preflight error: recorded host
  identity drifted in designated requirement. The secure existing identity
  records the approved Apple Development signer; current app is Apple
  TestFlight-signed. Existing migration allowlist omits this transition.
  Evidence: `backup-EgNIyA/path-launch-diagnostic-20260915T045500Z/open.stderr`.
  No identity or recording data was deleted/reset. A narrow trusted-update
  correction must preserve canonical path, runtime ownership and actual
  signature checks; deleting the guard/state is not an accepted workaround.
  Reviewer caught that the abstract development validation requirement uses
  leaf OU, while both the actual preserved approved binary and recorded identity
  use the exact known development leaf CN plus WWDR certificate extension.
  Lead re-read the preserved original codesign requirement and requires keeping
  that real positive input. The narrow accepted migration includes this exact
  legacy designated requirement, not arbitrary development prefixes or signers;
  current full signature/Team/app verification remains mandatory. Evidence:
  `testflight-launch-crash/approved-development-identity.json`.

- Native identity correction is reviewed at two-file diff SHA-256
  `ac0851cd7ee91fde72a92d41569766aec5c9b23f9ece2814200fdea9b8f46571`.
  Debug and release native boundary suites passed, as did release test-binary
  compilation and diff checks. Independent reviewer verified both exact
  approved development requirement forms, path/runtime/policy negatives, and
  the unchanged deep signature/Team/app verification before secure atomic
  identity publication. Lead ACCEPTS this source correction and unit/native
  proof only; the currently installed Apple build does not contain the fix.

- Duplicate Electron identity source/gate fix and ADR0006 amendment were
  independently accepted at eight-file diff SHA-256
  `1cbcfae245256733d8dcf9d84c84ff8723f1f00ded4ea7952363822e76ac991e`.
  Producer/contract tests passed 24/24, focused signed-gate positive and duplicate
  identifier negative checks passed. The complete coordinator fixture test was
  stopped at an external 60-second deadline during inventory of a 925 MB/13,772
  file fixture, before coordinator assertions; it declares a 300-second test
  timeout. This is incomplete, not a failed identity assertion or a full-suite
  pass. Owned test processes were stopped. Lead ACCEPTS source/gate correction
  for candidate preparation only. Electron's changed internal BaseBundleID and
  unchanged parent group require actual Apple-delivered runtime proof; no new
  group/profile privilege is authorized by this correction.

- The complete-policy coordinator test was rerun on committed source
  `c53e4407bd80a6ba11a7977ff1a3a2dad8e4f533` with its intended 300-second
  timeout. It passed in 123.445 seconds (one selected test passed, 68 skipped);
  full command duration 126.21 seconds. Owned test processes were absent after
  completion. Lead ACCEPTS this additional bounded coordinator proof, retaining
  the earlier premature timeout as history. Log retained in ignored upload
  evidence `testflight-launch-crash/coordinator-300s.log`.
  Build 1.0 (2) preparation is assigned to `testflight_build2` from this exact
  reviewed source in an isolated checkout, using the unchanged production/
  Sandbox targets, existing keys/profile and current app-group boundary.
  No build2 artifact, Apple validation/upload or runtime acceptance yet.

- Before build2 update, the exact Apple TestFlight 1.0 (1) installation and
  its existing secure host identity were separately snapshotted with APFS clone.
  Independent review and Lead ACCEPTS preservation only at snapshot manifest
  SHA-256 `90048585df156b42d4d205fc9e8ba9034eec2f2a618e2991089f11e999522ec3`.
  Source/snapshot app fingerprint is
  `9725a6acce9b47ccbadfda46a2d8a8479189de282acfde3436680af8f71ba591`;
  current TestFlight signature and private identity hash/mode match. The prior
  full development app/canonical/legacy runtime backups remain retained.
  No runtime reset, recopy, restore rehearsal or build2 installation occurred.
  Evidence: `backup-EgNIyA/testflight-build1-snapshot/`.

- Build2 first actual producer attempt under
  `.artifacts/macos-mas-distribution/20260915T052114Z-build2/` failed after
  native Release compilation: isolated workspace lacked its ignored
  `packages/meetless-app/node_modules` and Expo could not resolve `expo-audio`.
  No candidate package was composed or signed. Retain this failure and wrapper
  setup failures. Builder is restoring only the pinned dependency cache from
  the prior isolated build and verifying resolution inside the clean c53e440
  checkout before retrying with a fresh proof root; no source/profile/backend
  change or installed-app mutation. A lingering security process belonged to
  a completed read-only diagnostic and was stopped; no owner input is pending.

- Build2 retry actual producer passed from clean c53e440 source, snapshot
  `6692036c2ffd612e123e8e2eb22323656818bd80acfab68a7c5820bb7d2cde70`.
  Durable evidence: `.artifacts/macos-mas-distribution/20260915T052951Z-build2/`.
  Exact package SHA-256 `79b68f62687ccf515a95c91c4ca25091ca7da2f5aec09a3979dbc2977e3177ab`;
  manifest SHA-256 `be5763c823d15fe856306f3806b4680d9cf19bdbb6bb2e18e9936ba687e2ee85`.
  Independent review and Lead ACCEPTS this exact candidate for Apple validation
  and authorized internal upload only: actual installer/app/expanded-payload
  signatures, distinct outer/nested IDs, unchanged profile/group, source/native
  migration/config provenance and readable payload pass. Clean source and
  restored login-only keychain search list independently observed. Actual Apple
  validation is running; no upload or TestFlight/runtime acceptance yet.

- Builder finalized exact before/after clean source snapshot, locked the release
  keychain and restored the original login-only search list; no owned build/
  signing process remains. Actual Apple validation of the accepted build2 package
  exited 0 at 2026-09-15T05:44:07Z with no errors. Evidence is retained under
  `.artifacts/app-store-upload/20260915-build2/`. Fresh API still shows only
  build1 VALID plus a build2 AWAITING_UPLOAD validation delivery; this is not an
  uploaded build. Lead started the authorized exact-package upload after this
  validation and artifact acceptance. No build2 TestFlight/runtime proof yet.

- Exact accepted build2 upload succeeded at 2026-09-15T05:47:53Z with no
  errors; 319,878,287 bytes transferred. Delivery UUID
  `732201fb-0450-4939-a761-ff060d8e16d5`. Fresh ASC API at 05:50:06Z maps that
  delivery to macOS 1.0/build2, state PROCESSING, empty errors/warnings; build2
  is not yet in the VALID build list. Evidence `upload.*` and
  `api-builds-processing-02.json` in the build2 upload evidence directory.
  Current Chrome ASC session/internal group access verified, with only build1
  assigned; no export/group changes before build2 processing completes.

- Apple API now exposes exact build2 as VALID (same macOS 1.0 pre-release),
  but upload and beta/internal state remain PROCESSING at 06:00:54Z; Chrome UI
  still withholds build details/export/group controls. A documented official
  build PATCH attempted the same owner-approved effective encryption exemption
  as build1, after verifying app/version/VALID and current null value. Apple
  returned 403: the current API key does not allow this mutation. Fresh GET
  confirmed null unchanged. Preserve `approved-export-result.json`; no key
  privilege change or API retry is authorized/needed. Existing authenticated
  Chrome UI remains the intended route after Apple exposes controls.

- At 2026-09-15T06:04:05.820Z Apple upload state became COMPLETE, exact
  build2 remains VALID, no errors/warnings; both beta states are now
  MISSING_EXPORT_COMPLIANCE. Lead ACCEPTS upload/binary processing for this
  exact candidate only. Existing authorized Chrome operator is applying the
  unchanged approved encryption answers and existing internal-group assignment.
  Neither settings save nor TestFlight availability/launch is inferred yet.

- Chrome operator saved the same owner-approved export answers for exact
  build2 (standard encryption outside/alongside OS, France No) and assigned it
  to existing Meetless Internal. Independent API at 06:09:17–19Z confirms
  usesNonExemptEncryption false, IN_BETA_TESTING, upload COMPLETE/binary VALID,
  internal group with both builds and exactly the same intended installed tester.
  Lead ACCEPTS this distribution handoff only; `testflight_capture` is authorized
  to perform the already-approved same-Mac update after fresh quiescence and
  verify actual Apple identity/receipt before TestFlight Open. All snapshots and
  recording/runtime data must remain preserved; launch/IPC proof is pending.

- Actual Apple TestFlight build2 was installed at `/Applications/Meetless.app`
  and opened once through TestFlight. Producer observed Host online, Audio saved
  locally and meeting library; native/node/Electron tree and listener16777 live.
  Actual TestFlight CDHash `5a9a40030ff18b5c1579bc94c6ce371d1db0a1f8`,
  strict signature/receipt presence, distinct nested identity and c53e440 source
  provenance checked. Canonical recordings match accepted backup: 10 files,
  2,118,330 bytes, aggregate SHA-256
  `1f39b53ce22a8b1fede847caea39fb130ab6e5946a68ccebd16efb667c07c1a3`.
  Evidence: build2 upload `runtime-acceptance/testflight-build2-open-evidence.json`.
  Independent scoped startup/preservation review is pending, not full release
  acceptance. No recording, transcription, Ask or purchase action was exercised.
- Actual idle MeetlessHost consumed 97.8–100.6% CPU; Electron near0%. Read-only
  sample identifies concurrent registration-reaper workers repeatedly hashing
  executable bytes every250ms in `pruneDeadRegistrations`. Main runloop idle;
  this is sustained native background work, not an Electron startup crash.
  Private stack evidence in build2 upload `native-cpu/`. P1 bug #29 tracks
  remediation and blocks release #17/Epic #21. Fix design must preserve accepted
  request/identity authorization; no source change chosen yet.
  Capture operator verified idle/no product task, gracefully quit via Command-Q,
  and confirmed owned host/node/Electron/listener all stopped without force-kill
  or runtime/data reset. Keep successful Open and CPU failure as separate facts.

- #29 implementation is assigned to `testflight_host_exit` in the three
  native host/capability/test files. Lead chooses timer-only cheap liveness
  cleanup on a serial maintenance queue; full request-time identity pruning and
  registration/attestation/status/release/lease validation remain unchanged.
  Authority: ADR0003/0005 and accepted MAS UI history lines2835–2840 plus
  2863–2868, which explicitly forbids using periodic reaper results as lease
  authorization. No accepted rule requires periodic full hashing at250ms.
  No identity cache may authorize requests. Dead known owner/intermediate chains
  must still clean recursively with existing revision/race handling; live drift
  must fail the unchanged full request/lease checks. Independent design review
  and positive/negative native regression proof are required before candidate3.

- Independent review and Lead ACCEPTS only observed TestFlight2 Open, actual
  Apple identity and canonical recording preservation at final runtime evidence
  SHA-256 `943b913eecd31bc85a76ae8fb4a3ce612fa3b30df09e8f90bcac86c5b970dcd9`.
  Current secure identity matches actual Apple codesign/executable at mode0600,
  SHA-256 `41757aaed5ee403d15dd53e541995c74c05240d92c76b4c9ee99689689e3202e`;
  source/runtime/path stable across approved migration. This is state-backed
  proof, not a dedicated migration event log. Nested Electron UI was observed;
  native top-level accessibility timed out. Functional recording/transcription/
  purchase and broad app-group/IPC capability acceptance remain unproven.
  Full runtime/release acceptance is REJECTED because of #29 idle CPU.

- #29 exact three-file source correction is independently reviewed and Lead
  ACCEPTS for fresh candidate preparation at diff SHA-256
  `49982b0335ee0b4bd55495d2ec6b57397cfd63a6e27a8b9f833de6d82b43cfd7`.
  Maintenance uses only ESRCH-definite liveness on a serial utility queue;
  unknown/EPERM remain, and full request identity/lease paths are unchanged.
  Exact final debug/release native boundary suites passed under Node parent.
  Tests cover live drift rejected by full requests, recursive dead chains/runtime,
  stale snapshot/reset, events/revision and serial scheduling. An inspection race
  hook is not a hash counter; a misleading test assertion was removed before
  final reruns. Static call graph plus drift regression support source confidence,
  while actual TestFlight3 idle CPU remains the required performance proof.

- #29 correction committed and pushed as `e6b52ac8a192ac3833416f22a6b20372ac171475`.
  Actual build3 producer assigned to the prior builder from a fresh detached
  checkout, unchanged production/Sandbox/profile/group and fixed version1.0/build3.
  Current TestFlight2 app/secure identity snapshot is assigned separately before
  any update; full existing app/runtime backups must remain. No build3 artifact,
  Apple validation/upload or actual idle CPU result exists yet.

- Pre-build3 TestFlight2 snapshot independently reviewed and Lead ACCEPTS
  non-receipt app integrity, opaque APFS clone and secure derived identity only.
  Snapshot manifest SHA-256 `5ad42143db22f497dff01d44fd7990b97c87520a1f72c70bccc70745f62d30a2`.
  App fingerprint explicitly excludes opaque Apple receipt: 16,176 files,
  999,381,012 bytes, hash `9bd3aafb0241ef41aa08595f99c4fcef0ec1028056c73cc0c1f4423bbc233f55`.
  Strict signatures/source and copied secure identity match; receipt presence
  only. No receipt byte-equivalence, restore rehearsal or new migration claim.
  Earlier snapshots/full runtime backups remain intact.
- Actual build3 attempt under `20260915T065049Z-build3` failed in the native
  release protocol transport test with Broken pipe (NSPOSIXErrorDomain32).
  Retain this producer failure and the earlier wrapper keychain-filename typo;
  no app/pkg was composed or signed. Clean source remains e6b52ac, snapshot
  `0ec579edc55cb056c612ae186542257f6e4932802c1d1076f952cd1d304465a5`.
  Builder pauses retries while native author diagnoses the actual test child
  and producer environment. No test bypass, source relaxation or runtime reset.

- Controlled rerun of the same build3 release test binary under the same Node
  parent/cwd/environment passed; retain the failed producer attempt. Source
  review locates EPIPE in the deliberately unauthorized wrong-peer case: native
  server validates peer before reading, sends invalid response and closes, so
  client writing can observe EPIPE. A passing rerun alone is not timing proof.
  Lead authorizes a test-only correction scoped to that wrong-peer EPIPE or
  existing false-response outcome, with an authorized request afterward proving
  server health. Other errors and all authorized transport failures remain
  fatal; production server/auth/helper behavior is unchanged. Independent review
  and new exact debug/release proof precede a newly frozen source and retry.

- Independent reviewer and Lead ACCEPT the test-only correction at diff SHA-256
  `8859144dbe118d7408510fc8e73af229f85a92f77081b4a15ae9669d3e6f00ce`:
  only wrong-peer POSIX EPIPE is accepted alongside the existing explicit denial;
  a trigger-gated, fresh authorized follow-up must match its request ID, response
  type and empty registration state. Production transport/auth is unchanged.
  Author rebuilt Debug and Release native tests on these exact bytes; both suites
  passed under a Node parent with the producer cache/node-source environment.
  This accepts the bounded test repair and a new build3 producer attempt only;
  actual package, Apple distribution and idle CPU acceptance remain pending.

- Build3 retry source is frozen at
  `7e958c3d7586029fa77347e987e0e380b980f563`, with package-source snapshot
  `8f06259872b6919401231b7b9a530a502294260c635f28f6c2bc4e5b869f4158`.
  Fresh detached checkout `/private/tmp/meetless-production-7e958c3d-20260915T072301Z-build3`
  has all 17 workspace links inside its own root, the pinned Paseo revision and
  required ignored app dependencies. Actual producer evidence is retained in
  `.artifacts/macos-mas-distribution/20260915T072301Z-build3/`; the earlier failed
  producer attempt remains intact. This is a new attempt, not package acceptance.

Next: produce, validate and distribute build3, then verify TestFlight Open, idle
CPU and data preservation to resolve #29. Resume screenshots and #15/#16/#20
evidence after the updated app is healthy. TestFlight
and App Review purchases use the isolated Apple Sandbox route; only verified
Apple PRODUCTION transactions can establish production billing evidence.
Owner-authorized app replacement may proceed after accepted backup and fresh
stopped-state checks. Website #28 final-domain HTTPS and all three ASC URLs
are accepted; App Privacy correction/remaining metadata gates stay separate.
App Review/public release require a separate owner decision.

### Historical execution checkpoint — 2026-09-14

Owner authorized implementation of Epic #21 and selected US East and separate
Sandbox/Production backends. Root owns account/configuration discovery,
authority promotion, plan and integration. `production_contract_audit` completed
read-only code/official-provider contract audit. `apple_production_verifier`
owns the bounded missing Apple appAppleId correction/config/tests; a different
reviewer must accept its exact diff before integration. No source tag moves.

Read-only Convex discovery: existing default production `content-bulldog-967`,
project ID 2906735, region `aws-us-east-1`; no environment variables configured.
No deployment or environment mutation performed. The CLI-source import metadata
probe failed locally on missing @sentry/node; a GET through the documented
installed CLI platform route succeeded without installing dependencies.

Apple Developer sign-in is absent in inspected IAB/Chrome pages; checking
App Store Connect in IAB after owner reported using ChatGPT browser earlier.
That page also showed login. Owner deferred login because away from the machine;
Apple/RevenueCat account operations remain pending, not rejected or failed.
RevenueCat HMAC matches current official docs; actual integration config still
needs verification. Confirmed Apple SDK production constructor requires numeric
appAppleId; current source omits it. This is being corrected as a reviewed
successor, not relabeled as the frozen source. Sandbox/TestFlight routing and
background Apple reconciliation remain separate work before production acceptance.

### Earlier accepted preparation checkpoint — 2026-09-14

- Lead ACCEPTS source correction `4a293b5321ec9d2ba5a18fcdbedf54419048ba9a`
  after independent `production_verifier_review` acceptance of the exact five
  file hashes. Production config and deploy preflight require a positive safe
  integer `MEETLESS_APPLE_APP_ID`; native Apple SDK verifier receives it as the
  fifth argument. Sandbox remains compatible without that field. No fake or
  historical Apple ID was applied to a deployment.
- Worker and independent reviewer each ran the focused two-file suite: 33/33
  passed. Convex TypeScript check passed for the implementation. Actual installed
  Apple SDK reproduces the old production constructor failure and the corrected
  path reaches cryptographic rejection of a deliberately invalid JWS. This is
  local/unit confidence only; not real Apple transaction or production acceptance.
- Frozen baseline tag remains at `6b051116af4dbf8a22337f51b995e120454b79d0`.
  The source correction is an explicit successor; no artifact has been built or
  relabeled as the original frozen SHA.
- Existing production function spec is empty and no environment variables are
  configured. No cloud mutation, provider call or deployment occurred.
- Local profile `51bc0400-219e-405a-8d37-e300afd72c53` embeds Apple Distribution
  for team `63M98WD275`, bundle `com.meetless.app`, expires 2027-08-25, with no
  device list. Its existence does not prove usable signing private keys; only
  Apple Development is currently a valid keychain signing identity. MAS
  Distribution/Installer identities and current ASC catalog/version need login.
- RevenueCat IAB dashboard also showed login; current integration remains
  unverified. HMAC protocol matches current official RevenueCat documentation.

Owner approved both remaining decisions on 2026-09-14:

1. Store-testing Sandbox: 30 minutes (1,800 seconds) per allocation including
   trial, with accelerated test clocks; production remains 8 hours/month and
   trial 5 hours. Promote to product/monetization.md; no live config applied yet.
2. Background Apple reconciliation: verify Apple during authenticated RevenueCat
   delivery before successful acknowledgement; use provider retries for transient
   errors and manual recovery after retries are exhausted. Raw IDs/JWS remain
   transient. Promote to ADR0005; implementation/live evidence still pending.

Owner reports Apple App Store Connect and RevenueCat are now logged in in the
ChatGPT browser. Reinspect live access before claiming account configuration.

Next independent/blocked work: #24 native transaction paths currently accept
only sandbox; use verified app/store context to select fixed signed endpoint,
then independently verify environment at the server. Scope credential, token,
quota and upload/resume context to that backend; no cross-backend fallback or
replay. #26 must package both approved endpoints. Exact sandbox target, live Apple/RevenueCat configuration and signing inputs
remain open; sandbox allowance is now approved.
Do not start production deployment or claim #22/#23/#24 done from this checkpoint.

## Owner decisions accepted and live account inspection — 2026-09-14

- Owner approved store-testing Sandbox 1,800 seconds per allocation including trial; accelerated clocks retained, production 28,800 monthly/18,000 trial unchanged. No retroactive reset of existing periods. Source `6d9a2f6` independently accepted with 83/83 local tests and Convex typecheck; no cloud configuration applied.
- Owner approved authenticated RevenueCat delivery -> synchronous Apple verification -> normalized reconciliation before success acknowledgement, provider retry for transient failures and manual recovery after retry exhaustion. Raw IDs/JWS stay transient, never scheduler/database/log material. Source `81fc2b6` independently reviewed and accepted by Lead: SDK status lookup verifies transaction and renewal JWS; HTTP waits for atomic normalized reconciliation/receipt before ACK; transient errors return 503 for redelivery. Same-term grace survives transaction-only refresh and expires naturally. Combined 110/110 local tests and Convex TypeScript pass. Positive signature decoding uses controlled fixtures; actual SDK rejects invalid JWS. No live Apple/RevenueCat acceptance. Direct action arguments are transient at application level; hosted tracing retention is unverified. The 20-second deadline bounds response but cannot cancel SDK transport.
- Logged-in ASC UI confirms app 6807070739, bundle com.meetless.app, SKU meetless-macos-v1, macOS version 1.0 Prepare for Submission, TestFlight No Builds. Use version 1.0/build 1 for the first candidate subject to recheck immediately before upload.
- Logged-in RevenueCat UI confirms project0d7b4465/app appe0ef526253 and correct bundle. Existing IAP and ASC API credential configurations both show Valid credentials. Default offering maps `$rc_monthly` to `com.meetless.app.premium.monthly` and `$rc_annual` to `com.meetless.app.premium.annual`; `premium` entitlement lists two products. Existing active webhook targets development only, Sandbox only, HMAC enabled. These observations do not prove production billing/Apple lookup or production webhook delivery.
- Apple Developer shows existing Distribution and Mac Installer Distribution certificates expiring 2027-08-25. Imported only the existing public Distribution certificate embedded in the profile into login keychain; valid signing identities still contain Apple Development only. No new certificate created, no revocation and no trust override. Need matching privatekey (.p12) for signing and local Apple API .p8 for backend; asked owner for file locations without secret contents.
- No remote mutation, production deploy, provider call, upload or App Review/public release in this account-inspection checkpoint. #22/#23/#24 stay open.

- Deploy preflight successor `d909ca1` requires the Apple API issuer, key ID and PKCS8 private key for production/store-testing Sandbox. Independent review accepted; 47/47 focused local tests passed. This is presence/basic-shape validation, not proof the credentials work. Local validation/deploy entrypoints invoke the guard; no `.github` CI workflow exists, hook/branch-protection enforcement unverified.

### Local credential search — 2026-09-14

Owner requested parallel discovery of existing Apple keys and collection under
`keys/` with Git exclusion. Separate read-only agents found no `.p8` in the
home-directory scan outside Library or Spotlight, and no `.p12`/`.pfx` in
Downloads, Documents, Desktop, projects, CloudStorage or Mobile Documents.
The separate `.p8` cloud-directory scan timed out; that scope is incomplete.
Keychain still reports only Apple Development as a valid identity. No private
key was exported, downloaded, created or copied. `keys/` exists empty with
mode 0700; independently reviewed `/keys/` ignore covers nested and hidden
files, and no entries under it are tracked. Signing/API credential input remains
missing; this does not change the production acceptance status.

### Historical credential creation checkpoint — 2026-09-14

Owner explicitly requested sub-agents create new Apple API/signing keys through
the in-app browser or Computer Use and save under ignored `keys/`. Separate
owners prepare the backend In-App Purchase API key and Apple Distribution/Mac
Installer Distribution signing identities. Preserve existing RevenueCat keys
and certificates. Creation is in progress; no new credential usability or
production deployment acceptance is claimed until actual returned files and
Apple-issued certificates are verified. Secret contents/passwords stay local. Two local RSA-2048 private-key/CSR pairs are prepared
for Distribution and Installer under `keys/` (mode 0600, ignored; CSR signatures
and public-key matching checked). API form `Meetless Backend 2026-09-14` and
both certificate issuance forms are ready in separate agent browser sessions.
User supplied the required action-time confirmation. Agent browser sessions
became unavailable before mutation; root recovered the existing task browser
and completed creation through Apple UI without revoking existing credentials.

- New IAP API key `U48V6LU6X3`, name `Meetless Backend 2026-09-14`, issuer
  `69a6de8c-6878-47e3-e053-5b8c7c11a4d1`; downloaded to
  `keys/SubscriptionKey_U48V6LU6X3.p8`, mode 0600, local OpenSSL private-key
  validation passed. Independent review accepts the actual P-256 key structure,
  file/directory permissions, ignored/untracked status and matching metadata;
  this does not prove live Apple authentication. Public configuration metadata is local in
  `keys/apple-api-metadata.json`. Original downloaded file retained.
- Apple-issued Distribution certificate `98649LLZ7X` and Mac Installer
  Distribution `5C93WPF4YD`, team `63M98WD275`, expire 2027-09-14.
  Browser Download clicks did not yield local certificate files; navigating
  the observed Apple download link returns `net::ERR_BLOCKED_BY_CLIENT`.
  No matching public certificate was auto-imported into login keychain.
- Therefore `.p12` packaging remains incomplete: existing local keys/CSRs are
  ready, but the two issued public certificates must be downloaded through a
  working browser. Do not create replacements or revoke any certificate.
  API credential has not been configured on Convex or live-request verified.

### Historical Chrome certificate retrieval checkpoint — 2026-09-14

Owner authorized Chrome and completed Apple Developer login. Retrieved the
issued Distribution certificate into `keys/apple-distribution-2026-09-14.cer`.
Worker packaged encrypted `apple-distribution-2026-09-14.p12` and local
`.password.txt` (all 0600, ignored); certificate/private-key matching and P12
round-trip passed, wrong password rejected. Independent review and Lead accept
this Distribution bundle: Code Signing usage, issuer/team/validity, all matching
public keys and exact certificate bytes verified. Actual build signing/trust-chain
acceptance remains untested. Certificate SHA256:
`51AF1D05DE5E934BEDC1C04BD4E494A515789C231C7EB0CC966486B3E91E96B2`.
Installer Download still produced no local certificate. Chrome downloads-page
inspection was explicitly rejected by Browser URL policy; no workaround was
attempted. Existing Installer certificate `5C93WPF4YD` page retained for user
manual download. No new certificate issuance, import, revocation or deployment.

### Apple credential files completed — 2026-09-14

Owner supplied `keys/mac_installer.cer`; it matches the retained Installer
private key and CSR. Completed encrypted
`keys/mac-installer-distribution-2026-09-14.p12` and matching `.password.txt`.
Original certificate retained; all credential files mode 0600, directory 0700,
ignored by `/keys/` and untracked. Local `keys/README.txt` identifies API and
both signing bundles/password files without embedding secret values.

Installer certificate is Apple-issued `3rd Party Mac Developer Installer:
Long Le (63M98WD275)`, expires 2027-09-14 12:45:30Z. Certificate SHA256
`ecf25d31ac60a2e320ddd5f10ac4c495ce792051881cd17f0e0397980e87cf79`;
P12 SHA256 `19245998e0ee05e2a9562a1256687c01ed48329a1ea32ef281899821d05e0a45`.
Worker verified certificate/private-key/CSR and P12 round-trip matching, and
wrong-password rejection. Independent reviewer and Lead ACCEPTS the exact
Installer bundle, including Apple Installer extension, matching DER certificates,
all public keys, file permissions and ignored/untracked status. API `.p8` and Distribution
`.p12` were independently accepted at prior checkpoints. Credential-file
collection is complete; Keychain import, matching distribution provisioning,
actual packaged build signing, and live Apple API authentication remain separate
production work. No revocation, cloud configuration or deployment occurred.

### Frozen source

- Source commit: `6b051116af4dbf8a22337f51b995e120454b79d0`.
- Annotated tag: `production-baseline-2026-09-14`, pushed to origin.
- The working tree was clean when frozen; origin/main matched this exact SHA.
- This tag identifies the application/backend source baseline, not a released
  artifact or completed production acceptance. Never move or overwrite the tag.
  Any required source change must have its own reviewed successor candidate and
  explicit provenance; do not silently claim it was built from the frozen SHA.

### Preparation and remaining inputs

- [x] Verify clean source and remote SHA; publish source-baseline tag.
- [x] Inspect MAS packaging, deployment guard and available signing identities.
- [x] Owner chose US East for Convex production on 2026-09-14.
- [x] Verify actual production deployment identity and service configuration;
  both exact targets deployed and public availability checked (billing separate).
- [x] Obtain/verify Apple Distribution and Mac Installer Distribution signing
  identities plus a matching Mac App Store provisioning profile. New identities
  passed local signing; newly downloaded matching profile passed independent review.
- [x] Prepare and independently review the distribution packaging route;
  actual package production/signing validation remains below.
- [x] Verify RevenueCat's existing Apple app/catalog/credentials and actual
  HMAC configuration compatibility; register separate environment webhooks.
  Actual authenticated provider delivery and Apple verification remain untried.
- [x] Configure production allowance at 28,800 seconds per subscriber month,
  backend-only provider credentials, production Apple verification and auth.
- [ ] Build the reviewed successor of the frozen source with recorded configuration,
  validate exact bundle/package/signing provenance, then upload to App Store
  Connect and verify processing. Record build version/number before upload.
- [ ] Retain #15/#16/#20 billing, quota and recovery evidence obligations; #14
  and #17 retain their independent release obligations. Do not mark untried
  cases passed. Public release/App Review are separate from build upload.

RevenueCat automatically distinguishes Apple sandbox and production receipts;
the same Apple-app SDK key can serve both environments. Production readiness
requires actual configuration and event verification, not an SDK key toggle.
Reference: https://www.revenuecat.com/docs/guides/environment-strategies
Apple package/upload references:
https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution
https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds

Preserve the installed development app, local recordings, existing development
backend and credentials. Record production configuration separately without
secrets in git or ordinary logs. Before deploying, inspect the target's existing
state and recovery path; never repoint or reset development implicitly.
Build artifacts, production deployment, upload, and store publication have not
been performed in this preparation checkpoint. Follow ADR0005, product
monetization policy and docs/patterns/production-evidence.md for their proof.

## Current Work

2026-09-12 continuation: the owner authorized implementation starting with #9,
then continued processing of ready issues within accepted product decisions.
Root remains orchestrator; implementation and independent acceptance have
separate owners. Stop dependent work for a real blocker or an unmade product
choice; continue safe independent preparation. Existing dirty changes must be
preserved, and accepted deltas integrated separately.

### Current execution

- **#13 complete by owner scope decision — 2026-09-13:** owner authorized Ask using the
  existing ready Test and approved macOS folder selection/bookmarks to reuse
  existing coding-agent configuration. Codex reuse and Ask passed on actual MAS
  manifest `848b22f6`; the final playback correction passed on `4936c9c2`.
  Source sequence: `56e73b1` first-use selection, `2426c21` scoped folder access,
  `c923184` asynchronous chooser/correct provider config, `f4568e1` audio-end
  completion. Source is independently accepted and pushed.
  Actual proof: Cancel recovery, native Home rejection on the first candidate,
  correct grant after more than 92 seconds, normal relaunch with remembered
  access, one manual Retry completing in 21.293 seconds with a valid citation,
  chat isolation and relaunch persistence. Final artifact replays the stored
  citation and reaches Evidence played. No further question was submitted on
  that playback-only correction. Original data/audio remain unchanged; the
  app is left open on the ready Test with its answer and played evidence.
  Prior failures are retained: initial HTTP 401, false timeout feedback after
  a long chooser, real consumer rejection of `providers.codex`, and the stuck
  Playing label. Correct configuration is consumed through
  `agents.providers.codex`; regression now uses the real Paseo config reader.
  Meetless-only asynchronous status avoids the chooser RPC deadline; no vendor
  revision change was needed. No login, credential copy, whole-home grant,
  recording, purchase or Transcribe was performed.
  Product/ADR0005 authority preserves App Sandbox and app-owned data; accepted
  broad provider reuse policy remains. This implementation supports Codex only.
  Claude Keychain/separate configuration access remains unresolved, and OpenCode
  is not installed on the test machine; neither integration is claimed ready.
  Independent reviewer and Lead accept the bounded actual Ask and final playback
  results on their respective identified artifacts. The owner subsequently
  confirmed recording complete and personally verified new Ask messages survive
  quit/relaunch, then explicitly directed closing #13. The new Youtube
  transcription quota failure and outstanding quota validation remain in #19.
  This owner scope decision removes the same-candidate rerun requirement for
  closing #13; it does not claim the quota failure was fixed. See the
  [current validation record](../history/issue-13-provider-access-validation-2026-09-13.md)
  and [initial failure record](../history/issue-13-ask-validation-2026-09-13.md).

- **#7 complete:** product decisions promoted in `678c527`, independently
  accepted, pushed, issue closed and Project Done.
- **#9 complete:** source `8aadef0` plus corrections `6eaa779`; independent actual
  MAS review and Lead **ACCEPTS** exact manifest
  `6dde5d9ce4da9cf788fd91f2ba267d96ef506c75e5981890ec659e537f0a7b97`.
  Stop success, failed save, repeated Retry failure/success, duplicate suppression,
  readable details, truthful selected-recording status and persistence passed.
  Issue closed, Project Done. [Validation record](../history/issue-9-feedback-validation-2026-09-12.md)
  is committed/pushed as `0a15406`; it retains earlier failures and claim limits.
- **Preserving MAS update accepted:** `e33aa3b` adds the route; `b80cd1c` avoids
  prebuild ESM cache by probing with a fresh installed-client process. The full
  corrected build/sign/install/readiness run passed on the same `6dde...`
  artifact. Independent review and Lead ACCEPTS that bounded route. Earlier
  canceled/failed runs remain failed; no data reset or admin elevation occurred
  in the accepted update.
- **#6 accepted:** source `58d931a` and `487d277` plus exact MAS manifest
  `a3cca1f00f863ee652befbd69760d7c33fd74cef02e8f247170b0265adfc7d27`.
  Independent review and Lead ACCEPTS AC 1–8 in the monthly Sandbox scope.
  Owner purchase automatically active after 41.083 seconds with all eight
  categorical stages once; explicit Restore active after 16.047 seconds;
  relaunch active with zero new purchase/Restore dispatch. Seven recordings and
  all 29 store/audio files unchanged. No automatic Transcribe.
  [Validation record](../history/issue-6-premium-validation-2026-09-12.md)
  distinguishes focused proof, seven baseline native failures, retained earlier
  failures, source/actual artifact provenance and annual/production limits.
  Validation commit `49fe133` is pushed; issue closed and Project Done.
- **#11 complete:** owner approved 8 hours/month (28,800 seconds) for both
  paid plans; independently reviewed policy-only commit `57ca751` is pushed.
  Reviewed analysis, sources/scenarios and recorded owner decision satisfy #11
  acceptance. Lead ACCEPTS; issue closed and Project Done. Prices/trial/monthly
  allocation/no-rollover/no-reset rules remain. Production configuration and
  deployment are NOT applied; #16 explicitly owns that later acceptance.
- **#14 partially tested, awaiting owner availability:** normal second launch
  retained one host/daemon/listener and one observed window; quit/relaunch
  preserved data. Tool actions did not establish a background-to-foreground
  transition, so focus remains unproven. Reboot remains unattempted and needs
  owner timing/login. Do not fix code without an observed product failure or
  substitute relaunch for reboot. Issue stays open/Awaiting owner.
- **#10 complete:** independent reviewer and Lead ACCEPTS actual MAS manifest
  `ceef000ec9bc876dbce2cee79accc45aff628523cb40c8978a6d515832616e44`.
  Owner Monthly Sandbox + explicit same-Test Retry produced a readable local
  transcript in 9.383 seconds. Server-proven corrupt upload recovered through
  exactly one successor; one job/one charge of 23 seconds. Ordinary relaunch
  preserves transcript and eight audio files with no new upload/provider work
  or charge. Adverse-path guarantees retain their automated source/localhost
  evidence level; no actual double-click or induced network/provider failure
  is claimed. [Validation record](../history/issue-10-transcription-validation-2026-09-13.md).
- **Owner scope split after #12 validation — 2026-09-13:** owner explicitly
  closes #12 for accepted implementation and recorded evidence; remaining
  real quota validation moves to native sub-issue [#19](https://github.com/hoangnb24/meetless/issues/19),
  P2 / Todo / Later, for possible owner-led use in real situations. This is a
  scope decision, not a pass for the failed hosted attempt or signed quota UI.
  #15/#16 retain acceptance dependency on #19; preparation can continue.
  #12 is CLOSED and its Project item Done. Earlier OPEN statements below and
  in immutable validation records describe the evidence stage before this
  decision. See [owner handoff](../history/issue-12-owner-validation-handoff-2026-09-13.md).
  No P0 remains open. #13 (P1) is next; concrete preparation is in
  `.artifacts/issue13/READINESS.md` and its issue body. Owner Apple/audio/service
  actions remain pending; no new runtime or provider operation was performed.
  Updating #13 Project status/readiness returned GitHub server errors; issue
  body and this plan record the preparation, while Project fields need resync.
- **#12 core source/local validation accepted:** Lead and independent reviewer
  accept exact v3; source commit `02171f92b11a0be50bd8f5e0e8d3ef1dec0c369a`
  is pushed. Sixteen indexed source/test blobs match the frozen candidate.
  170 tests, isolated plugin/backend type builds, actual localhost Convex quota
  arbitration/settlement, and pinned compiler output/graph proof passed.
  Preflight and atomic seal use the same strict quota feedback contract; restart
  preserves a denial, while validated completed-result recovery clears stale
  quota feedback without fresh provider work. Quota-only transport renewal
  requires full old cleanup and no job; one corruption repair remains the bound
  across the entire logical lineage. Terminal jobs retain their existing TTL.
  [Core validation record](../history/issue-12-quota-core-validation-2026-09-13.md).
  This is not full #12 or production acceptance. Source ownership is released;
  no deployment, MAS update, provider call, or retention change was performed.
- **#12 local retention decision accepted — 2026-09-13:** the owner explicitly
  requires both saved MP3 and canonical WAV for every retained recording,
  including after successful transcription. They are removed only with user
  recording/meeting deletion. Policy `d41d6d5` is independently reviewed and
  pushed; this supersedes the earlier local-WAV 24-hour rule and the narrower
  quota-only proposal. Backend temporary TTL and existing job/billing rules
  remain unchanged. No new automatic rerun or transcript-overwrite flow is
  implied by retaining source audio.
  Source/local retention is independently reviewed and Lead ACCEPTS at pushed
  `560b408`: 85 tests of current candidate behavior, plugin typecheck, pinned
  compiler proof and three intended before-change failures. Scope includes retained
  handles, valid legacy metadata migration without changing WAV bytes, retained
  directory protection during sweep, and deletion via trusted recording IDs
  even when metadata is missing/corrupt. Previously deleted WAV bytes cannot be
  reconstructed from MP3. Read-only inventory found all 8 saved MP3s and 7
  canonical WAVs intact; the earlier successful Test recording already lacks
  its canonical WAV and metadata. No app update/deployment is authorized by
  source GO alone.
  `mas_update_path` owns the separately authorized preserving MAS update and
  retention-only actual proof. Signed manifest `d6988a77` installed and passed
  independent review/Lead acceptance for old audio/data preservation, seven
  valid V2→V3 migrations, new UI Record/Stop, actual quit/relaunch and installed
  client/server deletion of only the new owned recording. GUI Delete remained
  disabled for idle saved/untranscribed meetings and is not accepted.
  The bounded existing-policy correction is accepted and pushed at `61b0a83`:
  remove the broad parent `processing` guard while preserving actual active-work
  guards. 56 tests, types and actual Expo export passed. Signed follow-up
  manifest `826f9b2e` is independently reviewed and Lead ACCEPTS: actual GUI
  Delete enabled, named confirmation, Cancel preserving data, Confirm removing
  only the new meeting/audio pair and clearing selection. All old data remains
  unchanged; this closes the first run’s GUI finding. Proof
  remains limited to a new owned recording and preservation of old audio/data,
  without transcription/provider/purchase/account changes.
  Full #12 still needs hosted/backend and actual consumer validation. Hosted
  preparation remains read-only: a synthetic account is an explicit test
  dependency, and cleanup must safely cover failed-enrollment challenges,
  unregistered blobs and account-unscoped reconciliation. Existing platform
  maintenance contracts are pinned in `.artifacts/issue12/hosted-prep/`; an
  executable guarded proposal is being prepared without hosted calls.
  Cleanup correction `eaf7844` is independently reviewed, Lead ACCEPTS and
  pushed: 30 tests and backend typecheck passed. Absent uploads return before
  reconciliation; existing uploads reconcile only their trusted account, so a
  deleted fixture’s delayed callback cannot reconcile unrelated accounts.
  Backend candidate includes the shared quota source in its immutable closure;
  read-only preflight matches all 33 currently deployed modules to accepted #10.
  One guarded native development deployment and post-check passed; independent
  review and Lead ACCEPTS exact 33-module deployment identity at execution
  binding `6fcac37e`, with three intended module/map changes. Hosted behavior
  is not inferred from that identity check.
  Hosted proof is narrowed to preflight-only (2/3/4 seconds against a synthetic
  3-second period), with no audio POST/seal/provider; actual localhost proof
  separately covers concurrency/storage. Signed UI receiving a real quota
  denial remains unproven; no isolated signed-MAS auth route is established.
  One authorized hosted attempt stopped after a successful empty-delete probe
  and an uncertain challenge-creation HTTP failure: no returned challenge ID,
  session or quota denial. Two complete scoped audits observed zero rows but
  cannot establish request quiescence. Lead stopped dependent hosted execution;
  no retry or cleanup mutation followed. The journal and failed attempt are
  preserved in `.artifacts/issue12/hosted-prep/`. Local transport/status
  corrections remain future-review material, not successful hosted evidence.
  No global environment/provider or owner-account mutation is authorized.
  [Durable validation record](../history/issue-12-retention-validation-2026-09-13.md)
  is independently reviewed and pushed at `0caadd4`; full #12 remains OPEN.
- **#18 complete — development updater defect discovered during #6:** ordinary full update
  FAILED on the root-owned Apple receipt; rollback repeated recursive removal
  and failed. Separately reviewed recovery PASSED by retaining the partial app
  and installing the verified new staging under the stable lock. The original
  receipt, old app staging, backup `backup-4Hxp0H`, runtime and recordings remain
  intact. Recovery does not establish an ordinary updater pass. Correct the
  replacement/rollback route before another ordinary update; no permission
  changes, runtime reset or receipt manipulation is authorized.

The bounded #18 correction is independently accepted and pushed as `afeca3c`.
Twenty focused tests pass; actual documented `dev:mas:update -- --reuse-current`
on exact `a3cca...` passed with a real root-owned receipt in the canonical app.
The old whole app/receipt inode, seven recordings, 29 store/audio files and
runtime/lock identities were preserved. Validation record `07c1e34` is pushed;
issue closed and Project Done. Earlier full-update failure and emergency
recovery remain separate outcomes.

### #10 implementation ownership and next proof

The execution entries below through the previous accepted handoff are retained
history. Their pending actions and issue states are superseded by Current
execution above; they are not instructions to resume earlier attempts.

`issue9_impl` is sole source writer after the #18 runtime handoff, based on
HEAD `07c1e34`. `issue9_review` owns independent review. Scope is the minimal
contracts/client, plugin contribution/server/coordinator and necessary managed
polling/publication hunks, App/surface and direct tests. Preserve existing dirty
work and adopt only the relevant previously dirty feature pieces into the
reviewed HEAD candidate. No default backend/native/packaging/config changes.

Source candidate v1 (`368ad4cbedff256225411e6d63d2d3cc62d51941b9ee7e0633b634ea35cf9c1e`)
has 277 passing focused working-tree checks and passing project/app typechecks
in a separate HEAD-plus-feature extraction. Independent review requires two UI
corrections before integration: connection errors must not hide a durable ready
transcript, and Stop-to-saved must refresh the selected recording so Transcribe
appears without reopening the meeting. The writer owns both fixes and candidate
v2 proof. V1 is retained and is not accepted for integration or app update.

V2 full patch `5affd0ec78b4ac7eb6d8d2a31804314315b4dd6e97cf5a83aad5334c23014007`
fixes both findings. Independent review and Lead ACCEPTS the exact 17-file
source candidate for integration: 280/280 tests on the isolated extraction,
project/app typechecks and pinned compiler positive/negative proof pass. The
104-input server graph resolves the candidate without root Meetless source.
Fixture Metro preview could not resolve its environment; failed logs are retained
and no visual pass is claimed. Actual installed MAS UI inspection remains
mandatory before the owner test; all actual transcription, publication, ledger
and persistence gates remain open. This is source acceptance, not #10 completion.
Exact source integrated/pushed as `c1ca6ce`. `issue9_live` now owns the full
preserving `dev:mas:update` build/install and read-only actual UI inspection.
Root source/build lease is frozen during that run. No automated capture,
Transcribe/consent or provider calls are authorized; the observer is still
prepared only and awaits the owner's new recording.

Read-only locked-development metadata confirms the 14 public entrypoint kinds
and argument schemas the client uses; all return schemas are `any`, so actual
responses remain unproven. Provider mode is `real` and the `OPENAI_API_KEY` name
exists; its value was not read. No functions/provider, environment mutation or
deployment was invoked. Evidence: `.artifacts/issue10/read-only/`.

Selected-meeting saved evidence must come from its authoritative owner. The
explicit Transcribe flow enters cloud disclosure/consent, preserves meeting
context across purchase/recovery, requires another explicit Transcribe after
purchase, and never starts upload/provider work due to Stop, previous consent,
Premium or relaunch. Polling may observe/publish an already-started job, but
must not create or resubmit work implicitly. Preserve existing whole-recording
allowance and user Retry/charge semantics; do not infer new retry policy.

Source proof and an exact preserved-data MAS candidate come before the owner
cloud gate. Historical authority permits a short **owner-operated** real-provider
test on the locked development target; it does not authorize automated cloud
consent or an OpenAI request. Native capture currently enables both microphone
and system audio, so agent-generated TTS would not by itself establish a
nonprivate recording. Once the artifact is ready, the owner should create a new
short recording from a supplied nonprivate sentence and perform the first
Transcribe action. Do not use the seven existing recordings or reset consent.
Previous app-level consent may make the first Transcribe click dispatch work,
so agent UI checks must not assume that click only opens disclosure.
Production allowance/deployment remains #16 scope.

The live evidence collector is prepared, not executed, at
`.artifacts/issue10/read-only/job-metadata-query.js`. After the owner's test it
will read only the exact new job/recording and return whitelisted status,
attempt/timing fields and actual `managedCharges` count/seconds. Client settle
invocation counts do not prove charge counts. Part `requestId` is the outgoing
client request identity, not an OpenAI response request ID. No account, token,
receipt, signed URL, audio or transcript contents are included in this collector.
Independent review identified that acknowledgement cleanup can remove part rows;
sample metadata as soon as the new job ID appears, without delaying cleanup.
The backend `providerInvocationCount` increments at claim before HTTP and is
reported as claimed executions, not proof of actual provider request count.

Full preserving update completed successfully on exact manifest
`206dd2a5248d784854958d28228e92e659b029d73c19774b207a285489618edf`.
Host `99282` is running; prior host `27841` is absent. All seven recordings,
29 store/audio files, runtime/lock identities and retained protected receipts
are preserved. Shipped plugin source and generated app/contracts/client bytes
match the accepted source/actual producer; surface is bundled in the app.
Actual saved-detail UI shows enabled Transcribe and Transcript not started;
no new job-start diagnostic was observed after launch/selection. This is log
evidence, not a backend-ledger query. Evidence: `.artifacts/issue10/live/`.
Independent review and Lead ACCEPTS owner-test readiness only; #10 stays open.
Premium currently shows purchase availability; active access and its cause are
not inferred. No capture, Transcribe/consent, Premium restore/refresh, observer
or provider call was performed during this update/UI check.

Runtime/build ownership is released, with no pending operation. Root owns the next explicit
runtime GO. Unrelated dirty source/docs must not be discarded or blindly staged.

Owner test resumed on 2026-09-13 with a new saved meeting named Test (distinct
from the older Test). Its first owner-selected Transcribe reached Premium
required. One status refresh remained inactive; one ordinary Restore completed
failed after 7.891 seconds because native verification obtained no eligible
signed current entitlement. A successful StoreKit callback diagnostic means no
callback error, not active entitlement. The bounded transcription observer saw
no job and issued no metadata query; audio was not submitted. The new recording
and seven older audio files remain preserved.

A separate read-only query on the locked development target selected exactly
one consumed device/key in the observed refresh time window. Its actual App
Store adapter monthly SANDBOX projection has stored principal state expired and
expiry 2026-09-12 23:08:09 +07 (last verified 23:06:23 +07). The lineage's stored
active label has the same past expiry and does not grant access. This is time
correlation, not cryptographic host binding or a fresh Apple-status lookup; no
cause for renewal ending is inferred. Independent diagnosis accepts this
interpretation. Evidence: `.artifacts/issue10/read-only/premium-projection-result.json`
and `.artifacts/issue10/live/owner-attempt-handback.md`. No new code defect is
established. Continuing requires an owner-operated new Sandbox purchase and
verified active Premium before the owner explicitly selects Transcribe again.
No automatic purchase, entitlement override or repeated Restore is authorized.

The owner completed a new Monthly purchase: UI active at 2026-09-13 09:39:49
+07, with all eight categorical stages. The stored new Sandbox expiry was
09:41:46 +07. A later Transcribe attempt was rejected; actual UI observed at
10:23 still showed Premium active in the sidebar while the detail said Premium
required. No exact click time is available, so this is not described as an
immediate post-purchase failure. A repeated read-only projection query confirms
stored expired access. No job or audio submission occurred.

The stale sidebar is a concrete #10 UI defect separate from expiry. Under
experience.md's inactive/unverified gate authority, `issue9_impl` owns only
App.tsx and direct App tests to reflect fresh managed gate results, retain
catalog/meeting context, distinguish unavailable verification from inactive
access, and reject stale responses after a newer Premium operation. No timers,
entitlement policy, implicit refresh/purchase/Restore/Transcribe or backend
changes are introduced. `issue9_review` independently reviews the frozen delta
before integration. Actual source/build remains on c1ca6ce/206dd2 until then.

For the next owner test, prepare the observer before purchase and have the owner
purchase and immediately select Transcribe in one flow. The former 180-second
total observer window was shorter than the observed 206-second purchase flow.
`issue9_live` owns task-local observer preparation for up to 15-minute log
observation with a separate 180-second/60-query metadata bound after a job
appears. This changes only test evidence collection, not application behavior.
Observer preparation is accepted with 36 local synthetic checks, including a
late job whose final acknowledgement metadata arrives after the log deadline.
`observer.mjs` SHA-256 is `8a0e9fba3623e609c4d7da13ae6138fd7551715a9a6f24746148a7aa3522b08a`;
no runtime/backend execution of this revision has occurred.

The stale-badge correction is independently reviewed and Lead ACCEPTS exact
two-file patch `0580541719791baa9411b324ce3c8f41a93070a8b8eb3657add8c372b92bfc39`.
The old behavior fails both targeted checks; all 92 App tests on the isolated
candidate and its app/dependency typechecks pass. It is integrated/pushed as
`ee6e848`. `issue9_live` now owns a full preserving MAS update, including all
eight current recordings and the owner's new Test; shipped source is frozen
during that run. No automatic purchase, capture or Transcribe is authorized.
Old artifact 206dd2's stale badge remains failed actual evidence; the new
candidate's actual UI and all transcription end-to-end gates remain pending.

The full preserving update passed on exact new manifest
`6fee9338e5075abb696aede28031d08c37ec7f4a94d1f11af23df565e1d66fff`.
Host 77072 replaces 99282; all eight saved recordings and 33 current data/audio
files remain unchanged, as do runtime/lock identities. The prior whole app and
its root-owned receipt (inode 52520358) are retained. Accepted source and actual
generated/installed files match. Actual new Test detail is readable with
Transcribe enabled and inactive Premium shown at startup; no job-start marker
was observed. This does not claim an actual active-to-expired gate transition
on the new artifact; that branch has focused proof only so far. Evidence is in
`.artifacts/issue10/premium-gate-update/`. Runtime/build ownership is released;
independent review and Lead ACCEPTS owner-test readiness only. The 15-minute
observer started at 2026-09-13 03:46:11.563 UTC and ends log observation at
04:01:11.563 UTC, bound to the new Test only. The owner now purchases Sandbox
Monthly and immediately selects Transcribe in one flow; the agent observes
only. #10 remains In Progress / Awaiting owner, with actual end-to-end proof open.

The owner completed the one-flow test. Premium became active at 03:54:39.983
UTC; upload began 29.626 seconds later and failed after 3.274 seconds. This is
not an expiry gate. Exact recording 74f4ef97-359d-4ed4-b238-5ae00fb55378 remains
saved. The observer retained durable_start/upload_requested/upload_failed,
then ended at its 15-minute bound without a job ID or provider dispatch marker.

Separate read-only backend evidence proves one upload session with the complete
722,178-byte part registered but still uploading and unadmitted. Function-log
evidence identifies sealUpload's stored-part digest mismatch at
managedTranscriptionActions.ts:48:45. Its immutable expected descriptor is not
the digest of received bytes. V2 of the sanitized function-log summary corrects
an initial parser error that treated null as an error string; both are retained.
No raw logs, audio, credentials or receipt contents are included in evidence.

`issue9_impl` reproduced the cause with the actual stream producer and synthetic
PCM, no network: a reused Buffer view is overwritten while the upload consumer
still holds earlier chunks. Cases below the 65,536-byte PCM boundary pass;
32,769 samples and the actual 361,067-sample size fail while lengths match.
Immutable chunk ownership is independently accepted and pushed as `f1b19e7`.
The exact isolated candidate passed 31 focused tests, dependency/plugin typechecks
and pinned compiler positive/negative proof. Both stream corruption regressions
failed before the fix. Backend digest validation remains unchanged. Installed
MAS `6fee...` does not yet contain this correction.

The registered corrupt session also needs recovery: existing Retry skips its
received part and repeats seal rejection; cancel/TTL alone cannot renew the key.
Independent review and Lead accept the bounded successor-session design under
existing explicit Retry/no-double-charge authority. Only explicit Retry may
request server verification of actual registered bytes. A proven mismatch before
any timeline job can atomically create one linked successor with the same
manifest, logical identity and original expiry. Duplicate requests return that
same successor; old requests and cleanup remain isolated by session ID. Current
ownership, cancellation, expiry, verified storage references, entitlement and
absence of every existing-job state must be rechecked at commit. Preserve
mismatch evidence after cleanup. Status, polling and relaunch never repair.
Source is now independently accepted and pushed as `e4ca5c3`, exactly nine
repair-only files over accepted baseline `f1043ee` (patch SHA-256
`41f795b3f88f18f715df3fd86c7dc1240ebc5ea1b678b84ca64f212784948700`).
Lead ACCEPTS source only: 42 plugin tests, 5 localhost actual-handler repair
tests and 17 actual-handler fixture guard cases pass, plus 2 unchanged untracked
localhost transition tests as supplemental proof. Three intended negative-before
failures, scoped typechecks and pinned compiler positive/negative proof pass.
The 104-input graph binds all changed plugin producers. Localhost charging proof
uses a fake provider; hosted/OpenAI/app outcomes remain unproven.
Unchanged test harness `1955c2f` was adopted separately for clean-checkout tests;
its installed local-backend executable prerequisite remains explicit. Exact
candidate, extraction, index, HEAD and working-tree blobs were checked.
Source writer is released. Evidence: `.artifacts/issue10/transport-repair/`.

Backend baseline provenance is now accepted independently and by Lead. At
2026-09-13 04:26:15.840 UTC, read-only native source retrieval from the locked
frugal-mandrill-646 development target matched all 33 remote module hashes.
Native bundling of the frozen local source reproduced every source/source-map
byte and environment, including schema and virtual config. Initial differences
were conclusively resolved as dependency path topology and virtual config path;
no normalization or ignored mismatch remains. Evidence:
`.artifacts/issue10/backend-baseline/PROOF.md`, final parity SHA-256
`75abc63dc7ad4563cd6a4e894aa1bb1dc3b3dc6a5128903cf2b6cb4f060b4112`.
This establishes current deployed code identity, not historical deployment,
environment values, schema/data state or production acceptance.

Lead ACCEPTS the separate six-file existing-deployed baseline sync `f1043ee`,
using only independently verified frozen index blobs. The moving working tree
and every unrelated dirty file remain preserved. The repair-only delta was
integrated separately against this baseline. No backend deployment, cleanup,
provider invocation or automated Retry occurred. The owner should not Retry
until both recovery and the updated MAS are accepted. #10 remains open/In
Progress; owner-test readiness is cleared.

### #10 guarded backend update and MAS preparation

Lead and independent review ACCEPT the private backend deployment candidate:
source manifest `bf0e034dd5786abec4501f75a4b7947c29e66324c6e8e31d4368fd78730e2c87`,
guard `7b706ce00e1875ee08501f83bdde7eefac3facec453af1594c8cb2b5ffb69289`.
Native bundle comparison changes only managedTranscription.js,
managedTranscriptionActions.js and schema.js; the remaining 30 modules retain
exact source/map/environment bytes. Private backend typecheck passes. The
explicit development selector, exact source/dependency hashes and file set,
cleared inherited overrides and fresh deployed-baseline comparison are checked
before native dev --once. No environment/provider policy change is included.
Root granted one guarded execution: native CLI exit 0/ready at 04:41:43 UTC.
Separate read-only verification at 04:41:52 matched all 33 candidate module
hashes/environments; source/dependency guards still pass. Lead independently
compared the remote hashes and ACCEPTS this bounded module deployment only.
Post-proof SHA-256 `93cd7438286785782234489b8314b583d2056a72895d6a187f886153a410f812`;
see `.artifacts/issue10/backend-deploy/EXECUTION.md`. No repair or provider call
was invoked; environment/configuration values were not changed.

Rollback to the old 33-module baseline is compatible only before any repaired
successor rows exist. After an owner Retry creates linked rows, use a compatible
forward correction; never blindly restore old schema/unique lookup or delete
rows to force rollback. Deployment itself does not create successor rows.

Read-only MAS preflight found eight saved recordings with unchanged audio and
no pending work. The correct current data baseline is now 34 files, including
the failed-upload journal; the earlier 33-file pre-test count is historical.
Actual installed app remains 6fee... and still lacks both upload corrections.
After backend handback, Root granted the full preserving MAS update to
`issue9_live`; all shipped source and HEAD are frozen at `e4ca5c3` during it.
No agent Retry, purchase, consent, capture or provider call is authorized.

### #10 corrected MAS ready for the same owner Test

Full preserving update passed on exact MAS manifest
`ceef000ec9bc876dbce2cee79accc45aff628523cb40c8978a6d515832616e44`:
exit 0, eight meetings ready, new host 50903, strict installed signatures pass.
All 34 store/audio files and pending journal remain byte-identical. Reviewer
independently matched all 104 installed compiler input hashes to the accepted
candidate; Root inspected actual Test UI with saved audio and Retry available.
V2 diagnostic evidence uses current stages and proves zero new transcription
markers within the update/selection log window; legacy-marker V1 is retained.

Receipt metadata changed before backup/rename (04:50:46 vs 04:54:45/04:55:03
UTC); retained whole app inode is unchanged. No actor or earliest receipt inode
preservation is claimed. Optional external-Node installed compiler probe failed
SIGTRAP at sandbox initialization and produced no bundle; it was not retried.
Installed source/producer identity and working signed-app consumer are proven;
live in-memory compiled bundle is not captured. Both limits remain in
`.artifacts/issue10/transport-repair-update/HANDOFF.md`.

Independent review and Lead ACCEPTS owner-test readiness only; source/build
ownership is released. Root authorized the unchanged 15-minute observer with a
fresh baseline for the same Test 74f4ef97-359d-4ed4-b238-5ae00fb55378. The owner
purchases Monthly Sandbox, waits for Premium active, then immediately selects
Retry transcription without returning to chat between steps. No new recording
is needed. Actual repair/real provider/local publication/charge/persistence
remain pending; #10 is open/In Progress/Awaiting owner.

### Previous accepted handoff

Issue #8 implementation and acceptance are complete: `a558e3e` fixes MAS media
execution, and actual Retry, fresh Stop, full runtime restart, saved-state
persistence and OS playback passed independent review. Lead **ACCEPTS** issue #8
on the exact artifact recorded below. The fixed app is installed and running.
The one-time legacy session disposition is complete; original data and prior
artifacts were retained without deletion. Source `a558e3e` is pushed to main; GitHub issue #8 is closed and its Project
item is Done. #9 is Todo / Awaiting owner after its prerequisite completed.

Use the [short MAS development loop](../../macos-development.md) for ordinary
development. The issue #8 ad hoc operation is historical evidence, not a new
workflow or a reason to extend the recovery engine.

- Repository: policy, code, evidence and this current handoff.
- [GitHub Project](https://github.com/users/hoangnb24/projects/1): status,
  priorities and dependencies. The current execution above supersedes prior awaiting-selection status.
- #9 owns stale saved-audio feedback; #14 owns broader launch/reboot behavior.
- Existing unrelated working-tree changes remain outside this task.

## Outcome

Make one coherent MAS journey reliable: record → Stop → audio saved locally →
explicit Transcribe → readable local transcript → meeting-scoped Ask and cited
playback. Buying Premium updates access automatically, but never starts or
resumes transcription. Store distribution and managed-production readiness
remain distinct later acceptance gates.

## Confirmed Product Decisions

The following decisions were explicitly accepted by the owner in this
conversation on 2026-09-12. They override conflicting automatic-transcription
wording in older documents; issue #7 has promoted them into the product and
decision documents in commit `678c527`. Runtime acceptance remains issue-specific.

1. Stop saves local audio only. Premium, previous consent, relaunch, or a later
   quota reset never automatically starts transcription or upload.
2. The user selects **Transcribe** for each saved recording. Saved without a
   transcript is a normal completed state. Cloud disclosure/consent belongs to
   that explicit action.
3. Without Premium, offer purchase/restore in the recording context. After a
   successful purchase, update Premium without a manual Refresh; the user
   presses Transcribe again. No deferred transcription auto-resume is needed.
4. If the whole recording exceeds remaining managed allowance, explain this
   before upload, do not transcribe a partial recording, and retain local audio
   for a later explicit attempt when allowance is available.
5. Defer BYOK credential-entry UI for the first release. Record/save/play remain
   free; the shipped transcription UI uses Premium. Existing free Ask/citation
   policy and future free BYOK precedence are unchanged.
6. Owner approved the reviewed recommendation on 2026-09-12: 8 hours/month
   for both paid plans. Annual allocation remains monthly; existing no-rollover
   and no-reset-on-restore rules remain. Intended prices and trial 7 days/5 hours
   are unchanged. Production configuration must follow this authority; test
   allowance is not a substitute for it.

## Backlog And Dependencies

GitHub owns issue status, classification and dependencies for owner selection.
The repository remains the source of product policy, code and acceptance evidence.
This table is the migration snapshot, not a second independently maintained
progress ledger. Project Readiness is manually maintained, not automated.

| Issue | Proposed priority | Prerequisites |
| --- | --- | --- |
| [#8](https://github.com/hoangnb24/meetless/issues/8) Sửa lỗi Stop/Retry save bị spawn EPERM trên bản MAS hiện tại | P0 | — |
| [#6](https://github.com/hoangnb24/meetless/issues/6) Fix successful monthly sandbox purchase becoming failed Premium state | P0 | — |
| [#9](https://github.com/hoangnb24/meetless/issues/9) Làm rõ trạng thái lưu audio và kết quả Retry save | P0 | #8 |
| [#7](https://github.com/hoangnb24/meetless/issues/7) Chốt tài liệu V1: Stop chỉ lưu, Transcribe là thao tác riêng | P1 | — |
| [#10](https://github.com/hoangnb24/meetless/issues/10) Hoàn thiện thao tác Transcribe từ audio đã lưu đến transcript | P1 | #7, #8, #6 |
| [#11](https://github.com/hoangnb24/meetless/issues/11) Phân tích chi phí và chốt hạn mức Premium hàng tháng | P1 | — |
| [#12](https://github.com/hoangnb24/meetless/issues/12) Kiểm tra hạn mức trước upload và báo rõ khi không đủ cho recording | P1 | #7, #11, #10 |
| [#13](https://github.com/hoangnb24/meetless/issues/13) Kiểm chứng toàn bộ hành trình trên một bản MAS đã đóng gói | P1 | #9, #10 |
| [#14](https://github.com/hoangnb24/meetless/issues/14) Kiểm chứng mở lại app và second-instance handoff trong MAS | P2 | — |
| [#15](https://github.com/hoangnb24/meetless/issues/15) Hoàn tất kiểm chứng StoreKit, RevenueCat và billing cho phát hành MAS | P2 | #6, #12 |
| [#16](https://github.com/hoangnb24/meetless/issues/16) Hoàn tất cấu hình và kiểm chứng managed transcription production | P2 | #11, #12, #13, #15 |
| [#17](https://github.com/hoangnb24/meetless/issues/17) Chuẩn bị và duyệt phát hành Mac App Store | P2 | #13, #14, #15, #16 |
| [#5](https://github.com/hoangnb24/meetless/issues/5) Design the Meetless purchase presentation around Apple's system confirmation | P3 | #6 |

The owner selected and completed #8, then authorized the continuation recorded
above. #9 owns UI feedback and #6 owns Premium behavior.

## Issue #8: Accepted Result

- Source: `a558e3e`, runtime config and media-closure regression tests only.
  MAS selects the signed in-bundle tools; direct-DMG snapshots are unchanged.
- Before: the identified installed MAS app reproduced `spawn EPERM` through
  Retry with tools selected from the writable container. Three regression tests
  failed before the source fix. After: 36/36 focused tests and full build passed.
- Exact candidate manifest SHA-256:
  `368aae572b03818e0428f68305bde9be919a8efbd539251e5f2ae726b1756c65`.
  Full artifact validation, installed signatures and source/installed fingerprints
  passed. Current durable artifact is `.artifacts/macos-mas-development/current`.
- Native MAS Retry saved the original recoverable recording; fresh microphone +
  system capture Stop saved a separate readable MP3. No Retry-save button remains.
- Full owned-host stop proved absence; ordinary relaunch created a new host on
  the same runtime inode. Whole MeetingStore and both saved file hashes remained
  unchanged. Both MP3s decoded, and the new one played with macOS `afplay` after
  restart (exit 0). UI reopened the saved meeting; no transcription was requested.
- Independent reviewer and Lead accept the actual #8 completion criteria.
  This does not claim subjective audio intelligibility, citation-player behavior,
  reboot/second-instance coverage, billing or release acceptance.

### Ad Hoc Disposition Completed

The owner authorized a one-time data-preserving disposition after the legacy
coordinator became stuck. Under the stable lock and fresh absence proof, root
verified the original runtime attestation and retained a byte-checked full backup.
Exactly five legacy session records were moved together into a named retained
directory. The original package and prior current artifact were also retained.
No data, journal or identity was deleted or edited to force success.

The exact reviewed candidate replaced the old app while canonical data remained
unchanged. Ordinary native startup refreshed its identity through the existing
same-bundle/path/designated-requirement rule. No coordinator/framework code changed.
Historical launch, archive and direct-shell-probe failures remain failed evidence;
the ad hoc disposition does not retroactively make those gates pass.

Evidence and retained locations are recorded in
[the issue #8 validation record](../history/issue-8-save-validation-2026-09-12.md).
Private audio/logs stay in `.artifacts/macos-mas-development/issue-8/` and are not
uploaded. Keep backups until separate cleanup is authorized. Local validation
passed; no CI/branch-protection enforcement is claimed.

## Documentation Cleanup — Completed 2026-09-12

The accepted simple development route is now in ADR0005 and the short guide,
linked from the documentation and decision indexes. Long legacy operating steps
and obsolete execution briefs were removed from current guidance; evidence stays
in clearly marked history. This plan keeps only current decisions, results and
remaining work.

Independent review accepted the docs against actual command behavior. Local links
across eight documentation files and `git diff --check` passed; the original
historical snapshot is unchanged. Lead accepts this documentation cleanup only.
No application code, installed state, release validation or data retention
behavior changed. The later ad hoc disposition is recorded above.

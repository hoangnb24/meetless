# Meetless website — Epic #21 / issue #28

Three authored static pages: `/`, `/support/`, `/privacy/`. Source files live in
`dist/` and are tracked; there is no application build or runtime backend.
Cloudflare Workers Static Assets is the user-selected deployment route, using
the pinned Wrangler version and lockfile. No Sites-hosted project was registered:
the owner selected their own Cloudflare account and domain.

Confirmed owner inputs: final origin `https://meetless.2m0r.com`, public
support/privacy email `hoang@2m0r.com`, responsible individual `Hoang Nguyen Bang`.
On 2026-09-15, public DNS showed Cloudflare nameservers for `2m0r.com` and no
existing A/CNAME for `meetless.2m0r.com`; recheck before any future DNS mutation.

## Deployed version

Deployment target is pinned in `wrangler.jsonc` to account
`6031f1f85e189c44fb3bcd150ca65920`, verified by the authenticated Cloudflare
zone lookup for `2m0r.com` (active zone `c4a00099227adaee669d3a51666798dc`).
The owner reauthenticated before this correction. The account holding the zone
is the target, rather than whichever account a login may select by default.

Current deployment: https://meetless-website.longmaba.workers.dev
from source `b7477ebb0558f94a4781db2253736b9444bc97fa`, version
`38ac4662-b0c8-4d95-8a78-27fc326a5418`. All three routes and assets return
HTTP 200 with the reviewed source bytes; unknown route returns the custom 404.
Select **Longmaba@gmail.com's Account** in the dashboard, then Workers & Pages →
**meetless-website** for domain setup. The login email may differ from the
account name. Final `meetless.2m0r.com` attachment remains the owner handoff.

The earlier deployment at https://meetless-website.frosty-base-76ce.workers.dev
(version `80acd7a1-3b17-462b-bb12-6ce12a5fb954`, source `dc91fe5`) is in the
previous account and does not satisfy the final-domain account requirement.
Its public checks remain valid only for that endpoint. It has not been deleted;
new-account deployment and final-domain setup are recorded in the active plan.

## Local preview and validation

From `website/`: `npm ci`, then `npm run dev`. Open the URL printed by Wrangler.
`npm run check` checks entrypoints, document metadata and local links/assets.
It reports unresolved owner inputs while allowing a local preview.

The site reuses the repository logo and design tokens, using system font
fallbacks without external font requests. No analytics, cookies, form, login,
or speculative App Store download link is implemented. The privacy notice is
based on `docs/release/privacy-data-inventory.md` and the owner-provided contact
and identity. It describes current retention behavior without inventing a new
automatic deletion schedule or third-party retention promise; it does not fill
in the separate Apple App Privacy questionnaire.

## Before publishing

1. Confirm the owner-provided domain/contact/identity above. Review the exact
   policy against current code and provider documentation, including persistent
   backend records and deletion-request wording. A future product change that
   adds retention promises needs its own implementation and policy decision.
2. Ensure there are no unresolved `data-release-pending` markers. Support and
   privacy must contain the real contact. Root/support/privacy canonical URLs
   are fixed to the owner-selected origin; the 404 page remains noindex.
3. Confirm the Cloudflare account with `npx wrangler whoami`. Do not copy token
   stores or credentials into the repo. If `meetless-website` already exists,
   inspect ownership/version before deployment; never overwrite an unrelated Worker.
4. Run `npm run check:release`, then `npx wrangler deploy --dry-run`.
5. Deploy via `npm run deploy` only after exact-content review. Record the output
   version ID and workers.dev URL in the active plan and issue #28.
6. Owner configures `meetless.2m0r.com` through the Worker’s Settings → Domains &
   Routes → Add → Custom Domain. Cloudflare’s custom-domain flow creates the DNS
   record and certificate; do not invent a CNAME target. Inspect existing DNS
   first; do not delete or replace unrelated records. Verify HTTPS and all three
   routes on the final hostname. This domain must be in the deployment account;
   public nameservers alone do not establish account ownership.
7. Hand the final root, support and privacy URLs to #17. App Review submission
   remains a separate decision.

`npm run deploy` refuses unresolved content markers. This is a local release
check, not remote enforcement or CI. A direct Wrangler command can bypass it
and must not be used to publish unresolved owner inputs.

## Recovery and evidence

Keep the reviewed git commit, local validation results and Cloudflare deployment
version together. Before updating a live deployment, record the current version
for rollback using Cloudflare’s deployment controls. A first deployment has no
prior version; removing it or changing DNS requires checking its current usage.
Do not store API tokens, real meeting data or raw logs in the public directory.

## References

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Asset configuration](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Static site routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)
- [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

The website is separate from the frozen MAS candidate; no app/backend build,
signing input or installed data is changed by this directory.

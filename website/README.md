# Meetless website — Epic #21 / issue #28

Three authored static pages: `/`, `/support/`, `/privacy/`. Source files live in
`dist/` and are tracked; there is no application build or runtime backend.
Cloudflare Workers Static Assets is the user-selected deployment route, using
the pinned Wrangler version and lockfile. No Sites-hosted project was registered:
the owner selected their own Cloudflare account and domain.

## Local preview and validation

From `website/`: `npm ci`, then `npm run dev`. Open the URL printed by Wrangler.
`npm run check` checks entrypoints, document metadata and local links/assets.
It reports unresolved owner inputs while allowing a local preview.

The site reuses the repository logo and design tokens, using system font
fallbacks without external font requests. No analytics, cookies, form, login,
or speculative App Store download link is implemented. The privacy text is a
draft based on `docs/release/privacy-data-inventory.md`, not approved legal copy.

## Before publishing

1. Owner supplies final subdomain, public support email, responsible entity and
   privacy contact. Confirm effective date and approve the privacy wording,
   including persistent backend/provider/hosting retention and deletion requests.
2. Replace the visible draft notices and `data-release-pending` markers only
   after resolving their inputs. Add the real contact link on support and privacy.
   Review `noindex` metadata when the final site is ready for search engines.
3. Confirm the Cloudflare account with `npx wrangler whoami`. Do not copy token
   stores or credentials into the repo. If `meetless-website` already exists,
   inspect ownership/version before deployment; never overwrite an unrelated Worker.
4. Run `npm run check:release`, then `npx wrangler deploy --dry-run`.
5. Deploy via `npm run deploy` only after exact-content review. Record the output
   version ID and workers.dev URL in the active plan and issue #28.
6. Owner configures the chosen subdomain through the Cloudflare Worker’s custom
   domains flow. Inspect existing DNS first; do not delete or replace unrelated
   records. Verify HTTPS and all three routes on the final hostname.
7. Hand the final root, support and privacy URLs to #17. App Review submission
   remains a separate decision.

`npm run deploy` refuses the current incomplete privacy/support draft. This is
a local release check, not remote enforcement or CI. A direct Wrangler command
can bypass it and must not be used to publish unresolved owner inputs.

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

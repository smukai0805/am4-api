# AM4 production workflow

The user designated `am4-production` as the production release branch on 2026-09-06 (JST).

- Start future work from the current `am4-production` head. Do not use the old `main` or `codex/am4-homepage-v1` as the latest source.
- Implement on a separate working branch. Preserve the Notion integration, article identities, display-name/data-name distinction and spoiler preferences.
- Follow `docs/agents/release-audit.md`: relevant tests, syntax checks, diff review and browser verification for visible changes.
- Publish verified changes to `am4-production` only when release is authorized. Updates to this branch are intended to trigger Vercel production deployment and automatic domain assignment.
- Verify the resulting deployment is READY, targets production, contains the expected commit and serves am4football.com. Do not equate GitHub save or preview readiness with production success.
- Keep `am4-production` as the source of truth after each release; avoid force pushes and history rewrites.

Vercel project: am4-api (AM4 team).
Initial compact-UI release: ac872b7f73a2a3e7b18e3383f77f6ded044a5c19.
This documentation-only commit also checks the configured Git-to-production path; deployment success must be verified separately.

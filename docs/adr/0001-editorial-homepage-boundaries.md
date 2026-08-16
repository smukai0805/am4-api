# ADR 0001: Editorial homepage boundaries

## Status

Accepted.

## Decision

- The repository root `index.html` is the AM4 editorial homepage. Existing specialist pages remain available at their current paths.
- Browser code calls same-origin `/api` endpoints on Vercel. Local previews call the existing public Vercel API.
- `API_FOOTBALL_KEY` remains server-only and is never included in browser code.
- Editorial fixture previews, standings, and player media fail independently and retain clearly labelled sample fallbacks.
- The date-specific daily schedule never substitutes fictional fixtures for the selected day; it shows an explicit unavailable or empty state instead.
- Favourites use browser-local storage until account support is introduced.

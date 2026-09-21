# Vendored brand fonts

These four files are the app's brand typography, committed to the repository on
purpose. `app/layout.tsx` loads them with `next/font/local`.

## Why they are here rather than fetched

They used to be loaded with `next/font/google`, which fetches from
`fonts.googleapis.com` and `fonts.gstatic.com` **during `next build`**. That put
a live third-party network call on the critical path of every production build.

On 2026-09-21 that fetch failed mid-build and the loader threw:

```
app/layout.tsx
An error occurred in `next/font`.
TypeError: Cannot read properties of null (reading '1')
    at @next/font/dist/google/loader.js:112:78
```

CI on `master` went red, and because `.github/workflows/deploy.yml` gates on
`github.event.workflow_run.conclusion == 'success'`, the deploy job was
**skipped** — no deploy, no failure, nothing served but the previous revision.
The identical tree had built green on the PR branch minutes earlier and built
green on a re-run, so nothing was wrong with the code. The build was simply
hostage to someone else's uptime, in the one repository where a skipped deploy
is invisible by design.

Vendoring makes the build hermetic: no network, no flake, byte-identical output.
`hub/tests/no-google-font-fetch.test.ts` fails CI if a `next/font/google` import
ever returns.

## What these files are

One **variable** font per family, `latin` subset — replacing the 13 static
weights the previous config enumerated, at 125,260 bytes total.

| Family | File | Size | Fetched from |
|---|---|---|---|
| Syne | `Syne-Variable.woff2` | 34,608 B | [css2 request](https://fonts.googleapis.com/css2?family=Syne:wght@700..800&display=swap) |
| Space Grotesk | `SpaceGrotesk-Variable.woff2` | 22,288 B | [css2 request](https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=swap) |
| DM Sans | `DMSans-Variable.woff2` | 36,932 B | [css2 request](https://fonts.googleapis.com/css2?family=DM+Sans:wght@300..500&display=swap) |
| JetBrains Mono | `JetBrainsMono-Variable.woff2` | 31,432 B | [css2 request](https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..700&display=swap) |

Retrieved 2026-09-21 from the Google Fonts CSS API with a modern-browser
User-Agent (which is what makes it serve `woff2`), taking the `latin` `@font-face`
block from each response. Unicode range as served:

```
U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD
```

To refresh a file, re-request the same css2 URL, take the `latin` block's
`woff2` URL and overwrite in place. Do not switch back to `next/font/google`.

## Licensing

All four families are published under the **SIL Open Font License 1.1**, which
permits redistribution — including bundling into an application like this one.
Upstream sources and their license texts:

- **Syne** — https://github.com/bonjour-monde/fonderie-typographique/tree/master/syne
- **Space Grotesk** — https://github.com/floriankarsten/space-grotesk
- **DM Sans** — https://github.com/googlefonts/dm-fonts
- **JetBrains Mono** — https://github.com/JetBrains/JetBrainsMono

Each upstream repository carries the full OFL-1.1 text and the copyright notice
for its family; the OFL requires those accompany the fonts, and the links above
are where they live. If you vendor additional families here, add them to this
list at the same time.

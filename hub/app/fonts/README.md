# Vendored brand fonts

The app's brand typography, committed on purpose. `app/layout.tsx` loads these
with `next/font/local`. Licence and copyright notices are in `OFL.txt` beside
them.

## Why they are here rather than fetched

They used to load with `next/font/google`, which fetches from
`fonts.googleapis.com` and `fonts.gstatic.com` **during `next build`** — a live
third-party network call on the critical path of every production build.

On 2026-09-21 that fetch failed mid-build:

```
app/layout.tsx
An error occurred in `next/font`.
TypeError: Cannot read properties of null (reading '1')
    at @next/font/dist/google/loader.js:112:78
```

CI on `master` went red, and because `.github/workflows/deploy.yml` gates on
`workflow_run.conclusion == 'success'`, the deploy job was **skipped** — no
deploy, no failure, nothing but the previous revision serving. The identical
tree had built green on the PR branch minutes earlier and built green on a
re-run. Nothing was wrong with the code; the build was hostage to someone
else's uptime, in the one repository where a skipped deploy is invisible by
design.

Vendoring makes the build hermetic: no network, no flake, byte-identical
output. `hub/tests/no-google-font-fetch.test.ts` fails CI if a
`next/font/google` import ever returns.

## These are the FULL faces, not a latin subset

`next/font/google`'s `subsets` option governs **preloading**, not what it
downloads. The previous build shipped latin, latin-ext, greek, cyrillic,
cyrillic-ext and vietnamese — six subsets for JetBrains Mono alone — even though
the config said `subsets: ['latin']`.

`next/font/local` cannot express per-file `unicode-range`, so a latin-only
vendoring would have silently dropped every accented character to a system
font. The whole face ships instead: **270,316 B** for all four, against
125,260 B for latin alone. That is the right trade for not regressing "Muñoz".

| File | Size | Variable axes | Weights used | Glyphs |
|---|---|---|---|---|
| `Syne-Variable.woff2` | 60,628 B | wght 400–800 | 700–800 | 711 |
| `SpaceGrotesk-Variable.woff2` | 49,228 B | wght 300–700 | 300–700 | 1,001 |
| `DMSans-Variable.woff2` | 88,716 B | opsz 9–40, wght 100–1000 | 300–500 | 486 |
| `JetBrainsMono-Variable.woff2` | 71,744 B | wght 100–800 | 400–700 | 1,179 |

## Provenance

Retrieved 2026-09-21 from the canonical Google Fonts repository — the upstream
of the `fonts.gstatic.com` files, so these are the same outlines, unsubsetted:

```
https://raw.githubusercontent.com/google/fonts/main/ofl/<family>/<Family>[wght].ttf
https://raw.githubusercontent.com/google/fonts/main/ofl/<family>/OFL.txt
```

Families: `syne`, `spacegrotesk`, `dmsans`, `jetbrainsmono`. Each TTF was converted
to `woff2` with `fontTools` (`TTFont(src).flavor = 'woff2'`), which recompresses
the same glyph outlines — no subsetting, no reinterpolation.

To refresh: re-fetch the TTF and its `OFL.txt`, convert the same way, and
overwrite in place. Do not switch back to `next/font/google`.

## Licensing

All four families are under the **SIL Open Font License 1.1**, which permits
redistribution including bundling into an application. OFL-1.1 §2 requires the
copyright notice and licence accompany every copy — `OFL.txt` in this directory
is that copy, carrying each family's notice exactly as embedded in its own
`name` table:

- **Syne** — Copyright 2019 The Syne Project Authors (https://gitlab.com/bonjour-monde/fonderie/syne-typeface)
- **Space Grotesk Light** — Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)
- **DM Sans 9pt** — Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts)
- **JetBrains Mono** — Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

`OFL.txt` is deliberately `.txt` and not `.md`: `hub/.gcloudignore` excludes
`*.md`, so a Markdown licence would never reach the container image that serves
these files.

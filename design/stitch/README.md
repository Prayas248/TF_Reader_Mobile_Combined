# Stitch exports — drop zone

Put the Stitch output for the five screens being implemented here.

## Screenshots / image exports
Name them exactly these, any of `.png` / `.jpg` / `.webp`:

| File | Screen | RN file it maps to |
|---|---|---|
| `catalogue-home.png` | Catalogue Home | `src/screens/CatalogueScreen.tsx` |
| `shelf.png`          | Shelf listing  | `src/screens/ShelfScreen.tsx` |
| `search-results.png` | Search results | `src/screens/SearchScreen.tsx` |
| `item-detail.png`    | Item Detail    | `src/screens/ItemDetailScreen.tsx` |
| `profile.png`        | Profile        | `src/screens/ProfileScreen.tsx` |

If a screen has states worth seeing (loading, empty), add `-loading` / `-empty` suffixes.

## Code export
Stitch's HTML/CSS export goes in `code/`, keeping whatever folder shape Stitch gives you:

```
design/stitch/code/...
```

It is not used as React Native source — it is read only to lift exact values
(spacing, font sizes, gutters, shadow parameters) instead of estimating them from an image.

## Not tracked as final design
These are reference artefacts for one implementation pass. `design/DESIGN.md` remains the
spec of record; where a Stitch render and `DESIGN.md` disagree, raise it rather than
silently following either.

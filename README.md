# OBImport — Obsidian Plugin

Import an AutoCAD-exported BOM CSV into your vault as a project note plus per-component notes.

## Features

- Modal for one-shot import: type a project number, choose CSV, click Import
- Drawing number auto-derived (`<...>-GEN` → `<...>-07`; otherwise project number unchanged)
- Project note written to `Projects/<project_number>.md` (configurable folder)
- Component notes written to `Components/<Brand>/<Brand> <Model Number>.md` (configurable folder), only if missing
- Tolerant CSV parser: sniffs `,` `;` tab `|` delimiters, falls back to Windows-1252 encoding, locates header row even if title rows precede it
- Recognises common column-name variations (`No.`, `Make`, `Model`, `Manufacturer`, `Quantity`, etc.)
- Project note overwrite-on-rerun configurable; component notes are never overwritten

## Settings

- **Projects folder** — where project notes go (default `Projects`)
- **Components folder** — where per-component notes go (default `Components`)
- **Default client** — pre-fills the modal field
- **Overwrite project note on rerun** — toggle

## Install via BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community plugins
2. Open BRAT settings → "Add beta plugin"
3. Paste this repo's URL
4. Enable "OBImport" under Settings → Community plugins

## Manual install

1. Build:
   ```
   npm install
   npm run build
   ```
2. Copy `manifest.json`, `main.js`, `styles.css` into `<your-vault>/.obsidian/plugins/obimport/`
3. Reload Obsidian, enable "OBImport" under Settings → Community plugins

## Dev

```
npm install
npm run dev    # watch mode, rebuilds main.js on change
```

Symlink the repo into your vault for live iteration:

```
ln -s /path/to/obimport-obsidian-plugin /path/to/vault/.obsidian/plugins/obimport
```

Then `Ctrl+P` → "Reload app without saving" after each rebuild.

## CSV expectations

Required columns (case-insensitive, with aliases):

| Canonical | Accepted aliases |
|---|---|
| Nr. | No., No, Item, Item No., # |
| Description | Desc |
| Tag Number | Tag, Tag No. |
| Brand | Make, Manufacturer, Mfr |
| Model Number | Model, Model No., Part Number, Part No. |
| Qty | Quantity, Qnty |

Rows with an empty Model Number are skipped.

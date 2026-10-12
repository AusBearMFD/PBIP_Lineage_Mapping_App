# PBIP Lineage Explorer for VS Code

**Trace DAX measure lineage from visuals to source columns — directly in VS Code.**

Free, open-source, and privacy-first. All analysis happens locally — your files never leave your machine.

## Features

### Measure Explorer
Browse all measures grouped by table in the sidebar. Orphan measures (not used by any visual) are highlighted with a warning icon.

### CodeLens on .tmdl Files
See dependency counts and consumer counts directly above each measure definition in your `.tmdl` files. Click to trace full lineage.

### Lineage Tracing
Click any measure to see its complete dependency chain:
- DAX measure dependencies (the full chain)
- Column dependencies with source mapping
- Consuming visuals
- Source connections

### Orphan Detection
Instantly find measures that no visual references — clean up unused measures to reduce model complexity.

### Model Health Stats
View a summary of your model: tables, columns, measures, visuals, pages, sources, field parameters, and calculation groups.

## How It Works

1. Open a folder containing a PBIP project (with `.tmdl` and optionally `.pbir` files)
2. The extension automatically discovers `.Report` and `.SemanticModel` folders
3. Browse measures in the sidebar, or use the Command Palette (`Ctrl+Shift+P`)

### Commands

| Command | Description |
|---------|-------------|
| `PBIP: Trace Measure Lineage` | Select and trace a measure's full dependency chain |
| `PBIP: Find Orphan Measures` | Show all measures not referenced by any visual |
| `PBIP: Show Model Health` | View model statistics and health indicators |
| `PBIP: Refresh Lineage` | Re-scan the project and rebuild the lineage graph |

## Requirements

- A Power BI Project (PBIP) with `.tmdl` files in the workspace
- VS Code 1.85 or later

## About

Built and maintained by **Abearstudios** — a modified, customized, and enhanced version of the original open-source [PBIP Lineage Explorer](https://github.com/JonathanJihwanKim/pbip-lineage-explorer) by Jihwan Kim.

## License

MIT

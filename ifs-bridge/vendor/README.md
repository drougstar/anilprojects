# Local Excel reader

SheetJS Community Edition 0.20.3 is vendored so bank files can be decoded in a local Web Worker, including binary XLS and XLSX. Original files are not sent to a conversion service. Only transactions explicitly saved by the user enter the normal account sync.

- Official script: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
- SHA-256: `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
- License: [Apache 2.0](SHEETJS-LICENSE.txt)
- Official integration guidance: https://docs.sheetjs.com/docs/getting-started/installation/standalone/

The reader uses cached cell values. It does not execute spreadsheet formulas, macros or links.

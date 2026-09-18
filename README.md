# Term Harbor (بندرِ ترم)

A fast, offline, single-purpose web app that turns your university's exported reports
(**Report 212** PDF, **Report 102** and **Report 110** Excel) into a clean weekly
timetable — with conflict detection, a printable sheet, and one-click PNG export.

> فارسی؟ [نسخهٔ فارسی همین صفحه](README.fa.md)

[Live app](https://0antuosh0-create.github.io/course-scheduler/)

## Why

University registration portals dump three separate reports and leave you to figure
out the schedule by hand. Term Harbor merges them, shows your week as a real timetable,
flags collisions (duplicate courses, lecture overlaps, exam clashes), and produces a
clean sheet you can print, save as PDF, or share as an image.

## Features

- **Drag-and-drop upload** of the three reports (PDF + 2 Excel files)
- **Merge engine** — joins course metadata across reports, tolerates missing fields
- **Weekly calendar** — Saturday–Thursday grid, 7:00–20:00, side-by-side conflict blocks
- **Collision detection** — duplicate codes, lecture overlaps (critical), exam-hour overlaps, same-day exam warnings
- **Export** — self-contained printable sheet (A4 landscape; longer selections may span pages) and 2× PNG snapshot
- **Backup & Restore (JSON)** — export complete schedule data and selections into a JSON file, and restore back on any device
- **100% offline** — works from `index.html` opened directly, no server, no telemetry
- **Zero dependencies to install** — pdf.js, SheetJS, and the Vazirmatn font are bundled in `vendor/`

## Run it

No build step. Either:

1. Double-click `index.html`, or
2. Serve the folder: `python -m http.server 8080` → open `http://localhost:8080`

Upload Report 212 (eligible courses) and Report 102 (course catalog) to enable the
planner. Report 110 is optional and adds rooms, exam information, and notes.
Select courses, inspect conflicts, then open Export to print/save PDF or download PNG.

## Privacy

Reports are parsed locally in your browser and are not uploaded. The hosted site
downloads its static assets from GitHub Pages; the downloaded folder works offline.
Parsed course data and selections are stored in browser local storage. Use Reset
to clear the saved plan, especially on shared computers. Personal source reports
are excluded from this repository.

## How the PDF parsing works

Report 212 embeds Persian text in **visual order** (right-to-left glyph runs with
digits stored left-to-right), which naively extracted text renders scrambled.
Term Harbor reconstructs logical word order: glyph runs are sorted by x-coordinate,
assembled into words by measured gaps, reversed per-run, and re-ordered into RTL
word sequence — with digit runs preserved so course codes survive.

## Project layout

```
course-scheduler/
├── index.html      # single-page UI
├── styles.css      # design system (paper/ink palette, RTL-first)
├── app.js          # parsers, merge engine, calendar, collisions, exports
└── vendor/
    ├── pdf.min.js / pdf.worker.min.js   # pdf.js (Apache-2.0)
    ├── xlsx.full.min.js                 # SheetJS CE (Apache-2.0)
    └── Vazirmatn-wght.woff2             # Vazirmatn font (OFL-1.1)
```

## License

Bundled pdf.js and SheetJS CE retain their Apache-2.0 notices; Vazirmatn uses
OFL-1.1. No separate license for the application code has been supplied.

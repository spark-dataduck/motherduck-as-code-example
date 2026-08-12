# gdrive-sheets-sync

Walks Google Drive folder trees, expands every tab of every native Google
Sheet it finds, and loads each tab into MotherDuck as
`<TARGET_DATABASE>.<folder_path>.<file>_<tab>` with `CREATE OR REPLACE TABLE`.
Configuration, scheduling, and the secret it uses are declared in the root
`manifest.json`; the config keys themselves are documented in the docstring at
the top of `flight.py`.

## Change detection: what runs every time, and what only runs on change

Flights bill by the second of runner time, plus Duckling compute while
loading, so this flight detects "nothing changed" and exits early rather than
re-loading data it already has (`SKIP_UNCHANGED`, default `true`). The
boundary is **metadata vs. data**: every run still lists all sheets'
metadata, but only changed files have their contents read and loaded. There
is no "read everything and skip the write" — for an unchanged file the cell
data is never fetched at all, because the read and the write are one
statement (`CREATE OR REPLACE TABLE … AS SELECT * FROM read_gsheet(…)`) that
only runs for files that passed the change check.

Order of operations per run:

1. **Walk Drive** — `files.list` per folder, unconditionally. Each file's
   `modifiedTime` comes back in these same responses, so change detection
   adds zero API calls here.
2. **Enumerate tabs** — one `spreadsheets.get` per spreadsheet, also
   unconditionally, even for unchanged files. Metadata only: tab titles, no
   cell data.
3. **Connect to MotherDuck and partition the plan.** Read the watermark
   table, then split the plan: changed files, new files, files whose target
   table went missing, and files with a failed tab last run go to the load
   list; everything else is skipped.
4. **Load only the changed files.** This is the only phase that touches
   sheet contents, and the only data-heavy phase. If the load list is empty,
   the run ends here — before the gsheets extension is installed and before
   the Drive credentials ever reach the query path.

Step 2 is deliberately *not* skipped for unchanged files: collision
detection (two sheets resolving to the same table name must abort, even if
one of them didn't change today) and the orphan warning (tables in
MotherDuck that no longer correspond to any sheet) both compare against the
complete expected table list, not just the changed slice. Skipping tab
enumeration for unchanged files would make both checks blind.

The trade is the right one: what stays unconditional is one lightweight
metadata call per file plus the folder walk — seconds of runner time. What
gets skipped is the expensive part — pulling every tab's cell data through
`read_gsheet` and rewriting tables on the Duckling. A no-change run's cost
stays flat no matter how large the sheets grow; it only grows, slowly, with
the *number* of files. (Measured on the demo corpus of 25 files / 29 tabs: a
full load ran 94s, the no-change run right after it 30s — and roughly 20s of
any run is the Python environment setup no flight code can avoid.)

## Where the watermark lives

`<TARGET_DATABASE>.main.gsheets_sync_state`, one row per spreadsheet file,
alongside the existing `gsheets_sync_log`:

| column | meaning |
| --- | --- |
| `file_id` | the Drive file ID — the lookup key |
| `source_file` | human-readable path, e.g. `Finance/Invoices/2026 Q3` |
| `modified_time` | the Drive `modifiedTime` at the last fully-successful load |
| `synced_at` | when the flight recorded it |

```sql
SELECT source_file, modified_time, synced_at
FROM google_drive.main.gsheets_sync_state
ORDER BY modified_time DESC;
```

Flight runs are stateless between executions, so the watermark has to live
somewhere durable — and a table in the database the flight already writes to
needs no extra infrastructure.

## Failure modes lean safe

Change detection may only ever cause a **redundant reload, never a missed
update**:

- A file's watermark advances only when **every** tab of that file loaded.
  Any failed tab deletes the row, so the whole file retries next run rather
  than being trusted as half-loaded.
- A target table dropped in MotherDuck forces that tab to reload even though
  the sheet never changed — repairing the drop does not require touching the
  sheet.
- A file with no readable `modifiedTime` always loads.
- Rows for files that vanish from Drive are pruned; their tables stay (the
  orphan warning covers those — names are the key, so a Drive rename creates
  a new table and strands the old one).
- `SKIP_UNCHANGED=false` restores the unconditional full reload.

The partitioning and watermark-advancement rules are pure functions
(`plan_loads`, `watermark_updates`) covered by `tests/test_change_detection.py`.

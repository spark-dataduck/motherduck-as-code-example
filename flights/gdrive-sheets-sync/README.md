# gdrive-sheets-sync

Walks Google Drive folder trees, expands every tab of every native Google
Sheet it finds, and loads each tab into MotherDuck as
`<TARGET_DATABASE>.<folder_path>.<file>_<tab>` with `CREATE OR REPLACE TABLE`.
Configuration, scheduling, and the secret it uses are declared in the root
`manifest.json`; the config keys themselves are documented in the docstring at
the top of `flight.py`.

## The credential: a service account key, not an API key

A Google [API key](https://cloud.google.com/docs/authentication/api-keys)
identifies a project; it can read public data but never a private Drive
folder. An unattended job reading private Drive and Sheets data needs a
[service account](https://cloud.google.com/iam/docs/service-account-overview)
and its JSON key. The service account sees exactly the folders shared with it
and nothing else, so access is granted and revoked from Drive's Share dialog.

The same key is used twice in a run:

| Step | Uses the key through | Where |
| --- | --- | --- |
| Walk folders, list tabs (metadata) | Python `google-auth`, read-only [scopes](https://developers.google.com/identity/protocols/oauth2/scopes) `drive.readonly` + `spreadsheets.readonly` | `main()`, `service_account.Credentials` |
| Read cell data into tables | the DuckDB [`gsheets` community extension](https://duckdb.org/community_extensions/extensions/gsheets) ([docs](https://duckdb-gsheets.com/)): a `TYPE gsheet, PROVIDER key_file` secret, then `read_gsheet()` | `main()`, `CREATE OR REPLACE SECRET gsheet_auth` |

`CREATE SECRET` has no parameter-binding form, so the private key passes
through the query text and may appear in query history. It only happens on
runs that actually load something.

## What you need on the Google side

1. **A GCP project** ([create one](https://console.cloud.google.com/projectcreate)
   or reuse an existing one) with two APIs enabled:
   [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   and [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com).
   A missing one fails the run with a 403 saying the API "has not been used in
   project …".

2. **A service account** ([console](https://console.cloud.google.com/iam-admin/serviceaccounts),
   [docs](https://cloud.google.com/iam/docs/service-accounts-create)). Grant it
   **no IAM roles**: its Drive access comes from sharing, not IAM. Note its
   email, `<name>@<project>.iam.gserviceaccount.com`.

3. **A JSON key** for it: service account → Keys → Add key → Create new key →
   JSON ([docs](https://cloud.google.com/iam/docs/keys-create-delete)). If the
   option is blocked, the organization enforces the
   [`iam.disableServiceAccountKeyCreation`](https://cloud.google.com/resource-manager/docs/organization-policy/restricting-service-accounts#disable_service_account_key_creation)
   policy and a GCP org admin must exempt this project. Check this before a
   working session; it is the most common blocker.

4. **Share each source folder** with the service account email as **Viewer**,
   the same way you would share with a person. For a Shared Drive, add the
   service account as a member. If Workspace restricts sharing outside the
   domain, sharing with a `gserviceaccount.com` address may be refused until a
   Workspace admin allows it
   ([external sharing](https://support.google.com/a/answer/60781),
   [per-shared-drive policies](https://support.google.com/a/answer/7337635)).
   Service accounts have no Drive storage quota, which is why the code always
   passes `supportsAllDrives`.

5. **Copy the folder ID** from its URL —
   `https://drive.google.com/drive/folders/<FOLDER_ID>` — into
   `ROOT_FOLDER_IDS`. Only native Google Sheets load; an uploaded `.xlsx` or
   `.csv` is skipped with a warning until converted (File → Save as Google
   Sheets).

## What you need on the MotherDuck side

1. **A Flight secret holding the key** ([`CREATE SECRET`](https://motherduck.com/docs/sql-reference/motherduck-sql-reference/create-secret/)),
   created once by hand and never committed:

   ```sql
   CREATE SECRET gsheets IN MOTHERDUCK (
     TYPE FLIGHTS,
     PARAMS MAP { 'SERVICE_ACCOUNT_JSON': '<entire contents of the .json key file>' }
   );
   ```

   Paste the file as-is; leave the `\n` sequences in `private_key` alone, since
   `json.loads` decodes them. The runtime injects it as
   `gsheets_SERVICE_ACCOUNT_JSON` (`<secret_name>_<KEY>`, case preserved), and
   `flight.py` reads that exact name — a secret named anything other than
   `gsheets` needs the matching change in `main()`. Never put the key in
   `config`, which is stored in plain text.

2. **The Flight, with the secret attached.** In this repo that is the
   `gdrive-sheets-sync` entry in `manifest.json` (`"secrets": ["gsheets"]`),
   applied by CI. Outside the repo, the equivalent from the DuckDB CLI in the
   repo root (`read_text` reads local files):

   ```sql
   SET VARIABLE source_code      = (SELECT content FROM read_text('flights/gdrive-sheets-sync/flight.py'));
   SET VARIABLE requirements_txt = (SELECT content FROM read_text('flights/gdrive-sheets-sync/requirements.txt'));
   FROM MD_CREATE_FLIGHT(
     name                => 'gdrive-sheets-sync',
     source_code         => getvariable('source_code'),
     requirements_txt    => getvariable('requirements_txt'),
     config              => MAP { 'ROOT_FOLDER_IDS': '["<FOLDER_ID>"]',
                                  'TARGET_DATABASE': 'google_drive',
                                  'DISCOVER_ONLY':   'true' },
     flight_secret_names => ['gsheets']
   );
   ```

3. **A first run with `DISCOVER_ONLY=true`.** It walks Drive, lists every tab,
   and prints each planned `google_drive.<folder>.<file>_<tab>` without
   connecting to MotherDuck, so it proves the key, the APIs, and the sharing
   before anything is written. Then set `DISCOVER_ONLY` to `false` and run
   again:

   ```sql
   SELECT flight_id, flight_name FROM MD_LIST_FLIGHTS();
   FROM MD_RUN_FLIGHT(flight_id => '<flight_id>'::UUID);
   FROM google_drive.main.gsheets_sync_log ORDER BY finished_at DESC;
   ```

   See [Flights](https://motherduck.com/docs/concepts/flights/) and
   [explaining Flight runs](https://motherduck.com/docs/key-tasks/flights/observability/explain-flight-runs/).

**Rotating the key:** create a new key, `CREATE OR REPLACE SECRET gsheets …`,
then delete the old key in GCP. No code changes.

### First-run errors

| Message in the run log | Cause |
| --- | --- |
| `gsheets_SERVICE_ACCOUNT_JSON is missing` | secret not attached, or named something other than `gsheets` |
| `root folder X is unreadable … is it shared with <email>?` | the folder is not shared with that service account email |
| `X is not a folder` | a spreadsheet ID was pasted into `ROOT_FOLDER_IDS` |
| `… is not a native Google Sheet; skipped` | an uploaded `.xlsx`/`.csv`; convert it to a Google Sheet |
| 403 "has not been used in project" | the Drive or Sheets API is not enabled |

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

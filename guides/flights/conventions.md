# Flight conventions

How Flights are written, configured, and operated in this account. Filed under
the reserved `flights` topic, so agents building or debugging a Flight find it
without loading the rest of the catalog.

## Rules

- **Flights are deployed from Git, never edited in the UI.** Source lives in
  `flights/<name>/flight.py`; the next `./deploy.sh` overwrites anything edited
  in place.
- **Writes must be idempotent.** Use `CREATE OR REPLACE TABLE`, not `INSERT`. A
  Flight can be re-run at any time — on a schedule, on deploy, or by hand — and
  a re-run must not double-count.
- **Configuration comes from the `config` map, not from the source.** Each entry
  is surfaced as an environment variable of the same name. Use UPPERCASE keys so
  there is no ambiguity about case conversion.
- **Never put a secret in `config` or in the source.** `config` is non-sensitive
  key-value only; use Flight secrets for anything else.
- **Connect with `duckdb.connect("md:")`.** The runtime injects
  `MOTHERDUCK_TOKEN`; do not build a connection string with a token in it.
- **A Flight writes to `agent_commerce_marts`, never to `agent_commerce`.** The
  source database is a read-only share.
- **A Flight is one file.** `MD_CREATE_FLIGHT.source_code` takes a single-file
  program capped at 200 KB, so there are no helper modules. Pure logic lives in
  `flight.py` and tests import it by path via `importlib`.
- **Secrets are referenced by name, never committed.** A manifest entry's
  `secrets` array becomes `flight_secret_names`. Each key in the secret's
  `PARAMS` map arrives as an environment variable twice: namespaced as
  `<secret_name>_<KEY>` — case preserved, not upper-cased — and again under
  its bare `<KEY>`. Prefer the namespaced form, as `gdrive-sheets-sync` does
  with `gsheets_SERVICE_ACCOUNT_JSON`: bare names can collide between two
  attached secrets or with a `config` key. Create the secret once by hand
  (`CREATE SECRET gsheets IN MOTHERDUCK (TYPE FLIGHTS, PARAMS MAP
  { 'SERVICE_ACCOUNT_JSON': '…' })`); the repo only names it.
- **`run_on_deploy: false` deploys a Flight without running it.** Default is
  `true`, which is right for `agent-commerce-monthly-rollup` because a Dive
  depends on the database it creates. Set it `false` when a Flight calls an
  external API whose credentials CI may not have — a failed run would
  otherwise fail the whole deploy.
- **`schedule_cron` and `secrets` are declared, not reconciled.**
  `MD_UPDATE_FLIGHT` is a PATCH — omitting an argument leaves the stored value
  untouched. So a schedule added by hand in the UI, or a `schedule_cron`
  removed from a manifest entry, will *not* be noticed by the next deploy,
  unlike a Dive's `status`. Correct reconciliation needs a read-modify-write:
  read the current schedule from `MD_LIST_FLIGHTS()` and send
  `schedule_cron := ''` only when a schedule actually exists, because
  blanking a Flight that has none returns an error. This hole is deliberately
  open — close it with intent.

## Shape of a Flight

```python
import os
import duckdb

def main() -> None:
    share_url = os.environ["SOURCE_SHARE_URL"]      # from config
    target_db = os.environ.get("TARGET_DATABASE", "agent_commerce_marts")

    con = duckdb.connect("md:")
    con.execute(f"ATTACH IF NOT EXISTS '{share_url}' AS source_data")
    con.execute(f"CREATE DATABASE IF NOT EXISTS {target_db}")
    con.execute(f"CREATE OR REPLACE TABLE {target_db}.main.my_rollup AS SELECT ...")

if __name__ == "__main__":
    main()
```

## Operating them

Run status values carry a `RUN_STATUS_` prefix. Comparing against a bare
`SUCCEEDED` is valid code that never matches, so a wait loop written that way
hangs until it times out and then reports failure on a run that succeeded.

```sql
-- Inventory
FROM MD_LIST_FLIGHTS();          -- returns flight_id / flight_name, NOT id / name

-- Run history for one Flight
SELECT run_number, status, created_at, exit_code
FROM MD_LIST_FLIGHT_RUNS(flight_id := '<uuid>')
ORDER BY run_number DESC;

-- Root-cause a failure
SELECT logs FROM MD_GET_FLIGHT_LOGS(flight_id := '<uuid>', run_number := 10);
```

## Two limits to plan around

- **`MD_LIST_FLIGHT_RUNS` accepts only literal arguments.** A lateral join over
  `MD_LIST_FLIGHTS()` is rejected with *"only supports literals as parameters"*,
  so SQL alone cannot fan out across every Flight. Either `UNION ALL BY NAME` a
  branch per flight id, or build that union in the client.
- **Flight SQL functions are scoped to the calling identity.** You see the
  Flights your own user or service account owns. An org admin does not
  automatically see everyone's, so account-wide Flight inventory is not
  available from these functions.

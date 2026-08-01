#!/usr/bin/env bash
#
# Deploy every artifact in manifest.json to MotherDuck.
#
#   ./deploy.sh --dry-run    print what would change, mutate nothing
#   ./deploy.sh              apply
#
# Requires MOTHERDUCK_TOKEN in the environment. There is no state file: whether
# an artifact already exists is answered by a live MD_LIST_* lookup every run.

set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

MANIFEST="${MANIFEST:-manifest.json}"

# Scratch file for the Dive source with REQUIRED_DATABASES stripped out.
# Declared at top level (not as a function local) so the EXIT trap can see it
# under `set -u` — a RETURN trap fires after bash discards the function's locals.
DIVE_TMP="dive.stripped.tmp.tsx"
trap 'rm -f "$DIVE_TMP"' EXIT

command -v duckdb >/dev/null || { echo "duckdb CLI not found" >&2; exit 1; }
command -v jq     >/dev/null || { echo "jq not found" >&2; exit 1; }
: "${MOTHERDUCK_TOKEN:?MOTHERDUCK_TOKEN must be set}"

# Run SQL and return a bare value (empty when there are no rows).
sql1() { duckdb "md:" -csv -noheader -c "$1"; }

# --- identity lookups -------------------------------------------------------
# Each artifact type is keyed on a human-readable name, not a stored ID.
# NOTE: MD_LIST_FLIGHTS returns flight_id/flight_name, not id/name.
lookup_flight() { sql1 "SELECT flight_id FROM MD_LIST_FLIGHTS() WHERE flight_name = '$1';"; }
lookup_dive()   { sql1 "SELECT id FROM MD_LIST_DIVES()   WHERE title = '$1';"; }
lookup_guide()  { sql1 "SELECT id FROM MD_LIST_GUIDES()  WHERE title = '$1' AND coalesce(topic, '') = '$2';"; }

# Two artifacts with the same key means we cannot tell which to update.
# Fail loudly rather than guess or silently create a third.
require_single() {
  local count
  count=$(printf '%s' "$1" | grep -c . || true)
  if (( count > 1 )); then
    echo "ERROR: '$2' matches ${count} existing artifacts. Refusing to guess which to update." >&2
    echo "       Delete the duplicates in the MotherDuck UI, then re-run." >&2
    exit 1
  fi
}

action_for() { [[ -n "$1" ]] && echo update || echo create; }
plan_line()  { printf '%-8s %-14s %s\n' "$1" "$2" "$3"; }

# --- plan -------------------------------------------------------------------
plan() {
  local name title topic id
  echo "ACTION   TYPE           NAME"

  name=$(jq -r '.flights[0].name' "$MANIFEST")
  id=$(lookup_flight "$name"); require_single "$id" "$name"
  plan_line "$(action_for "$id")" flight "$name"

  title=$(jq -r '.dives[0].title' "$MANIFEST")
  id=$(lookup_dive "$title"); require_single "$id" "$title"
  plan_line "$(action_for "$id")" dive "$title"

  local n; n=$(jq '.guides | length' "$MANIFEST")
  for ((i = 0; i < n; i++)); do
    title=$(jq -r ".guides[$i].title" "$MANIFEST")
    topic=$(jq -r ".guides[$i].topic" "$MANIFEST")
    id=$(lookup_guide "$title" "$topic"); require_single "$id" "$title"
    plan_line "$(action_for "$id")" guide "$title"
  done
}

# --- flight -----------------------------------------------------------------
deploy_flight() {
  local name src reqs cron cfg id
  name=$(jq -r '.flights[0].name'          "$MANIFEST")
  src=$( jq -r '.flights[0].source'        "$MANIFEST")
  reqs=$(jq -r '.flights[0].requirements'  "$MANIFEST")
  cron=$(jq -r '.flights[0].schedule_cron' "$MANIFEST")

  # Build a DuckDB MAP literal from the config object: MAP { 'K': 'V', ... }
  cfg=$(jq -r --arg q "'" '.flights[0].config | to_entries
        | map($q + .key + $q + ": " + $q + .value + $q) | join(", ")' "$MANIFEST")

  id=$(lookup_flight "$name"); require_single "$id" "$name"

  # SET VARIABLE is the only way to get file contents into a table function:
  # read_text() cannot be an argument, and neither can a subquery.
  local preamble="
    SET VARIABLE source_code      = (SELECT content FROM read_text('$src'));
    SET VARIABLE requirements_txt = (SELECT content FROM read_text('$reqs'));"
  local args="
    name              => '$name',
    source_code       => getvariable('source_code'),
    requirements_txt  => getvariable('requirements_txt'),
    schedule_cron     => '$cron',
    config            => MAP { $cfg }"

  if [[ -z "$id" ]]; then
    echo "Creating flight '$name'..."
    duckdb "md:" -c "$preamble FROM MD_CREATE_FLIGHT($args);" >/dev/null
    id=$(lookup_flight "$name")
  else
    echo "Updating flight '$name' ($id)..."
    duckdb "md:" -c "$preamble FROM MD_UPDATE_FLIGHT(flight_id => '$id'::UUID, $args);" >/dev/null
  fi

  echo "Running flight '$name'..."
  duckdb "md:" -c "FROM MD_RUN_FLIGHT(flight_id => '$id'::UUID);" >/dev/null

  # Wait for the run to finish. The Dive published next reads the table it writes.
  # Statuses are prefixed: RUN_STATUS_SUCCEEDED / _FAILED / _CANCELLED.
  local status=""
  for _ in $(seq 1 60); do
    status=$(sql1 "SELECT status FROM MD_LIST_FLIGHT_RUNS(flight_id => '$id'::UUID) ORDER BY run_number DESC LIMIT 1;")
    case "$status" in
      RUN_STATUS_SUCCEEDED|RUN_STATUS_FAILED|RUN_STATUS_CANCELLED) break ;;
    esac
    sleep 5
  done
  if [[ "$status" != "RUN_STATUS_SUCCEEDED" ]]; then
    echo "ERROR: flight run finished with status '${status:-unknown}'." >&2
    duckdb "md:" -c "SELECT logs FROM MD_GET_FLIGHT_LOGS(flight_id => '$id'::UUID, run_number => (SELECT max(run_number) FROM MD_LIST_FLIGHT_RUNS(flight_id => '$id'::UUID)));" >&2 || true
    exit 1
  fi
  echo "  Flight run succeeded."
}

# --- dive -------------------------------------------------------------------
deploy_dive() {
  local title src desc req id
  title=$(jq -r '.dives[0].title'       "$MANIFEST")
  src=$(  jq -r '.dives[0].source'      "$MANIFEST")
  desc=$( jq -r '.dives[0].description' "$MANIFEST")

  # Build the required_resources list: [{'url': '...', 'alias': '...'}, ...]
  req=$(jq -r --arg q "'" '.dives[0].required_resources
        | map("{" + $q + "url" + $q + ": " + $q + .url + $q + ", "
                  + $q + "alias" + $q + ": " + $q + .alias + $q + "}")
        | join(", ")' "$MANIFEST")

  # The published Dive declares its databases through required_resources. The
  # source keeps REQUIRED_DATABASES for local preview; shipping both is a
  # runtime error, so strip it here.
  grep -v '^export const REQUIRED_DATABASES' "$src" > "$DIVE_TMP"

  id=$(lookup_dive "$title"); require_single "$id" "$title"

  local preamble="SET VARIABLE content = (SELECT content FROM read_text('$DIVE_TMP'));"

  if [[ -z "$id" ]]; then
    echo "Creating dive '$title'..."
    id=$(duckdb "md:" -csv -noheader -c "$preamble
      SELECT id FROM MD_CREATE_DIVE(
        title = '$title', content = getvariable('content'),
        description = '$desc', api_version = 1,
        required_resources = [$req]);")
  else
    echo "Updating dive '$title' ($id)..."
    duckdb "md:" -c "$preamble
      FROM MD_UPDATE_DIVE_CONTENT(id = '$id'::UUID, content = getvariable('content'),
                                  api_version = 1, required_resources = [$req]);
      FROM MD_UPDATE_DIVE_METADATA(id = '$id'::UUID, title = '$title', description = '$desc');" >/dev/null
  fi
  echo "  https://app.motherduck.com/dives/$id"
}

deploy_guides() { :; }

main() {
  plan
  if [[ "$DRY_RUN" == true ]]; then
    echo
    echo "Dry run — nothing was changed."
    exit 0
  fi
  echo
  # Order matters: the Dive's required_resources names a database the Flight
  # creates, so the Flight must exist and have run before the Dive is published.
  deploy_flight
  deploy_dive
  deploy_guides
}

main "$@"

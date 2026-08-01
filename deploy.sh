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

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

# The DuckDB CLI intermittently crashes (SIGSEGV / SIGABRT) partway through a
# MotherDuck session — observed on v1.5.4 at several different MD_* call sites,
# never reproducibly. A crash is not a SQL error, so it is worth retrying.
#
# But retrying is only safe for operations that are idempotent: reads, and
# updates addressed by an existing ID. It is NOT safe for creates. If the
# server completed a CREATE and the client crashed before receiving the reply,
# a retry makes a SECOND artifact with a new ID. (This is not hypothetical —
# it produced a duplicate Guide during development.)
#
# So: `md` retries, `md_once` does not. Creates use md_once and fail the whole
# script on a crash. That is the correct outcome, because the script as a whole
# is idempotent: re-run it, and the next lookup finds the artifact the crashed
# run created and takes the update path instead.
md_once() { duckdb "md:" "$@"; }

md() {
  local attempt rc
  for attempt in 1 2 3; do
    duckdb "md:" "$@" && return 0
    rc=$?
    (( rc < 128 )) && return "$rc"
    echo "  duckdb crashed (exit $rc); retry ${attempt}/3" >&2
    sleep 2
  done
  return "$rc"
}

# Run SQL and return a bare value (empty when there are no rows).
sql1() { md -csv -noheader -c "$1"; }

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
  local name title topic id count
  echo "ACTION   TYPE           NAME"

  count=$(jq -r '.flights | length' "$MANIFEST")
  [[ "$count" -gt 0 ]] || { echo "ERROR: manifest declares no flights" >&2; exit 1; }
  while IFS= read -r name; do
    id=$(lookup_flight "$name"); require_single "$id" "$name"
    plan_line "$(action_for "$id")" flight "$name"
  done < <(jq -r '.flights[].name' "$MANIFEST")

  local nd; nd=$(jq '.dives | length' "$MANIFEST")
  for ((i = 0; i < nd; i++)); do
    title=$(jq -r ".dives[$i].title" "$MANIFEST")
    id=$(lookup_dive "$title"); require_single "$id" "$title"
    plan_line "$(action_for "$id")" dive "$title"
  done

  local n; n=$(jq '.guides | length' "$MANIFEST")
  for ((i = 0; i < n; i++)); do
    title=$(jq -r ".guides[$i].title" "$MANIFEST")
    topic=$(jq -r ".guides[$i].topic" "$MANIFEST")
    id=$(lookup_guide "$title" "$topic"); require_single "$id" "$title"
    plan_line "$(action_for "$id")" guide "$title"
  done
}

# --- flights ----------------------------------------------------------------
deploy_flight() {
  local count i name src reqs cron cfg secrets run_on_deploy id
  count=$(jq -r '.flights | length' "$MANIFEST")
  [[ "$count" -gt 0 ]] || { echo "ERROR: manifest declares no flights" >&2; exit 1; }

  for (( i = 0; i < count; i++ )); do
    name=$(jq -r ".flights[$i].name"          "$MANIFEST")
    src=$( jq -r ".flights[$i].source"        "$MANIFEST")
    reqs=$(jq -r ".flights[$i].requirements"  "$MANIFEST")
    # `// ""` is safe here where `// true` was not: in jq only null and false are
    # falsy, so an empty-string cron survives `//` — unlike a boolean false.
    cron=$(jq -r ".flights[$i].schedule_cron // \"\"" "$MANIFEST")
    run_on_deploy=$(jq -r ".flights[$i] | if has(\"run_on_deploy\") then .run_on_deploy else true end" "$MANIFEST")

    # Build a DuckDB MAP literal from the config object: MAP { 'K': 'V', ... }
    cfg=$(jq -r --arg q "'" ".flights[$i].config | to_entries
          | map(\$q + .key + \$q + \": \" + \$q + .value + \$q) | join(\", \")" "$MANIFEST")

    # LIST(VARCHAR) literal: ['a', 'b']. Empty string means omit the argument.
    secrets=$(jq -r --arg q "'" ".flights[$i].secrets // [] |
          if length == 0 then \"\"
          else \"[\" + (map(\$q + . + \$q) | join(\", \")) + \"]\" end" "$MANIFEST")

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
      config            => MAP { $cfg }"
    [[ -n "$secrets" ]] && args="$args,
      flight_secret_names => $secrets"
    [[ -n "$cron" ]] && args="$args,
      schedule_cron     => '$cron'"

    if [[ -z "$id" ]]; then
      echo "Creating flight '$name'..."
      md_once -c "$preamble FROM MD_CREATE_FLIGHT($args);" >/dev/null
      id=$(lookup_flight "$name")
    else
      echo "Updating flight '$name' ($id)..."
      md -c "$preamble FROM MD_UPDATE_FLIGHT(flight_id => '$id'::UUID, $args);" >/dev/null
    fi

    case "$run_on_deploy" in
      true) ;;
      false)
        echo "  Skipping run for '$name' (run_on_deploy=false)."
        continue ;;
      *)
        echo "ERROR: run_on_deploy for '$name' must be true or false, got '$run_on_deploy'." >&2
        exit 1 ;;
    esac

    echo "Running flight '$name'..."
    md -c "FROM MD_RUN_FLIGHT(flight_id => '$id'::UUID);" >/dev/null

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
      md -c "SELECT logs FROM MD_GET_FLIGHT_LOGS(flight_id => '$id'::UUID, run_number => (SELECT max(run_number) FROM MD_LIST_FLIGHT_RUNS(flight_id => '$id'::UUID)));" >&2 || true
      exit 1
    fi
    echo "  Flight run succeeded."
  done
}

# --- dives ------------------------------------------------------------------
deploy_dives() {
  local n; n=$(jq '.dives | length' "$MANIFEST")
  local i title src desc req id preamble status cur_status cur_ver applies_ver

  for ((i = 0; i < n; i++)); do
    title=$(jq -r ".dives[$i].title"       "$MANIFEST")
    src=$(  jq -r ".dives[$i].source"      "$MANIFEST")
    desc=$( jq -r ".dives[$i].description" "$MANIFEST")
    # Absent rather than defaulted on purpose: a Dive with no declared status is
    # one the repository does not claim to own, so it is left alone entirely.
    # Defaulting to 'draft' would silently demote a Dive someone endorsed.
    status=$(jq -r ".dives[$i].status // empty" "$MANIFEST")

    # Build the required_resources list: [{'url': '...', 'alias': '...'}, ...].
    # Dives that only read MD_INFORMATION_SCHEMA or MD_LIST_* attach nothing,
    # and an empty list is accepted.
    req=$(jq -r --arg q "'" ".dives[$i].required_resources
          | map(\"{\" + \$q + \"url\" + \$q + \": \" + \$q + .url + \$q + \", \"
                    + \$q + \"alias\" + \$q + \": \" + \$q + .alias + \$q + \"}\")
          | join(\", \")" "$MANIFEST")

    # The published Dive declares its databases through required_resources. The
    # source keeps REQUIRED_DATABASES for local preview; shipping both is a
    # runtime error, so strip it here.
    grep -v '^export const REQUIRED_DATABASES' "$src" > "$DIVE_TMP"

    id=$(lookup_dive "$title"); require_single "$id" "$title"

    preamble="SET VARIABLE content = (SELECT content FROM read_text('$DIVE_TMP'));"

    if [[ -z "$id" ]]; then
      echo "Creating dive '$title'..."
      id=$(md_once -csv -noheader -c "$preamble
        SELECT id FROM MD_CREATE_DIVE(
          title = '$title', content = getvariable('content'),
          description = '$desc', api_version = 1,
          required_resources = [$req]);")
    else
      echo "Updating dive '$title' ($id)..."
      md -c "$preamble
        FROM MD_UPDATE_DIVE_CONTENT(id = '$id'::UUID, content = getvariable('content'),
                                    api_version = 1, required_resources = [$req]);
        FROM MD_UPDATE_DIVE_METADATA(id = '$id'::UUID, title = '$title', description = '$desc');" >/dev/null
    fi

    # Status is declared in the manifest, so reconcile it on every run — same
    # reasoning as guide access: a Dive flipped back to 'draft' in the UI would
    # otherwise stay that way and the repository would stop being the truth.
    #
    # The wrinkle is that a Dive's status is pinned to a VERSION.
    # MD_UPDATE_DIVE_STATUS stamps one version, and MD_UPDATE_DIVE_CONTENT above
    # bumps current_version — so on any run that changed content, the status is
    # still 'ready' but describes the PREVIOUS version, which is not what is
    # published. Hence the test covers both the status and the version it applies
    # to; comparing only the status would leave every edit published as stale.
    if [[ -n "$status" ]]; then
      read -r cur_status cur_ver applies_ver <<<"$(sql1 "
        SELECT coalesce(status, 'none') || ' ' || coalesce(current_version, 0)
                                        || ' ' || coalesce(status_applies_to_version, 0)
        FROM MD_LIST_DIVES() WHERE id = '$id';")"
      if [[ "$cur_status" != "$status" || "$applies_ver" != "$cur_ver" ]]; then
        echo "  status: ${cur_status}@v${applies_ver} -> ${status}@v${cur_ver}"
        md -c "FROM MD_UPDATE_DIVE_STATUS(id = '$id'::UUID, status = '$status',
                                          version = ${cur_ver});" >/dev/null
      fi
    fi

    echo "  https://app.motherduck.com/dives/$id"
  done
}

# --- guides -----------------------------------------------------------------
deploy_guides() {
  local n; n=$(jq '.guides | length' "$MANIFEST")
  local i title topic src desc access id preamble current_access
  # external_id ties each published version back to a commit.
  local sha="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo local)}"

  for ((i = 0; i < n; i++)); do
    title=$(jq -r ".guides[$i].title"       "$MANIFEST")
    topic=$(jq -r ".guides[$i].topic"       "$MANIFEST")
    src=$(  jq -r ".guides[$i].source"      "$MANIFEST")
    desc=$( jq -r ".guides[$i].description" "$MANIFEST")
    access=$(jq -r ".guides[$i].access // \"user\"" "$MANIFEST")

    id=$(lookup_guide "$title" "$topic"); require_single "$id" "$title"
    preamble="SET VARIABLE guide_content = (SELECT content FROM read_text('$src'));"

    # An empty topic means "root": the guide appears in every get_query_guide
    # overview. Omit the argument entirely rather than passing ''.
    local topic_arg=""
    [[ -n "$topic" ]] && topic_arg="\"topic\" := '$topic',"

    if [[ -z "$id" ]]; then
      echo "Creating guide '$title'${topic:+ [$topic]}..."
      md_once -c "$preamble
        SELECT id FROM MD_CREATE_GUIDE(
          \"title\"          := '$title',
          $topic_arg
          \"description\"    := '$desc',
          \"content\"        := getvariable('guide_content'),
          \"access\"         := '$access',
          \"change_comment\" := 'deployed from $sha',
          \"external_id\"    := '$sha');" >/dev/null
    else
      echo "Updating guide '$title' ($id)..."
      md -c "$preamble
        FROM MD_UPDATE_GUIDE(\"id\" := '$id'::UUID,
          \"content\"        := getvariable('guide_content'),
          \"change_comment\" := 'deployed from $sha',
          \"external_id\"    := '$sha');
        FROM MD_UPDATE_GUIDE_METADATA(\"id\" := '$id'::UUID,
          \"title\" := '$title', $topic_arg \"description\" := '$desc');" >/dev/null

      # Visibility is declared in the manifest, so reconcile it on every run —
      # otherwise a guide flipped to 'organization' in the UI would stay that
      # way forever and the repository would stop being the source of truth.
      current_access=$(sql1 "SELECT access FROM MD_LIST_GUIDES() WHERE id = '$id';")
      if [[ "$current_access" != "$access" ]]; then
        echo "  access: $current_access -> $access"
        md -c "FROM MD_SET_GUIDE_ACCESS(id := '$id'::UUID, access := '$access');" >/dev/null
      fi
    fi
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
  deploy_dives
  deploy_guides
}

main "$@"

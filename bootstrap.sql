-- One-time setup. Not run by CI.
--
-- Copies the four source tables into a database this account owns, then
-- publishes it as an UNRESTRICTED share. Run this once before the first
-- ./deploy.sh, and copy the printed share URL into manifest.json.
--
-- Run with:  duckdb "md:" -f bootstrap.sql
--
-- The default source below is the public agent_commerce share. If you are
-- forking this repository, you can either point manifest.json straight at that
-- share URL and skip this file, or run this to own a copy. Owning a copy is
-- required if your organization is in a different cloud region, because shares
-- are region-scoped and cannot be attached across regions.

ATTACH IF NOT EXISTS
  'md:_share/agent_commerce/a6ee8703-ade7-4e18-8ec5-e3c09065064f'
  AS source_data;

CREATE DATABASE IF NOT EXISTS agent_commerce;

CREATE OR REPLACE TABLE agent_commerce.main.tenants               AS SELECT * FROM source_data.main.tenants;
CREATE OR REPLACE TABLE agent_commerce.main.agent_services        AS SELECT * FROM source_data.main.agent_services;
CREATE OR REPLACE TABLE agent_commerce.main.agent_transactions    AS SELECT * FROM source_data.main.agent_transactions;
CREATE OR REPLACE TABLE agent_commerce.main.service_state_history AS SELECT * FROM source_data.main.service_state_history;

-- ACCESS UNRESTRICTED: any MotherDuck user in the same cloud region can attach.
CREATE SHARE IF NOT EXISTS agent_commerce FROM agent_commerce
  (ACCESS UNRESTRICTED, VISIBILITY DISCOVERABLE, UPDATE MANUAL);
UPDATE SHARE agent_commerce;

-- Copy this URL into manifest.json.
SELECT url AS agent_commerce_share_url
FROM MD_LIST_DATABASE_SHARES() WHERE name = 'agent_commerce';

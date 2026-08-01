-- One-time setup. Not run by CI.
--
-- Copies the four upstream tables into a database this account owns, then
-- publishes it as an UNRESTRICTED share. After this runs, nothing in the
-- repository refers to the upstream share again.
--
-- Run with:  duckdb "md:" -f bootstrap.sql

ATTACH IF NOT EXISTS
  'md:_share/agent_commerce/a6ee8703-ade7-4e18-8ec5-e3c09065064f'
  AS upstream;

CREATE DATABASE IF NOT EXISTS agent_commerce;

CREATE OR REPLACE TABLE agent_commerce.main.tenants               AS SELECT * FROM upstream.main.tenants;
CREATE OR REPLACE TABLE agent_commerce.main.agent_services        AS SELECT * FROM upstream.main.agent_services;
CREATE OR REPLACE TABLE agent_commerce.main.agent_transactions    AS SELECT * FROM upstream.main.agent_transactions;
CREATE OR REPLACE TABLE agent_commerce.main.service_state_history AS SELECT * FROM upstream.main.service_state_history;

-- ACCESS UNRESTRICTED: any MotherDuck user in the same cloud region can attach.
CREATE SHARE IF NOT EXISTS agent_commerce FROM agent_commerce
  (ACCESS UNRESTRICTED, VISIBILITY DISCOVERABLE, UPDATE MANUAL);
UPDATE SHARE agent_commerce;

-- Copy this URL into manifest.json.
SELECT url AS agent_commerce_share_url
FROM MD_LIST_DATABASE_SHARES() WHERE name = 'agent_commerce';

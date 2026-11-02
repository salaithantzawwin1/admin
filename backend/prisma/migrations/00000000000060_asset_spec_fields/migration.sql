-- §15/§16 asset register — category-specific specification fields.
-- Categories define WHICH fields their assets carry (e.g. a printer's
-- connection: USB / Network), assets store the answers as { key: value }.

ALTER TABLE "asset_categories" ADD COLUMN "specFields" JSONB;
ALTER TABLE "assets" ADD COLUMN "specs" JSONB;

-- Seed defaults for the categories that already exist. Only untouched rows are
-- written (specFields IS NULL), so an admin's later edit is never overwritten
-- by a replay of this migration.

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"connection","label":"Connection","type":"select","options":["USB","Network (LAN)","Wi-Fi","USB + Network"]},
  {"key":"color","label":"Color","type":"select","options":["Mono","Color"]},
  {"key":"functions","label":"Functions","type":"select","options":["Print only","Print + Scan","Print + Scan + Copy","All-in-one"]},
  {"key":"paper_size","label":"Paper size","type":"select","options":["A4","A3","A4 + A3"]}
]'::jsonb
WHERE lower(name) LIKE 'printer%' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"connection","label":"Connection","type":"select","options":["Wired","Wi-Fi","Wired + Wi-Fi"]},
  {"key":"os","label":"Operating system","type":"text"},
  {"key":"cpu","label":"CPU","type":"text"},
  {"key":"ram","label":"RAM","type":"text"},
  {"key":"storage","label":"Storage","type":"text"}
]'::jsonb
WHERE lower(name) = 'it equipment' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"screen_size","label":"Screen size","type":"text"},
  {"key":"resolution","label":"Resolution","type":"text"},
  {"key":"connection","label":"Connection","type":"select","options":["HDMI","VGA","HDMI + VGA","Wireless / Cast"]}
]'::jsonb
WHERE lower(name) LIKE 'display%' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"type","label":"Type","type":"select","options":["Split","Window","Cassette","Ceiling","Portable"]},
  {"key":"capacity","label":"Capacity (BTU)","type":"text"},
  {"key":"inverter","label":"Inverter","type":"select","options":["Yes","No"]}
]'::jsonb
WHERE lower(name) LIKE 'air condition%' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"voltage","label":"Voltage","type":"select","options":["220V","380V","Other"]},
  {"key":"power","label":"Power rating (W)","type":"text"}
]'::jsonb
WHERE lower(name) LIKE 'electrical%' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"material","label":"Material","type":"text"},
  {"key":"dimensions","label":"Dimensions","type":"text"}
]'::jsonb
WHERE lower(name) = 'furniture' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"registration_no","label":"Registration no.","type":"text"},
  {"key":"engine_no","label":"Engine no.","type":"text"},
  {"key":"model_year","label":"Model year","type":"number"},
  {"key":"fuel","label":"Fuel","type":"select","options":["Petrol","Diesel","Hybrid","Electric"]}
]'::jsonb
WHERE lower(name) = 'vehicle' AND "specFields" IS NULL;

UPDATE "asset_categories" SET "specFields" = '[
  {"key":"type","label":"Type","type":"text"},
  {"key":"dimensions","label":"Dimensions","type":"text"}
]'::jsonb
WHERE lower(name) = 'office equipment' AND "specFields" IS NULL;

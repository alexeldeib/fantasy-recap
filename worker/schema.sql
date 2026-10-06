-- One row per Sleeper league per season (Sleeper gives a renewed league a new ID each year). A league is "active"
-- (recaps get written) once paid_via is set; until then anyone can see its free preview.
CREATE TABLE IF NOT EXISTS leagues (
  league_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,                 -- the page address, /<slug>; a renewed league inherits it
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  previous_league_id TEXT,
  paid_via TEXT,                      -- NULL (preview), a Stripe checkout session ID, 'comp', or 'showcase' (shown, never written)
  intro TEXT NOT NULL DEFAULT '',     -- optional first line of the writer's brief
  lore TEXT NOT NULL DEFAULT '[]',    -- JSON list: in-jokes, rivalries, past champions
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS leagues_slug ON leagues (slug, season);

-- Every recap: the weekly one ('weekly'), game-day updates ('day-2026-10-04'), and free previews ('preview').
-- A recap whose row exists is never written again; delete the row to have the next cron tick redo it.
CREATE TABLE IF NOT EXISTS recaps (
  league_id TEXT NOT NULL,
  season TEXT NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending, done, failed, skipped
  headline TEXT,
  dek TEXT,                           -- for the feed, without parsing every doc
  doc TEXT,                           -- {"facts": ..., "copy": ..., "cost": ...}; facts without the lineups
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (league_id, season, week, kind)
);

-- Shared fetches: the NFL player list (daily) and each game day's real-life news brief.
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

-- League addresses become the name plus the last six digits of the league's Sleeper ID (src/pages.ts slugFor). Names repeat,
-- and first-come slugs could hand an expired league's address to a different league. A renewed league's rows share one
-- slug, so the suffix comes from its first season.
CREATE TABLE slug_roots AS
  SELECT slug, (SELECT l2.league_id FROM leagues l2 WHERE l2.slug = l1.slug ORDER BY l2.season LIMIT 1) AS root FROM leagues l1 GROUP BY slug;
UPDATE leagues SET slug = slug || '-' || substr((SELECT root FROM slug_roots r WHERE r.slug = leagues.slug), -6);
DROP TABLE slug_roots;

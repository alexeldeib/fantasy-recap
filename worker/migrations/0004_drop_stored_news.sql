-- Posts no longer store the writer's news brief: the pages never show it, it was the same for every league, and it made up
-- a fifth of every post. (The briefs stay in the cache table for 21 days.)
UPDATE recaps SET doc = json_remove(doc, '$.copy.news') WHERE json_extract(doc, '$.copy.news') IS NOT NULL;

-- Site icon discovered from the feed's homepage <link rel="icon">, so sites that don't
-- use /favicon.ico still show an icon. NULL = not looked up yet, '' = looked up, none declared.
ALTER TABLE feed ADD COLUMN icon_url TEXT;

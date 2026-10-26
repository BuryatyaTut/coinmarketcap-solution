-- Initial application schema, applied once using PRAGMA user_version.
-- All timestamps are normalized UTC ISO 8601 with milliseconds by the application.
-- Validate runtime/provider input before executing parameterized statements.
PRAGMA foreign_keys = ON;

CREATE TABLE cryptocurrencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cmc_id INTEGER NOT NULL UNIQUE CHECK (cmc_id > 0 AND cmc_id <= 9007199254740991),
    symbol TEXT NOT NULL CHECK (length(trim(symbol)) BETWEEN 1 AND 64),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_price_at TEXT
) STRICT;

CREATE TABLE price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cryptocurrency_id INTEGER NOT NULL
        REFERENCES cryptocurrencies(id) ON DELETE CASCADE,
    price REAL NOT NULL CHECK (price >= 0 AND price <= 1.7976931348623157e308),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    observed_at TEXT NOT NULL,
    source_updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_price_history_coin_observed
    ON price_history (cryptocurrency_id, observed_at DESC, id DESC);

-- Latest observation:
-- SELECT * FROM price_history WHERE cryptocurrency_id = ?
-- ORDER BY observed_at DESC, id DESC LIMIT 1;
--
-- Price write and parent timestamps belong in ONE short transaction.
-- Fetch the provider response before starting the transaction.
-- Do not add UNIQUE(symbol): different assets can share a ticker.

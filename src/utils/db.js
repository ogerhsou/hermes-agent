const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '../../data/polymarket_tracker.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Initialize all tables.
 */
function initDb() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS follow_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decisionId TEXT NOT NULL,
      clobTokenId TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      orderId TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      filledSize REAL DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add new columns if they don't exist
  ensureColumn(database, 'follow_orders', 'closed_price', 'REAL');
  ensureColumn(database, 'follow_orders', 'realized_pnl', 'REAL');
}

/**
 * Safely add a column to a table if it doesn't already exist.
 */
function ensureColumn(database, table, column, type) {
  try {
    const tableInfo = database.pragma(`table_info(${table})`);
    const hasColumn = tableInfo.some(c => c.name === column);
    if (!hasColumn) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch (err) {
    // If pragma fails for any reason, try the ALTER TABLE directly
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      // Column likely already exists or another issue - silently ignore
    }
  }
}

module.exports = {
  getDb,
  closeDb,
  initDb,
  ensureColumn,
};

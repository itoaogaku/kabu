"""SQLiteでの保有・売却銘柄の記録を扱う薄いデータアクセス層。"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "kabu.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    yf_ticker TEXT NOT NULL,
    name TEXT,
    quantity REAL NOT NULL DEFAULT 1,
    buy_price REAL NOT NULL,
    buy_date TEXT NOT NULL,
    sell_price REAL,
    sell_date TEXT,
    memo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


@contextmanager
def get_conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.execute(SCHEMA)


def add_stock(ticker, yf_ticker, name, quantity, buy_price, buy_date, memo):
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO stocks
               (ticker, yf_ticker, name, quantity, buy_price, buy_date, memo)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (ticker, yf_ticker, name, quantity, buy_price, buy_date, memo),
        )
        return cur.lastrowid


def list_stocks():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM stocks ORDER BY (sell_price IS NOT NULL), buy_date DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_stock(stock_id):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM stocks WHERE id = ?", (stock_id,)).fetchone()
        return dict(row) if row else None


def update_memo(stock_id, memo):
    with get_conn() as conn:
        conn.execute("UPDATE stocks SET memo = ? WHERE id = ?", (memo, stock_id))


def mark_sold(stock_id, sell_price, sell_date):
    with get_conn() as conn:
        conn.execute(
            "UPDATE stocks SET sell_price = ?, sell_date = ? WHERE id = ?",
            (sell_price, sell_date, stock_id),
        )


def unmark_sold(stock_id):
    with get_conn() as conn:
        conn.execute(
            "UPDATE stocks SET sell_price = NULL, sell_date = NULL WHERE id = ?",
            (stock_id,),
        )


def delete_stock(stock_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM stocks WHERE id = ?", (stock_id,))

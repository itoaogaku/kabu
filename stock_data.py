"""yfinance を使った株価取得のラッパー。現在値には短時間のキャッシュをかける。"""
import re
import time

import yfinance as yf

_PRICE_CACHE_TTL = 300  # 秒。連続アクセスによるレート制限を避けるためのキャッシュ
_price_cache: dict[str, tuple[float, dict]] = {}

_JP_CODE_RE = re.compile(r"^\d{4}[A-Z0-9]?$")  # 東証の4桁(+英数字1桁)コード


def normalize_ticker(raw: str) -> str:
    """ユーザー入力を yfinance 用ティッカーに正規化する。

    例: "7203" -> "7203.T" (東証), "AAPL" -> "AAPL", "7203.T" -> "7203.T"
    """
    raw = raw.strip().upper()
    if "." in raw:
        return raw
    if _JP_CODE_RE.match(raw):
        return f"{raw}.T"
    return raw


def fetch_name(yf_ticker: str) -> str | None:
    try:
        info = yf.Ticker(yf_ticker).get_info()
        return info.get("shortName") or info.get("longName")
    except Exception:
        return None


def get_current_price(yf_ticker: str, use_cache: bool = True) -> dict | None:
    """{'price': float, 'currency': str} を返す。取得失敗時は None。"""
    now = time.time()
    if use_cache and yf_ticker in _price_cache:
        ts, data = _price_cache[yf_ticker]
        if now - ts < _PRICE_CACHE_TTL:
            return data

    try:
        fi = yf.Ticker(yf_ticker).fast_info
        price = fi.get("lastPrice") if isinstance(fi, dict) else fi.last_price
        currency = fi.get("currency") if isinstance(fi, dict) else fi.currency
        if price is None:
            return None
        data = {"price": float(price), "currency": currency or ""}
        _price_cache[yf_ticker] = (now, data)
        return data
    except Exception:
        return None


def get_current_prices(yf_tickers: list[str]) -> dict[str, dict | None]:
    """複数銘柄の現在値をまとめて取得する。"""
    return {t: get_current_price(t) for t in dict.fromkeys(yf_tickers)}


def get_history(yf_ticker: str, start_date: str, end_date: str | None = None) -> list[dict]:
    """[{'date': 'YYYY-MM-DD', 'close': float}, ...] を購入日から現在までで返す。"""
    try:
        hist = yf.Ticker(yf_ticker).history(start=start_date, end=end_date, interval="1d")
        if hist.empty:
            return []
        return [
            {"date": idx.strftime("%Y-%m-%d"), "close": round(float(row["Close"]), 2)}
            for idx, row in hist.iterrows()
        ]
    except Exception:
        return []


def clear_cache():
    _price_cache.clear()

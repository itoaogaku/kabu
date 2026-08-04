"""自分が買った株の株価推移を追跡するダッシュボード。"""
from datetime import date

from flask import Flask, jsonify, redirect, render_template, request, url_for

import db
import stock_data

app = Flask(__name__)
db.init_db()


@app.template_filter("yen")
def yen_filter(value):
    if value is None:
        return "―"
    return f"¥{value:,.0f}"


@app.template_filter("yen_signed")
def yen_signed_filter(value):
    if value is None:
        return "―"
    sign = "+" if value > 0 else ("-" if value < 0 else "")
    return f"{sign}¥{abs(value):,.0f}"


def _pct(base: float, current: float) -> float | None:
    if not base:
        return None
    return round((current - base) / base * 100, 2)


def _enrich(stock: dict) -> dict:
    """DBの1レコードに現在値・騰落率などを付与して表示用データにする。"""
    price_info = stock_data.get_current_price(stock["yf_ticker"])
    current_price = price_info["price"] if price_info else None
    currency = price_info["currency"] if price_info else ""

    is_sold = stock["sell_price"] is not None
    stock = dict(stock)
    stock["currency"] = currency
    stock["current_price"] = current_price
    stock["is_sold"] = is_sold
    stock["status_label"] = "売却済み" if is_sold else "保有中"

    # 購入時からの騰落(保有中・売却済み問わず常に表示)
    stock["change_from_buy_pct"] = (
        _pct(stock["buy_price"], current_price) if current_price is not None else None
    )

    if is_sold:
        # 実現損益(買値 -> 売値)
        stock["realized_pct"] = _pct(stock["buy_price"], stock["sell_price"])
        # 売却後の値動き(売値 -> 現在値) : 「売った後も上げ下げが分かる」の本体
        stock["change_since_sell_pct"] = (
            _pct(stock["sell_price"], current_price) if current_price is not None else None
        )
    else:
        stock["realized_pct"] = None
        stock["change_since_sell_pct"] = None

    return stock


def _summary(holding: list[dict], sold: list[dict]) -> dict:
    cost_total = sum(s["buy_price"] * s["quantity"] for s in holding)
    known = [s for s in holding if s["current_price"] is not None]
    market_known = len(known) > 0
    market_total = sum(s["current_price"] * s["quantity"] for s in known)
    unrealized = (market_total - cost_total) if market_known else None
    unrealized_pct = (
        round(unrealized / cost_total * 100, 2) if (market_known and cost_total) else None
    )
    realized_total = sum((s["sell_price"] - s["buy_price"]) * s["quantity"] for s in sold)
    return {
        "cost_total": cost_total,
        "market_total": market_total,
        "market_known": market_known,
        "unrealized": unrealized,
        "unrealized_pct": unrealized_pct,
        "realized_total": realized_total,
    }


@app.route("/")
def index():
    stocks = [_enrich(s) for s in db.list_stocks()]
    holding = [s for s in stocks if not s["is_sold"]]
    sold = [s for s in stocks if s["is_sold"]]
    for s in holding:
        s["market_value"] = s["current_price"] * s["quantity"] if s["current_price"] is not None else None
        s["pnl_value"] = s["market_value"] - s["buy_price"] * s["quantity"] if s["market_value"] is not None else None
    for s in sold:
        s["realized_value"] = (s["sell_price"] - s["buy_price"]) * s["quantity"]
    summary = _summary(holding, sold)
    return render_template(
        "index.html", holding=holding, sold=sold, summary=summary, today=date.today().isoformat()
    )


@app.route("/add", methods=["POST"])
def add():
    raw_ticker = request.form["ticker"].strip()
    yf_ticker = stock_data.normalize_ticker(raw_ticker)
    name = request.form.get("name", "").strip()
    if not name:
        name = stock_data.fetch_name(yf_ticker) or raw_ticker
    quantity = float(request.form.get("quantity") or 1)
    buy_price = float(request.form["buy_price"])
    buy_date = request.form["buy_date"]
    memo = request.form.get("memo", "").strip()

    db.add_stock(raw_ticker, yf_ticker, name, quantity, buy_price, buy_date, memo)
    return redirect(url_for("index"))


@app.route("/stock/<int:stock_id>/sell", methods=["POST"])
def sell(stock_id):
    sell_price = float(request.form["sell_price"])
    sell_date = request.form["sell_date"]
    db.mark_sold(stock_id, sell_price, sell_date)
    return redirect(url_for("index"))


@app.route("/stock/<int:stock_id>/unsell", methods=["POST"])
def unsell(stock_id):
    db.unmark_sold(stock_id)
    return redirect(url_for("index"))


@app.route("/stock/<int:stock_id>/memo", methods=["POST"])
def update_memo(stock_id):
    db.update_memo(stock_id, request.form.get("memo", "").strip())
    return redirect(url_for("index"))


@app.route("/stock/<int:stock_id>/edit", methods=["POST"])
def edit(stock_id):
    def _float_or_none(key):
        value = request.form.get(key, "").strip()
        return float(value) if value else None

    db.update_stock(
        stock_id,
        quantity=_float_or_none("quantity"),
        buy_price=_float_or_none("buy_price"),
        buy_date=request.form.get("buy_date", "").strip() or None,
        sell_price=_float_or_none("sell_price"),
        sell_date=request.form.get("sell_date", "").strip() or None,
    )
    return redirect(url_for("index"))


@app.route("/stock/<int:stock_id>/delete", methods=["POST"])
def delete(stock_id):
    db.delete_stock(stock_id)
    return redirect(url_for("index"))


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    stock_data.clear_cache()
    stocks = [_enrich(s) for s in db.list_stocks()]
    return jsonify(stocks)


@app.route("/api/history/<int:stock_id>")
def api_history(stock_id):
    stock = db.get_stock(stock_id)
    if not stock:
        return jsonify({"error": "not found"}), 404
    end = stock["sell_date"] if stock["sell_price"] is not None else None
    history = stock_data.get_history(stock["yf_ticker"], stock["buy_date"], end)
    return jsonify({"ticker": stock["ticker"], "history": history, "buy_price": stock["buy_price"],
                     "sell_price": stock["sell_price"]})


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5000)

"""自分が買った株の株価推移を追跡するダッシュボード。"""
from datetime import date

from flask import Flask, jsonify, redirect, render_template, request, url_for

import db
import stock_data

app = Flask(__name__)
db.init_db()


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


@app.route("/")
def index():
    stocks = [_enrich(s) for s in db.list_stocks()]
    holding = [s for s in stocks if not s["is_sold"]]
    sold = [s for s in stocks if s["is_sold"]]
    return render_template("index.html", holding=holding, sold=sold, today=date.today().isoformat())


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

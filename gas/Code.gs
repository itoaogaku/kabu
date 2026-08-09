/**
 * かぶトラッカー (GAS版) - 取引履歴ベース
 *
 * 「買い→売り」をロットとしてペアリングする方式をやめ、証券会社の取引メモのような
 * フラットな取引履歴(日付・銘柄・区分(購入/売却)・株数・単価・メモ)を1本のリストで
 * 保持する。保有株数・取得単価(加重平均)・損益はすべて取引履歴から都度集計する。
 *
 * 株価は Yahoo Finance の公開チャートAPIを UrlFetchApp で直接呼び出して取得する
 * (APIキー不要)。取得結果は _prices シートにキャッシュし、明示的な更新操作
 * (refreshPrices)のときだけ再取得する。
 */

var TXN_SHEET = 'Transactions';
var PRICE_SHEET = '_prices';
var LEGACY_STOCKS_SHEET = 'Stocks';
var TZ = 'Asia/Tokyo';
var YF_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
var DROP_ALERT_THRESHOLD = -15; // % (平均取得単価 or 直近売却価格からこれ以上下がったら通知)

var TCOL = {
  ID: 1, TICKER: 2, YF_TICKER: 3, NAME: 4, DATE: 5, SIDE: 6, QUANTITY: 7, PRICE: 8, MEMO: 9, CREATED_AT: 10
};
var TXN_HEADERS = ['id', 'ticker', 'yf_ticker', 'name', 'date', 'side', 'quantity', 'price', 'memo', 'created_at'];

var PCOL = { YF_TICKER: 1, PRICE: 2, CURRENCY: 3, UPDATED_AT: 4 };
var PRICE_HEADERS = ['yf_ticker', 'price', 'currency', 'updated_at'];

// ------------------------------------------------------------------
// Web App エントリーポイント
// ------------------------------------------------------------------

function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApi_(e);
  }
  var tmpl = HtmlService.createTemplateFromFile('Index');
  return tmpl
    .evaluate()
    .setTitle('かぶトラッカー')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  return handleApi_(e);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ------------------------------------------------------------------
// JSON API (外部フロントエンド用。例: Vercel でホストする静的サイトから fetch で呼ぶ)
// ------------------------------------------------------------------

function checkToken_(e) {
  var required = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!required) return true;
  return e.parameter && e.parameter.token === required;
}

function handleApi_(e) {
  var result;
  try {
    if (!checkToken_(e)) {
      throw new Error('unauthorized');
    }
    var p = e.parameter || {};
    switch (p.action) {
      case 'summary':
        result = getStockSummary();
        break;
      case 'transactions':
        result = getTransactions();
        break;
      case 'add':
        result = addTransaction({
          ticker: p.ticker,
          name: p.name,
          date: p.date,
          side: p.side,
          quantity: p.quantity,
          price: p.price,
          memo: p.memo
        });
        break;
      case 'update':
        result = updateTransaction(p.id, {
          ticker: p.ticker,
          name: p.name,
          date: p.date,
          side: p.side,
          quantity: p.quantity,
          price: p.price,
          memo: p.memo
        });
        break;
      case 'delete':
        result = deleteTransaction(p.id);
        break;
      case 'refresh':
        result = refreshPrices();
        break;
      case 'history':
        result = getHistoryForTicker(p.yf_ticker);
        break;
      default:
        throw new Error('unknown action: ' + p.action);
    }
    return jsonOutput_({ ok: true, data: result });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------------
// 初期セットアップ
// ------------------------------------------------------------------

function setup() {
  getTxnSheet_();
  getPriceSheet_();
  return 'セットアップ完了';
}

function getTxnSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TXN_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TXN_SHEET);
  }
  if (sheet.getRange(1, 1).getValue() !== 'id') {
    sheet.getRange(1, 1, 1, TXN_HEADERS.length).setValues([TXN_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getPriceSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PRICE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PRICE_SHEET);
    sheet.hideSheet();
  }
  if (sheet.getRange(1, 1).getValue() !== 'yf_ticker') {
    sheet.getRange(1, 1, 1, PRICE_HEADERS.length).setValues([PRICE_HEADERS]);
  }
  return sheet;
}

// ------------------------------------------------------------------
// 過去データ(ロット方式)からの移行
// ------------------------------------------------------------------

// 旧 "Stocks" シート(1行=1購入ロット、売却済みなら sell_price/sell_date も同じ行)から
// 新しい取引履歴形式へ変換する。1ロットにつき buy 取引を1件、売却済みなら sell 取引を
// もう1件追加する。Apps Script エディタから1回だけ実行する想定。
function migrateFromLegacyStocks() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var oldSheet = ss.getSheetByName(LEGACY_STOCKS_SHEET);
  if (!oldSheet) {
    Logger.log('Stocks シートが見つかりません(移行対象なし)');
    return 0;
  }
  var lastRow = oldSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('Stocks シートにデータがありません');
    return 0;
  }
  var rows = oldSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var txnSheet = getTxnSheet_();
  var now = new Date();
  var out = [];

  rows.forEach(function (r) {
    var ticker = r[1];
    var name = r[3];
    var quantity = r[4];
    var buyPrice = r[5];
    var buyDate = r[6];
    var sellPrice = r[7];
    var sellDate = r[8];
    var memo = r[9];
    if (!ticker) return;
    var yfTicker = normalizeTicker(String(ticker));
    out.push([Utilities.getUuid(), ticker, yfTicker, name, buyDate, 'buy', quantity, buyPrice, memo || '', now]);
    if (sellPrice !== '' && sellPrice !== null && sellPrice !== undefined) {
      out.push([Utilities.getUuid(), ticker, yfTicker, name, sellDate, 'sell', quantity, sellPrice, memo || '', now]);
    }
  });

  if (out.length) {
    var startRow = txnSheet.getLastRow() + 1;
    txnSheet.getRange(startRow, 1, out.length, TXN_HEADERS.length).setValues(out);
    for (var i = 0; i < out.length; i++) {
      txnSheet.getRange(startRow + i, TCOL.DATE).setNumberFormat('yyyy-mm-dd');
    }
    SpreadsheetApp.flush();
  }
  Logger.log('移行した取引件数: ' + out.length + ' (元のロット数: ' + rows.length + ')');
  return out.length;
}

// ------------------------------------------------------------------
// ティッカー正規化・Yahoo Finance ヘルパー
// ------------------------------------------------------------------

var JP_CODE_RE = /^\d{3,4}[A-Z0-9]?$/;

function normalizeTicker(raw) {
  var t = String(raw).trim().toUpperCase();
  if (t.indexOf('.') !== -1 || t.indexOf(':') !== -1) return t;
  if (JP_CODE_RE.test(t)) return t + '.T';
  return t;
}

function yahooFetchOptions_() {
  return {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  };
}

// Yahoo Finance から現在値・銘柄名をまとめて取得する(スプレッドシートには保存しない)。
// 戻り値: { [ticker]: {price, currency, name} | null }
function fetchCurrentPricesFromYahoo_(tickers) {
  var unique = [];
  var seen = {};
  tickers.forEach(function (t) {
    if (t && !seen[t]) { seen[t] = true; unique.push(t); }
  });
  var result = {};
  if (!unique.length) return result;

  var requests = unique.map(function (t) {
    return Object.assign(
      { url: YF_CHART_BASE + encodeURIComponent(t) + '?interval=1d&range=1d' },
      yahooFetchOptions_()
    );
  });

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    unique.forEach(function (t) { result[t] = null; });
    return result;
  }

  for (var i = 0; i < unique.length; i++) {
    var t = unique[i];
    var data = null;
    try {
      var res = responses[i];
      if (res.getResponseCode() === 200) {
        var json = JSON.parse(res.getContentText());
        var chartResult = json.chart && json.chart.result && json.chart.result[0];
        var meta = chartResult && chartResult.meta;
        if (meta && typeof meta.regularMarketPrice === 'number') {
          data = {
            price: meta.regularMarketPrice,
            currency: meta.currency || '',
            name: meta.longName || meta.shortName || ''
          };
        }
      }
    } catch (e) {
      data = null;
    }
    result[t] = data;
  }
  return result;
}

function fetchHistoryFromYahoo_(yfTicker, startDate, endDate) {
  var period1 = Math.floor(startDate.getTime() / 1000);
  var endPlusOne = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
  var period2 = Math.floor(endPlusOne.getTime() / 1000);
  var url = YF_CHART_BASE + encodeURIComponent(yfTicker) +
    '?period1=' + period1 + '&period2=' + period2 + '&interval=1d';
  try {
    var res = UrlFetchApp.fetch(url, yahooFetchOptions_());
    if (res.getResponseCode() !== 200) return [];
    var json = JSON.parse(res.getContentText());
    var chartResult = json.chart && json.chart.result && json.chart.result[0];
    if (!chartResult) return [];
    var timestamps = chartResult.timestamp || [];
    var closes = (chartResult.indicators && chartResult.indicators.quote &&
      chartResult.indicators.quote[0] && chartResult.indicators.quote[0].close) || [];
    var rows = [];
    for (var i = 0; i < timestamps.length; i++) {
      if (closes[i] === null || closes[i] === undefined) continue;
      var d = new Date(timestamps[i] * 1000);
      rows.push({ date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'), close: Math.round(closes[i] * 100) / 100 });
    }
    return rows;
  } catch (e) {
    return [];
  }
}

// ------------------------------------------------------------------
// 価格キャッシュ (_prices シート)
// ------------------------------------------------------------------

function getCachedPrices_(yfTickers) {
  var sheet = getPriceSheet_();
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;
  var values = sheet.getRange(2, 1, lastRow - 1, PRICE_HEADERS.length).getValues();
  values.forEach(function (r) {
    var t = r[PCOL.YF_TICKER - 1];
    if (!t) return;
    var price = r[PCOL.PRICE - 1];
    map[t] = {
      price: (price === '' || price === null) ? null : Number(price),
      currency: r[PCOL.CURRENCY - 1] || ''
    };
  });
  return map;
}

function upsertPrices_(priceMap) {
  var sheet = getPriceSheet_();
  var lastRow = sheet.getLastRow();
  var existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  var rowIndex = {};
  existing.forEach(function (t, i) { rowIndex[t] = i + 2; });
  var now = new Date();

  Object.keys(priceMap).forEach(function (t) {
    var data = priceMap[t];
    var row = [t, data && typeof data.price === 'number' ? data.price : '', data ? data.currency : '', now];
    if (rowIndex[t]) {
      sheet.getRange(rowIndex[t], 1, 1, 4).setValues([row]);
    } else {
      var r = sheet.getLastRow() + 1;
      sheet.getRange(r, 1, 1, 4).setValues([row]);
      rowIndex[t] = r;
    }
  });
  SpreadsheetApp.flush();
}

// 保有中・取引履歴に登場する全銘柄の現在値を Yahoo Finance から再取得してキャッシュを更新する。
function refreshPrices() {
  var tickers = listAllTickers_();
  if (tickers.length) {
    var fetched = fetchCurrentPricesFromYahoo_(tickers);
    upsertPrices_(fetched);
  }
  return getStockSummary();
}

function listAllTickers_() {
  var sheet = getTxnSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, TCOL.YF_TICKER, lastRow - 1, 1).getValues();
  var seen = {};
  var out = [];
  values.forEach(function (r) {
    var t = r[0];
    if (t && !seen[t]) { seen[t] = true; out.push(t); }
  });
  return out;
}

// ------------------------------------------------------------------
// 日付・整形ユーティリティ
// ------------------------------------------------------------------

function parseDate_(str) {
  if (!str) return null;
  var parts = String(str).split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function formatDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, TZ, 'yyyy-MM-dd');
  }
  return String(value);
}

function pct_(base, current) {
  if (!base || current === null || current === undefined || isNaN(current)) return null;
  return Math.round((current - base) / base * 10000) / 100;
}

// ------------------------------------------------------------------
// 取引履歴 CRUD
// ------------------------------------------------------------------

function rowToTxn_(row) {
  return {
    id: row[TCOL.ID - 1],
    ticker: row[TCOL.TICKER - 1],
    yf_ticker: row[TCOL.YF_TICKER - 1],
    name: row[TCOL.NAME - 1],
    date: formatDate_(row[TCOL.DATE - 1]),
    side: row[TCOL.SIDE - 1],
    quantity: Number(row[TCOL.QUANTITY - 1]) || 0,
    price: Number(row[TCOL.PRICE - 1]) || 0,
    memo: row[TCOL.MEMO - 1] || '',
    created_at: formatDate_(row[TCOL.CREATED_AT - 1])
  };
}

function findTxnRow_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('取引が見つかりません: ' + id);
  var ids = sheet.getRange(2, TCOL.ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  throw new Error('取引が見つかりません: ' + id);
}

// 日付の新しい順(同日なら登録が新しい順)
function getTransactions() {
  var sheet = getTxnSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, TXN_HEADERS.length).getValues();
  var txns = values.map(rowToTxn_);
  txns.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.created_at < b.created_at ? 1 : -1;
  });
  return txns;
}

function addTransaction(data) {
  if (!data || !data.ticker || !data.date || !data.side || !data.quantity || !data.price) {
    throw new Error('証券コード・日付・区分・株数・単価は必須です');
  }
  if (data.side !== 'buy' && data.side !== 'sell') {
    throw new Error('区分は buy か sell を指定してください');
  }
  var yfTicker = normalizeTicker(data.ticker);
  var name = (data.name || '').trim();

  var cached = getCachedPrices_([yfTicker])[yfTicker];
  if (!cached || !name) {
    var fetched = fetchCurrentPricesFromYahoo_([yfTicker])[yfTicker];
    if (fetched) {
      var m = {};
      m[yfTicker] = fetched;
      upsertPrices_(m);
      if (!name) name = fetched.name || data.ticker;
    } else if (!name) {
      name = data.ticker;
    }
  }

  var sheet = getTxnSheet_();
  var id = Utilities.getUuid();
  var row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, TXN_HEADERS.length).setValues([[
    id, data.ticker, yfTicker, name, parseDate_(data.date), data.side,
    Number(data.quantity), Number(data.price), data.memo || '', new Date()
  ]]);
  sheet.getRange(row, TCOL.DATE).setNumberFormat('yyyy-mm-dd');
  SpreadsheetApp.flush();
  return getStockSummary();
}

function updateTransaction(id, data) {
  var sheet = getTxnSheet_();
  var row = findTxnRow_(sheet, id);
  data = data || {};

  if (data.ticker) {
    sheet.getRange(row, TCOL.TICKER).setValue(data.ticker);
    sheet.getRange(row, TCOL.YF_TICKER).setValue(normalizeTicker(data.ticker));
  }
  if (data.name) {
    sheet.getRange(row, TCOL.NAME).setValue(data.name);
  }
  if (data.date) {
    sheet.getRange(row, TCOL.DATE).setValue(parseDate_(data.date));
    sheet.getRange(row, TCOL.DATE).setNumberFormat('yyyy-mm-dd');
  }
  if (data.side === 'buy' || data.side === 'sell') {
    sheet.getRange(row, TCOL.SIDE).setValue(data.side);
  }
  if (data.quantity !== undefined && data.quantity !== '' && data.quantity !== null) {
    sheet.getRange(row, TCOL.QUANTITY).setValue(Number(data.quantity));
  }
  if (data.price !== undefined && data.price !== '' && data.price !== null) {
    sheet.getRange(row, TCOL.PRICE).setValue(Number(data.price));
  }
  if (data.memo !== undefined) {
    sheet.getRange(row, TCOL.MEMO).setValue(data.memo || '');
  }
  SpreadsheetApp.flush();
  return getStockSummary();
}

function deleteTransaction(id) {
  var sheet = getTxnSheet_();
  var row = findTxnRow_(sheet, id);
  sheet.deleteRow(row);
  return getStockSummary();
}

// ------------------------------------------------------------------
// 銘柄ごとの集計(平均取得単価方式)
// ------------------------------------------------------------------

function summarizeGroup_(g, priceData) {
  var buys = g.txns.filter(function (t) { return t.side === 'buy'; });
  var sells = g.txns.filter(function (t) { return t.side === 'sell'; });

  var totalBoughtQty = buys.reduce(function (s, t) { return s + t.quantity; }, 0);
  var totalBoughtCost = buys.reduce(function (s, t) { return s + t.quantity * t.price; }, 0);
  var avgBuyPrice = totalBoughtQty > 0 ? totalBoughtCost / totalBoughtQty : null;

  var totalSoldQty = sells.reduce(function (s, t) { return s + t.quantity; }, 0);
  var totalSoldProceeds = sells.reduce(function (s, t) { return s + t.quantity * t.price; }, 0);

  var netQuantity = Math.round((totalBoughtQty - totalSoldQty) * 1e6) / 1e6;
  var isHolding = netQuantity > 0.0001;

  var realizedPnl = (avgBuyPrice !== null && totalSoldQty > 0)
    ? totalSoldProceeds - avgBuyPrice * totalSoldQty
    : null;

  var currentPrice = priceData ? priceData.price : null;
  var currency = priceData ? priceData.currency : '';

  var referencePrice = null;
  var referenceLabel = null;
  if (isHolding && avgBuyPrice !== null) {
    referencePrice = avgBuyPrice;
    referenceLabel = 'avg_buy';
  } else if (sells.length > 0) {
    referencePrice = sells[0].price; // g.txns は日付降順なので sells[0] が直近の売却
    referenceLabel = 'last_sell';
  } else if (avgBuyPrice !== null) {
    referencePrice = avgBuyPrice;
    referenceLabel = 'avg_buy';
  }

  var changePct = (currentPrice !== null && referencePrice) ? pct_(referencePrice, currentPrice) : null;
  var dropAlert = changePct !== null && changePct <= DROP_ALERT_THRESHOLD;

  var marketValue = (isHolding && currentPrice !== null) ? currentPrice * netQuantity : null;
  var unrealizedPnl = (isHolding && currentPrice !== null && avgBuyPrice !== null)
    ? (currentPrice - avgBuyPrice) * netQuantity
    : null;

  var lastTxn = g.txns[0];
  var lastTxnChangePct = currentPrice !== null ? pct_(lastTxn.price, currentPrice) : null;

  return {
    ticker: g.ticker,
    yf_ticker: g.yf_ticker,
    name: g.name,
    net_quantity: netQuantity,
    is_holding: isHolding,
    avg_buy_price: avgBuyPrice,
    total_bought_qty: totalBoughtQty,
    total_sold_qty: totalSoldQty,
    realized_pnl: realizedPnl,
    current_price: currentPrice,
    currency: currency,
    market_value: marketValue,
    unrealized_pnl: unrealizedPnl,
    reference_price: referencePrice,
    reference_label: referenceLabel,
    change_pct: changePct,
    drop_alert: dropAlert,
    last_transaction: {
      date: lastTxn.date,
      side: lastTxn.side,
      price: lastTxn.price,
      quantity: lastTxn.quantity,
      change_pct: lastTxnChangePct
    },
    transaction_count: g.txns.length
  };
}

function getStockSummary() {
  var txns = getTransactions(); // 日付降順
  var groups = {};
  var order = [];
  txns.forEach(function (t) {
    if (!groups[t.yf_ticker]) {
      groups[t.yf_ticker] = { ticker: t.ticker, yf_ticker: t.yf_ticker, name: t.name, txns: [] };
      order.push(t.yf_ticker);
    }
    groups[t.yf_ticker].txns.push(t);
  });

  var prices = getCachedPrices_(order);
  var summaries = order.map(function (key) { return summarizeGroup_(groups[key], prices[key]); });

  // 下落アラートのある銘柄を先頭に、次に保有中、その中で下落率が大きい順
  summaries.sort(function (a, b) {
    if (a.drop_alert !== b.drop_alert) return a.drop_alert ? -1 : 1;
    if (a.is_holding !== b.is_holding) return a.is_holding ? -1 : 1;
    var ap = a.change_pct === null ? 999 : a.change_pct;
    var bp = b.change_pct === null ? 999 : b.change_pct;
    return ap - bp;
  });

  return summaries;
}

function getHistoryForTicker(yfTicker) {
  if (!yfTicker) throw new Error('yf_ticker は必須です');
  var txns = getTransactions().filter(function (t) { return t.yf_ticker === yfTicker; });
  if (!txns.length) throw new Error('取引が見つかりません: ' + yfTicker);
  var dates = txns.map(function (t) { return t.date; });
  var minDate = dates.reduce(function (a, b) { return a < b ? a : b; });
  var startDate = parseDate_(minDate);
  var endDate = new Date();
  var history = fetchHistoryFromYahoo_(yfTicker, startDate, endDate);
  return {
    yf_ticker: yfTicker,
    name: txns[0].name,
    history: history,
    transactions: txns.map(function (t) { return { date: t.date, side: t.side, price: t.price, quantity: t.quantity }; })
  };
}

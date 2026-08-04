/**
 * かぶトラッカー (GAS版)
 * データはこのスクリプトが紐付いた Google スプレッドシートに保存する。
 * 株価は Yahoo Finance の公開チャートAPI(UrlFetchApp経由)から取得する。
 * (GOOGLEFINANCE は東証銘柄で #N/A になる、または裸のティッカーが別銘柄に誤解決される
 *  ことを確認したため使用をやめた。)
 */

var STOCKS_SHEET = 'Stocks';
var TZ = 'Asia/Tokyo';
var YF_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
var PRICE_CACHE_TTL = 300; // 秒(refreshPrices はこのキャッシュを無視して強制取得する)

var COL = {
  ID: 1,
  TICKER: 2,
  GF_TICKER: 3,
  NAME: 4,
  QUANTITY: 5,
  BUY_PRICE: 6,
  BUY_DATE: 7,
  SELL_PRICE: 8,
  SELL_DATE: 9,
  MEMO: 10,
  CREATED_AT: 11,
  CURRENT_PRICE: 12
};

var HEADERS = [
  'id', 'ticker', 'gf_ticker', 'name', 'quantity', 'buy_price', 'buy_date',
  'sell_price', 'sell_date', 'memo', 'created_at', 'current_price'
];

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

// スクリプトプロパティに API_TOKEN を設定すると、一致する ?token=... が
// 無いリクエストを拒否するようになる(未設定の場合は誰でも呼び出せてしまうので
// 外部公開する場合は必ず設定すること)。
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
      case 'list':
        result = getStocks();
        break;
      case 'add':
        result = addStock({
          ticker: p.ticker,
          name: p.name,
          quantity: p.quantity,
          buy_price: p.buy_price,
          buy_date: p.buy_date,
          memo: p.memo
        });
        break;
      case 'sell':
        result = sellStock(p.id, p.sell_price, p.sell_date);
        break;
      case 'unsell':
        result = unsellStock(p.id);
        break;
      case 'update':
        result = updateStock(p.id, {
          quantity: p.quantity,
          buy_price: p.buy_price,
          buy_date: p.buy_date,
          sell_price: p.sell_price,
          sell_date: p.sell_date
        });
        break;
      case 'memo':
        result = updateMemo(p.id, p.memo);
        break;
      case 'delete':
        result = deleteStock(p.id);
        break;
      case 'history':
        result = getHistory(p.id);
        break;
      case 'refresh':
        result = refreshPrices();
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
  getStocksSheet_();
  return 'セットアップ完了';
}

function getStocksSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STOCKS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(STOCKS_SHEET);
  }
  if (sheet.getRange(1, 1).getValue() !== 'id') {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ------------------------------------------------------------------
// ティッカー正規化・Yahoo Finance ヘルパー
// ------------------------------------------------------------------

// 東証の3〜4桁(+英数字1桁)コードには ".T" を付与する(Yahoo Finance の形式)。
// 例: "7203" -> "7203.T", "166A" -> "166A.T", "AAPL" -> "AAPL"、
// 既に "." や ":" を含む場合(例: "7203.T", "NASDAQ:AAPL")はそのまま使う。
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

// 現在値(と可能であれば銘柄名)をまとめて取得する。1分程度はキャッシュを使う。
// 戻り値: { [ticker]: {price, currency, name} | null }
function fetchCurrentPrices_(tickers, bypassCache) {
  var unique = [];
  var seen = {};
  tickers.forEach(function (t) {
    if (t && !seen[t]) { seen[t] = true; unique.push(t); }
  });
  var result = {};
  if (!unique.length) return result;

  var cache = CacheService.getScriptCache();
  var toFetch = [];
  if (bypassCache) {
    toFetch = unique;
  } else {
    unique.forEach(function (t) {
      var cached = cache.get('price_' + t);
      if (cached) {
        result[t] = JSON.parse(cached);
      } else {
        toFetch.push(t);
      }
    });
  }
  if (!toFetch.length) return result;

  var requests = toFetch.map(function (t) {
    return Object.assign(
      { url: YF_CHART_BASE + encodeURIComponent(t) + '?interval=1d&range=1d' },
      yahooFetchOptions_()
    );
  });

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    toFetch.forEach(function (t) { result[t] = null; });
    return result;
  }

  for (var i = 0; i < toFetch.length; i++) {
    var t = toFetch[i];
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
    cache.put('price_' + t, JSON.stringify(data), PRICE_CACHE_TTL);
  }
  return result;
}

function fetchName_(yfTicker) {
  var data = fetchCurrentPrices_([yfTicker])[yfTicker];
  return (data && data.name) || '';
}

function fetchHistory_(yfTicker, startDate, endDate) {
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

function refreshPrices() {
  var sheet = getStocksSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var tickers = sheet.getRange(2, COL.GF_TICKER, lastRow - 1, 1).getValues()
      .map(function (r) { return String(r[0]); });
    var prices = fetchCurrentPrices_(tickers, true);
    for (var r = 2; r <= lastRow; r++) {
      var t = String(sheet.getRange(r, COL.GF_TICKER).getValue());
      var data = prices[t];
      sheet.getRange(r, COL.CURRENT_PRICE).setValue(data && typeof data.price === 'number' ? data.price : '');
    }
    SpreadsheetApp.flush();
  }
  return getStocks();
}

// ------------------------------------------------------------------
// 日付ユーティリティ
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

// ------------------------------------------------------------------
// 行 <-> オブジェクト 変換
// ------------------------------------------------------------------

function rowToObject_(row) {
  return {
    id: row[COL.ID - 1],
    ticker: row[COL.TICKER - 1],
    gf_ticker: row[COL.GF_TICKER - 1],
    name: row[COL.NAME - 1],
    quantity: Number(row[COL.QUANTITY - 1]) || 0,
    buy_price: Number(row[COL.BUY_PRICE - 1]) || 0,
    buy_date: formatDate_(row[COL.BUY_DATE - 1]),
    sell_price: row[COL.SELL_PRICE - 1] === '' || row[COL.SELL_PRICE - 1] === null ? null : Number(row[COL.SELL_PRICE - 1]),
    sell_date: formatDate_(row[COL.SELL_DATE - 1]),
    memo: row[COL.MEMO - 1] || '',
    created_at: formatDate_(row[COL.CREATED_AT - 1]),
    current_price: (row[COL.CURRENT_PRICE - 1] === '' || row[COL.CURRENT_PRICE - 1] === null || isNaN(row[COL.CURRENT_PRICE - 1]))
      ? null
      : Number(row[COL.CURRENT_PRICE - 1])
  };
}

function pct_(base, current) {
  if (!base || current === null || current === undefined || isNaN(current)) return null;
  return Math.round((current - base) / base * 10000) / 100;
}

function enrich_(stock) {
  var isSold = stock.sell_price !== null && stock.sell_price !== undefined;
  stock.is_sold = isSold;
  stock.status_label = isSold ? '売却済み' : '保有中';
  stock.change_from_buy_pct = stock.current_price !== null ? pct_(stock.buy_price, stock.current_price) : null;
  if (isSold) {
    stock.realized_pct = pct_(stock.buy_price, stock.sell_price);
    stock.change_since_sell_pct = stock.current_price !== null ? pct_(stock.sell_price, stock.current_price) : null;
  } else {
    stock.realized_pct = null;
    stock.change_since_sell_pct = null;
  }
  return stock;
}

function findRow_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('銘柄が見つかりません: ' + id);
  var ids = sheet.getRange(2, COL.ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  throw new Error('銘柄が見つかりません: ' + id);
}

// ------------------------------------------------------------------
// クライアントから呼び出す関数群 (google.script.run)
// ------------------------------------------------------------------

function getStocks() {
  var sheet = getStocksSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var stocks = values.map(rowToObject_).map(enrich_);
  // 保有中を先頭、購入日が新しい順
  stocks.sort(function (a, b) {
    if (a.is_sold !== b.is_sold) return a.is_sold ? 1 : -1;
    return a.buy_date < b.buy_date ? 1 : -1;
  });
  return stocks;
}

function addStock(data) {
  if (!data || !data.ticker || !data.buy_price || !data.buy_date) {
    throw new Error('証券コード・購入価格・購入日は必須です');
  }
  var yfTicker = normalizeTicker(data.ticker);
  var priceData = fetchCurrentPrices_([yfTicker])[yfTicker];
  var name = (data.name || '').trim();
  if (!name) {
    name = (priceData && priceData.name) || data.ticker;
  }
  var sheet = getStocksSheet_();
  var id = Utilities.getUuid();
  var quantity = Number(data.quantity) || 1;
  var buyPrice = Number(data.buy_price);
  var buyDate = parseDate_(data.buy_date);
  var now = new Date();
  var rowIndex = sheet.getLastRow() + 1;

  sheet.getRange(rowIndex, COL.ID, 1, 11).setValues([[
    id, data.ticker, yfTicker, name, quantity, buyPrice, buyDate, '', '', data.memo || '', now
  ]]);
  sheet.getRange(rowIndex, COL.BUY_DATE).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(rowIndex, COL.CURRENT_PRICE).setValue(
    priceData && typeof priceData.price === 'number' ? priceData.price : ''
  );
  SpreadsheetApp.flush();
  return getStocks();
}

// 証券会社の取引履歴CSVなどから作った複数件をまとめて登録する。
// lots: [{ ticker, name, quantity, buy_price, buy_date, sell_price, sell_date, memo }, ...]
// sell_price/sell_date は未売却なら null または省略でよい。
// Apps Script エディタで直接実行する想定(1回限りの取り込み用)。
function importLots(lots) {
  if (!lots || !lots.length) return getStocks();
  var sheet = getStocksSheet_();
  var now = new Date();
  var startRow = sheet.getLastRow() + 1;
  var rows = lots.map(function (lot) {
    var yfTicker = normalizeTicker(lot.ticker);
    var hasSell = lot.sell_price !== null && lot.sell_price !== undefined && lot.sell_price !== '';
    return [
      Utilities.getUuid(),
      lot.ticker,
      yfTicker,
      lot.name || lot.ticker,
      Number(lot.quantity) || 1,
      Number(lot.buy_price),
      parseDate_(lot.buy_date),
      hasSell ? Number(lot.sell_price) : '',
      hasSell && lot.sell_date ? parseDate_(lot.sell_date) : '',
      lot.memo || '',
      now
    ];
  });

  sheet.getRange(startRow, 1, rows.length, 11).setValues(rows);

  var tickers = rows.map(function (r) { return r[COL.GF_TICKER - 1]; });
  var prices = fetchCurrentPrices_(tickers, true);

  for (var i = 0; i < rows.length; i++) {
    var r = startRow + i;
    sheet.getRange(r, COL.BUY_DATE).setNumberFormat('yyyy-mm-dd');
    if (rows[i][COL.SELL_DATE - 1]) {
      sheet.getRange(r, COL.SELL_DATE).setNumberFormat('yyyy-mm-dd');
    }
    var data = prices[rows[i][COL.GF_TICKER - 1]];
    sheet.getRange(r, COL.CURRENT_PRICE).setValue(data && typeof data.price === 'number' ? data.price : '');
  }
  SpreadsheetApp.flush();
  return getStocks();
}

// normalizeTicker() のロジックが変わった際に、既存行の gf_ticker 列(B列の元の
// ティッカーから再計算)を最新の形式に一括で直すためのメンテナンス関数。
// Apps Script エディタから直接実行する想定。実行後は refreshPrices() を
// 呼ぶ(またはダッシュボードの更新ボタンを押す)と現在値が入り直る。
function resyncTickers() {
  var sheet = getStocksSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var count = 0;
  for (var r = 2; r <= lastRow; r++) {
    var raw = String(sheet.getRange(r, COL.TICKER).getValue());
    var newYfTicker = normalizeTicker(raw);
    var oldYfTicker = String(sheet.getRange(r, COL.GF_TICKER).getValue());
    if (oldYfTicker !== newYfTicker) {
      sheet.getRange(r, COL.GF_TICKER).setValue(newYfTicker);
      count++;
    }
  }
  SpreadsheetApp.flush();
  Logger.log('ティッカー再同期件数: ' + count);
  return count;
}

function sellStock(id, sellPrice, sellDate) {
  var sheet = getStocksSheet_();
  var row = findRow_(sheet, id);
  sheet.getRange(row, COL.SELL_PRICE).setValue(Number(sellPrice));
  sheet.getRange(row, COL.SELL_DATE).setValue(parseDate_(sellDate));
  sheet.getRange(row, COL.SELL_DATE).setNumberFormat('yyyy-mm-dd');
  SpreadsheetApp.flush();
  return getStocks();
}

function unsellStock(id) {
  var sheet = getStocksSheet_();
  var row = findRow_(sheet, id);
  sheet.getRange(row, COL.SELL_PRICE, 1, 2).clearContent();
  return getStocks();
}

function updateMemo(id, memo) {
  var sheet = getStocksSheet_();
  var row = findRow_(sheet, id);
  sheet.getRange(row, COL.MEMO).setValue(memo || '');
  return getStocks();
}

// 入力ミスの修正用。渡されたフィールドだけを更新する(未指定 or 空文字は変更しない)。
// data: { quantity, buy_price, buy_date, sell_price, sell_date }
function updateStock(id, data) {
  var sheet = getStocksSheet_();
  var row = findRow_(sheet, id);
  data = data || {};

  if (data.quantity !== undefined && data.quantity !== '' && data.quantity !== null) {
    sheet.getRange(row, COL.QUANTITY).setValue(Number(data.quantity));
  }
  if (data.buy_price !== undefined && data.buy_price !== '' && data.buy_price !== null) {
    sheet.getRange(row, COL.BUY_PRICE).setValue(Number(data.buy_price));
  }
  if (data.buy_date) {
    sheet.getRange(row, COL.BUY_DATE).setValue(parseDate_(data.buy_date));
    sheet.getRange(row, COL.BUY_DATE).setNumberFormat('yyyy-mm-dd');
  }
  if (data.sell_price !== undefined && data.sell_price !== '' && data.sell_price !== null) {
    sheet.getRange(row, COL.SELL_PRICE).setValue(Number(data.sell_price));
  }
  if (data.sell_date) {
    sheet.getRange(row, COL.SELL_DATE).setValue(parseDate_(data.sell_date));
    sheet.getRange(row, COL.SELL_DATE).setNumberFormat('yyyy-mm-dd');
  }

  SpreadsheetApp.flush();
  return getStocks();
}

function deleteStock(id) {
  var sheet = getStocksSheet_();
  var row = findRow_(sheet, id);
  sheet.deleteRow(row);
  return getStocks();
}

function getHistory(id) {
  var sheet = getStocksSheet_();
  var row = findRow_(sheet, id);
  var rowValues = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  var gfTicker = rowValues[COL.GF_TICKER - 1];
  var buyDate = rowValues[COL.BUY_DATE - 1];
  var sellDateRaw = rowValues[COL.SELL_DATE - 1];
  var endDate = (sellDateRaw && Object.prototype.toString.call(sellDateRaw) === '[object Date]')
    ? sellDateRaw
    : new Date();
  var history = fetchHistory_(gfTicker, buyDate, endDate);
  return {
    ticker: rowValues[COL.TICKER - 1],
    history: history,
    buy_price: Number(rowValues[COL.BUY_PRICE - 1]) || 0,
    sell_price: rowValues[COL.SELL_PRICE - 1] === '' ? null : Number(rowValues[COL.SELL_PRICE - 1])
  };
}

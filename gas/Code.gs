/**
 * かぶトラッカー (GAS版)
 * データはこのスクリプトが紐付いた Google スプレッドシートに保存する。
 * 株価は GOOGLEFINANCE 関数経由で取得する(API キー不要)。
 */

var STOCKS_SHEET = 'Stocks';
var SCRATCH_SHEET = '_scratch';
var TZ = 'Asia/Tokyo';

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
  var tmpl = HtmlService.createTemplateFromFile('Index');
  return tmpl
    .evaluate()
    .setTitle('かぶトラッカー')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ------------------------------------------------------------------
// 初期セットアップ
// ------------------------------------------------------------------

function setup() {
  getStocksSheet_();
  ensureScratchSheet_();
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

function ensureScratchSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SCRATCH_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SCRATCH_SHEET);
    sheet.hideSheet();
  }
  return sheet;
}

// ------------------------------------------------------------------
// ティッカー正規化・GOOGLEFINANCE ヘルパー
// ------------------------------------------------------------------

// 例: "7203" -> "TYO:7203" (東証), "AAPL" -> "AAPL", "TYO:7203" -> そのまま
function normalizeTicker(raw) {
  var t = String(raw).trim().toUpperCase();
  if (t.indexOf(':') !== -1) return t;
  if (/^\d{3,4}[A-Z0-9]?$/.test(t)) return 'TYO:' + t;
  return t;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function fetchName_(gfTicker) {
  return withLock_(function () {
    var sheet = ensureScratchSheet_();
    var cell = sheet.getRange('A1');
    var safe = gfTicker.replace(/"/g, '');
    cell.setFormula('=IFERROR(GOOGLEFINANCE("' + safe + '","name"),"")');
    SpreadsheetApp.flush();
    var value = cell.getValue();
    cell.clearContent();
    return value || '';
  });
}

function fetchHistory_(gfTicker, startDate, endDate) {
  return withLock_(function () {
    var sheet = ensureScratchSheet_();
    var scratchRange = sheet.getRange('A1:B3000');
    scratchRange.clearContent();
    var safe = gfTicker.replace(/"/g, '');
    var formula = '=IFERROR(GOOGLEFINANCE("' + safe + '","close",DATE(' +
      startDate.getFullYear() + ',' + (startDate.getMonth() + 1) + ',' + startDate.getDate() + '),DATE(' +
      endDate.getFullYear() + ',' + (endDate.getMonth() + 1) + ',' + endDate.getDate() + '),"DAILY"),"")';
    sheet.getRange('A1').setFormula(formula);
    SpreadsheetApp.flush();
    var values = scratchRange.getValues();
    scratchRange.clearContent();
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var d = values[i][0];
      var c = values[i][1];
      if (d === '' || d === null || d === undefined) continue;
      var dateStr = (Object.prototype.toString.call(d) === '[object Date]')
        ? Utilities.formatDate(d, TZ, 'yyyy-MM-dd')
        : String(d);
      rows.push({ date: dateStr, close: Number(c) });
    }
    return rows;
  });
}

function refreshPrices() {
  var sheet = getStocksSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    for (var r = 2; r <= lastRow; r++) {
      var gfTicker = sheet.getRange(r, COL.GF_TICKER).getValue();
      if (gfTicker) {
        // 同一の数式を再設定することで GOOGLEFINANCE の再取得を促す
        sheet.getRange(r, COL.CURRENT_PRICE).setFormula(
          '=IFERROR(GOOGLEFINANCE("' + String(gfTicker).replace(/"/g, '') + '"),"")'
        );
      }
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
  var gfTicker = normalizeTicker(data.ticker);
  var name = (data.name || '').trim();
  if (!name) {
    name = fetchName_(gfTicker) || data.ticker;
  }
  var sheet = getStocksSheet_();
  var id = Utilities.getUuid();
  var quantity = Number(data.quantity) || 1;
  var buyPrice = Number(data.buy_price);
  var buyDate = parseDate_(data.buy_date);
  var now = new Date();
  var rowIndex = sheet.getLastRow() + 1;

  sheet.getRange(rowIndex, COL.ID, 1, 11).setValues([[
    id, data.ticker, gfTicker, name, quantity, buyPrice, buyDate, '', '', data.memo || '', now
  ]]);
  sheet.getRange(rowIndex, COL.BUY_DATE).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(rowIndex, COL.CURRENT_PRICE).setFormula(
    '=IFERROR(GOOGLEFINANCE("' + gfTicker.replace(/"/g, '') + '"),"")'
  );
  SpreadsheetApp.flush();
  return getStocks();
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

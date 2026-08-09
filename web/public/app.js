var todayStr = new Date().toISOString().slice(0, 10);
document.querySelector('input[name="date"]').value = todayStr;

// --- GAS API 呼び出し ---

if (!window.KABU_CONFIG || !window.KABU_CONFIG.apiUrl) {
  document.getElementById('config-error').classList.remove('hidden');
  throw new Error('KABU_CONFIG.apiUrl が設定されていません');
}

function buildApiUrl(action, params) {
  var url = new URL(window.KABU_CONFIG.apiUrl);
  url.searchParams.set('action', action);
  if (window.KABU_CONFIG.token) {
    url.searchParams.set('token', window.KABU_CONFIG.token);
  }
  Object.keys(params || {}).forEach(function (k) {
    var v = params[k];
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  return url.toString();
}

function callApi(action, params) {
  return fetch(buildApiUrl(action, params))
    .then(function (res) { return res.json(); })
    .then(function (json) {
      if (!json.ok) throw new Error(json.error || 'APIエラー');
      return json.data;
    });
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt2(n) {
  return (n === null || n === undefined || isNaN(n)) ? '' : Number(n).toFixed(2);
}

function fmtYen(n) {
  if (n === null || n === undefined || isNaN(n)) return '―';
  var sign = n < 0 ? '-' : '';
  return sign + '¥' + Math.round(Math.abs(n)).toLocaleString('ja-JP');
}

function fmtYenSigned(n) {
  if (n === null || n === undefined || isNaN(n)) return '―';
  var sign = n > 0 ? '+' : (n < 0 ? '-' : '');
  return sign + '¥' + Math.round(Math.abs(n)).toLocaleString('ja-JP');
}

function chgClass(n) {
  return n > 0 ? 'up' : (n < 0 ? 'down' : '');
}

function chgHtml(pct) {
  if (pct === null || pct === undefined) return '―';
  var cls = chgClass(pct);
  var arrow = pct > 0 ? '▲' : (pct < 0 ? '▼' : '―');
  return '<span class="chg ' + cls + '">' + arrow + ' ' + pct.toFixed(2) + '%</span>';
}

function showLoading(v) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !v);
}

function setLastUpdated() {
  document.getElementById('last-updated').textContent = '最終更新: ' + new Date().toLocaleTimeString('ja-JP');
}

// --- タブ切り替え ---
document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.add('hidden'); });
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.remove('hidden');
  });
});

// --- 銘柄一覧 ---

var lastSummary = [];

function stockRowHtml(s) {
  var qtyText = s.is_holding ? (s.net_quantity.toLocaleString('ja-JP') + '株') : '保有なし';
  var avgBuyText = s.avg_buy_price !== null ? fmt2(s.avg_buy_price) : '―';
  var priceText = s.current_price !== null ? fmt2(s.current_price) : '取得失敗';
  var marketValueText = s.market_value !== null ? fmtYen(s.market_value) : '―';
  var unrealizedHtml = s.unrealized_pnl !== null
    ? '<span class="chg ' + chgClass(s.unrealized_pnl) + '">' + fmtYenSigned(s.unrealized_pnl) + '</span>'
    : '―';
  var realizedHtml = s.realized_pnl !== null
    ? '<span class="chg ' + chgClass(s.realized_pnl) + '">' + fmtYenSigned(s.realized_pnl) + '</span>'
    : '―';
  var refLabelText = s.reference_label === 'avg_buy' ? '平均取得単価比' : (s.reference_label === 'last_sell' ? '前回売却比' : '');
  var changeHtml = s.change_pct !== null
    ? '<div class="value-block">' + chgHtml(s.change_pct) + '<div class="hint">' + refLabelText + '</div></div>'
    : '―';
  var alertBadge = s.drop_alert ? '<div class="alert-badge">🔻買い時?</div>' : '';
  var lastTxn = s.last_transaction;
  var lastTxnHtml = lastTxn
    ? '<span class="side-badge ' + lastTxn.side + '">' + (lastTxn.side === 'buy' ? '購入' : '売却') + '</span> ' +
      lastTxn.date + '&nbsp;' + fmt2(lastTxn.price) + '円' +
      (lastTxn.change_pct !== null ? '<div class="hint left">' + chgHtml(lastTxn.change_pct) + ' 直近取引比</div>' : '')
    : '';

  return '' +
    '<tr class="' + (s.drop_alert ? 'is-alert' : '') + '">' +
      '<td class="col-name row-header">' +
        '<button type="button" class="link-btn chart-btn" data-yf-ticker="' + escapeHtml(s.yf_ticker) + '" data-name="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</button>' +
        '<div class="ticker-sub">' + escapeHtml(s.ticker) + '</div>' + alertBadge +
      '</td>' +
      '<td data-label="保有株数">' + qtyText + '</td>' +
      '<td data-label="取得単価">' + avgBuyText + '</td>' +
      '<td data-label="現在値">' + priceText + '</td>' +
      '<td data-label="評価額">' + marketValueText + '</td>' +
      '<td data-label="評価損益">' + unrealizedHtml + '</td>' +
      '<td data-label="実現損益">' + realizedHtml + '</td>' +
      '<td data-label="騰落">' + changeHtml + '</td>' +
      '<td class="col-name" data-label="直近の取引">' + lastTxnHtml + '</td>' +
    '</tr>';
}

// --- 並び順 ---

function cmpNum(a, b, dir) {
  var an = a === null || a === undefined || isNaN(a);
  var bn = b === null || b === undefined || isNaN(b);
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return dir * (a - b);
}

function sortStocks(list, mode) {
  var arr = list.slice();
  switch (mode) {
    case 'name':
      arr.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
      break;
    case 'change_asc':
      arr.sort(function (a, b) { return cmpNum(a.change_pct, b.change_pct, 1); });
      break;
    case 'change_desc':
      arr.sort(function (a, b) { return cmpNum(a.change_pct, b.change_pct, -1); });
      break;
    case 'pnl_desc':
      arr.sort(function (a, b) { return cmpNum(a.unrealized_pnl, b.unrealized_pnl, -1); });
      break;
    case 'pnl_asc':
      arr.sort(function (a, b) { return cmpNum(a.unrealized_pnl, b.unrealized_pnl, 1); });
      break;
    case 'qty_desc':
      arr.sort(function (a, b) { return cmpNum(a.net_quantity, b.net_quantity, -1); });
      break;
    case 'recent':
      arr.sort(function (a, b) {
        var ad = a.last_transaction ? a.last_transaction.date : '';
        var bd = b.last_transaction ? b.last_transaction.date : '';
        return bd.localeCompare(ad);
      });
      break;
    case 'alert':
    default:
      arr.sort(function (a, b) {
        if (a.drop_alert !== b.drop_alert) return a.drop_alert ? -1 : 1;
        if (a.is_holding !== b.is_holding) return a.is_holding ? -1 : 1;
        return cmpNum(a.change_pct, b.change_pct, 1);
      });
  }
  return arr;
}

(function () {
  try {
    var saved = localStorage.getItem('kabu_sort_mode');
    if (saved) document.getElementById('sort-select').value = saved;
  } catch (e) {}
})();

function renderStocks() {
  var holdingOnly = document.getElementById('holding-only-check').checked;
  var sortMode = document.getElementById('sort-select').value;
  var list = holdingOnly ? lastSummary.filter(function (s) { return s.is_holding; }) : lastSummary;
  list = sortStocks(list, sortMode);
  document.getElementById('stocks-count').textContent = lastSummary.length;
  document.getElementById('stocks-empty').classList.toggle('hidden', lastSummary.length > 0);
  document.getElementById('stocks-body').innerHTML = list.map(stockRowHtml).join('');
}

document.getElementById('holding-only-check').addEventListener('change', renderStocks);
document.getElementById('sort-select').addEventListener('change', function () {
  try { localStorage.setItem('kabu_sort_mode', this.value); } catch (e) {}
  renderStocks();
});

function renderSummaryCard() {
  var marketTotal = 0, unrealizedTotal = 0, realizedTotal = 0, alertCount = 0;
  var hasUnrealized = false, hasRealized = false;
  lastSummary.forEach(function (s) {
    if (s.market_value !== null) marketTotal += s.market_value;
    if (s.unrealized_pnl !== null) { unrealizedTotal += s.unrealized_pnl; hasUnrealized = true; }
    if (s.realized_pnl !== null) { realizedTotal += s.realized_pnl; hasRealized = true; }
    if (s.drop_alert) alertCount++;
  });
  document.getElementById('sum-market-value').textContent = fmtYen(marketTotal);
  document.getElementById('sum-alert-count').textContent = alertCount + '件';
  var unrealizedEl = document.getElementById('sum-unrealized');
  unrealizedEl.textContent = hasUnrealized ? fmtYenSigned(unrealizedTotal) : '¥0';
  unrealizedEl.className = 'value ' + (hasUnrealized ? chgClass(unrealizedTotal) : '');
  var realizedEl = document.getElementById('sum-realized');
  realizedEl.textContent = hasRealized ? fmtYenSigned(realizedTotal) : '¥0';
  realizedEl.className = 'value small ' + (hasRealized ? chgClass(realizedTotal) : '');
}

// --- 取引履歴 ---

var lastHistory = [];

function historyRowHtml(t) {
  var amount = t.quantity * t.price;
  var sideLabel = t.side === 'buy' ? '購入' : '売却';
  return '' +
    '<tr>' +
      '<td class="col-name row-header">' + escapeHtml(t.name) + '<div class="ticker-sub">' + escapeHtml(t.ticker) + '</div></td>' +
      '<td data-label="日付">' + t.date + '</td>' +
      '<td data-label="区分"><span class="side-badge ' + t.side + '">' + sideLabel + '</span></td>' +
      '<td data-label="株数">' + t.quantity.toLocaleString('ja-JP') + '株</td>' +
      '<td data-label="単価">' + fmt2(t.price) + '</td>' +
      '<td data-label="金額">' + fmtYen(amount) + '</td>' +
      '<td class="col-name" data-label="メモ">' + escapeHtml(t.memo) + '</td>' +
      '<td class="col-actions actions">' +
        '<details><summary class="btn small">編集</summary>' +
          '<form class="edit-txn-form" data-id="' + t.id + '">' +
            '<label class="edit-label">証券コード<input type="text" name="ticker" value="' + escapeHtml(t.ticker) + '"></label>' +
            '<label class="edit-label">銘柄名<input type="text" name="name" value="' + escapeHtml(t.name) + '"></label>' +
            '<label class="edit-label">区分<select name="side">' +
              '<option value="buy"' + (t.side === 'buy' ? ' selected' : '') + '>購入</option>' +
              '<option value="sell"' + (t.side === 'sell' ? ' selected' : '') + '>売却</option>' +
            '</select></label>' +
            '<label class="edit-label">株数<input type="number" name="quantity" value="' + t.quantity + '" step="1"></label>' +
            '<label class="edit-label">単価<input type="number" name="price" value="' + t.price + '" step="0.01"></label>' +
            '<label class="edit-label">日付<input type="date" name="date" value="' + t.date + '"></label>' +
            '<label class="edit-label">メモ<input type="text" name="memo" value="' + escapeHtml(t.memo) + '"></label>' +
            '<button type="submit" class="btn small primary">保存</button>' +
          '</form>' +
        '</details>' +
        '<button type="button" class="btn small danger delete-txn-btn" data-id="' + t.id + '">削除</button>' +
      '</td>' +
    '</tr>';
}

function renderHistory() {
  document.getElementById('history-count').textContent = lastHistory.length;
  document.getElementById('history-empty').classList.toggle('hidden', lastHistory.length > 0);
  document.getElementById('history-body').innerHTML = lastHistory.map(historyRowHtml).join('');
}

// --- 読み込み・エラー処理 ---

function onError(err) {
  showLoading(false);
  alert('エラー: ' + (err && err.message ? err.message : err));
}

function loadAll() {
  showLoading(true);
  Promise.all([callApi('summary'), callApi('transactions')])
    .then(function (results) {
      lastSummary = results[0];
      lastHistory = results[1];
      renderStocks();
      renderSummaryCard();
      renderHistory();
      setLastUpdated();
      showLoading(false);
    })
    .catch(onError);
}

function applySummary(summary) {
  lastSummary = summary;
  renderStocks();
  renderSummaryCard();
  setLastUpdated();
}

function reloadHistoryAnd(summaryPromise) {
  showLoading(true);
  summaryPromise
    .then(function (summary) {
      applySummary(summary);
      return callApi('transactions');
    })
    .then(function (txns) {
      lastHistory = txns;
      renderHistory();
      showLoading(false);
    })
    .catch(onError);
}

// --- 取引の追加・編集・削除 ---

document.getElementById('add-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var form = e.target;
  var data = {
    ticker: form.ticker.value,
    name: form.name.value,
    side: form.side.value,
    quantity: form.quantity.value,
    price: form.price.value,
    date: form.date.value,
    memo: form.memo.value
  };
  reloadHistoryAnd(callApi('add', data).then(function (summary) {
    form.reset();
    form.date.value = todayStr;
    form.quantity.value = 100;
    return summary;
  }));
});

document.getElementById('history-body').addEventListener('submit', function (e) {
  var form = e.target;
  if (!form.classList.contains('edit-txn-form')) return;
  e.preventDefault();
  var data = {
    id: form.dataset.id,
    ticker: form.ticker.value,
    name: form.name.value,
    side: form.side.value,
    quantity: form.quantity.value,
    price: form.price.value,
    date: form.date.value,
    memo: form.memo.value
  };
  reloadHistoryAnd(callApi('update', data));
});

document.getElementById('history-body').addEventListener('click', function (e) {
  var target = e.target;
  if (target.classList.contains('delete-txn-btn')) {
    if (confirm('この取引を削除しますか?')) {
      reloadHistoryAnd(callApi('delete', { id: target.dataset.id }));
    }
  }
});

document.getElementById('stocks-body').addEventListener('click', function (e) {
  var target = e.target;
  if (target.classList.contains('chart-btn')) {
    openChart(target.dataset.yfTicker, target.dataset.name);
  }
});

document.getElementById('refresh-btn').addEventListener('click', function () {
  showLoading(true);
  callApi('refresh').then(function (summary) {
    applySummary(summary);
    showLoading(false);
  }).catch(onError);
});

setInterval(function () {
  callApi('refresh').then(applySummary).catch(function () {});
}, 5 * 60 * 1000);

// --- チャートモーダル ---
var modal = document.getElementById('chart-modal');
var modalTitle = document.getElementById('modal-title');
document.getElementById('modal-close').addEventListener('click', function () {
  modal.classList.add('hidden');
});
modal.addEventListener('click', function (e) {
  if (e.target === modal) modal.classList.add('hidden');
});

var chartInstance = null;
function openChart(yfTicker, name) {
  modalTitle.textContent = name + ' の株価推移';
  modal.classList.remove('hidden');
  callApi('history', { yf_ticker: yfTicker }).then(function (data) {
    var labels = data.history.map(function (h) { return h.date; });
    var closes = data.history.map(function (h) { return h.close; });
    var ctx = document.getElementById('price-chart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '終値', data: closes, borderColor: '#1a56c4',
          backgroundColor: 'rgba(26,86,196,0.1)', tension: 0.2, pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxTicksLimit: 8 } } }
      }
    });
  }).catch(onError);
}

loadAll();

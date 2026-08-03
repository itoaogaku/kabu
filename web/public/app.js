var todayStr = new Date().toISOString().slice(0, 10);
document.querySelector('input[name="buy_date"]').value = todayStr;

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

function holdingRowHtml(s) {
  var priceKnown = s.current_price !== null;
  var price = priceKnown ? fmt2(s.current_price) : '取得失敗';
  var marketValue = priceKnown ? s.current_price * s.quantity : null;
  var costValue = s.buy_price * s.quantity;
  var pnl = priceKnown ? marketValue - costValue : null;
  return '' +
    '<tr>' +
      '<td class="col-name"><button type="button" class="link-btn chart-btn" data-id="' + s.id + '" data-name="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</button>' +
        '<div class="ticker-sub">' + escapeHtml(s.ticker) + '</div></td>' +
      '<td>' + s.quantity.toLocaleString('ja-JP') + '株</td>' +
      '<td>' + fmt2(s.buy_price) + '</td>' +
      '<td>' + s.buy_date + '</td>' +
      '<td>' + price + '</td>' +
      '<td>' + (marketValue !== null ? fmtYen(marketValue) : '―') + '</td>' +
      '<td>' + (pnl !== null ? '<span class="chg ' + chgClass(pnl) + '">' + fmtYenSigned(pnl) + '</span><div class="hint">' + chgHtml(s.change_from_buy_pct) + '</div>' : '―') + '</td>' +
      '<td class="col-name"><form class="memo-form" data-id="' + s.id + '"><input type="text" name="memo" value="' + escapeHtml(s.memo) + '" placeholder="メモ"><button type="submit" class="btn small">保存</button></form></td>' +
      '<td class="col-actions actions">' +
        '<details><summary class="btn small">売却記録</summary>' +
          '<form class="sell-form" data-id="' + s.id + '">' +
            '<input type="number" name="sell_price" step="0.01" placeholder="売却価格" required>' +
            '<input type="date" name="sell_date" value="' + todayStr + '" required>' +
            '<button type="submit" class="btn small primary">売却を記録</button>' +
          '</form>' +
        '</details>' +
        '<button type="button" class="btn small danger delete-btn" data-id="' + s.id + '">削除</button>' +
      '</td>' +
    '</tr>';
}

function soldRowHtml(s) {
  var price = s.current_price !== null ? fmt2(s.current_price) : '取得失敗';
  var realizedYen = (s.sell_price - s.buy_price) * s.quantity;
  var hint = '';
  if (s.change_since_sell_pct !== null) {
    var label = s.change_since_sell_pct > 0 ? '売却後も上昇中' : (s.change_since_sell_pct < 0 ? '売却後は下落' : '変動なし');
    hint = '<div class="hint">' + label + '</div>';
  }
  return '' +
    '<tr>' +
      '<td class="col-name"><button type="button" class="link-btn chart-btn" data-id="' + s.id + '" data-name="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</button>' +
        '<div class="ticker-sub">' + escapeHtml(s.ticker) + '</div></td>' +
      '<td>' + s.quantity.toLocaleString('ja-JP') + '株</td>' +
      '<td>' + fmt2(s.buy_price) + ' / ' + s.buy_date + '</td>' +
      '<td>' + fmt2(s.sell_price) + ' / ' + s.sell_date + '</td>' +
      '<td><span class="chg ' + chgClass(realizedYen) + '">' + fmtYenSigned(realizedYen) + '</span><div class="hint">' + chgHtml(s.realized_pct) + '</div></td>' +
      '<td>' + price + '</td>' +
      '<td>' + chgHtml(s.change_since_sell_pct) + hint + '</td>' +
      '<td class="col-name"><form class="memo-form" data-id="' + s.id + '"><input type="text" name="memo" value="' + escapeHtml(s.memo) + '" placeholder="メモ"><button type="submit" class="btn small">保存</button></form></td>' +
      '<td class="col-actions actions">' +
        '<button type="button" class="btn small unsell-btn" data-id="' + s.id + '">売却取消</button>' +
        '<button type="button" class="btn small danger delete-btn" data-id="' + s.id + '">削除</button>' +
      '</td>' +
    '</tr>';
}

function renderSummary(holding, sold) {
  var costTotal = 0;
  var marketTotal = 0;
  var marketKnown = false;
  holding.forEach(function (s) {
    costTotal += s.buy_price * s.quantity;
    if (s.current_price !== null) {
      marketTotal += s.current_price * s.quantity;
      marketKnown = true;
    }
  });
  var unrealized = marketKnown ? marketTotal - costTotal : null;
  var unrealizedPct = (marketKnown && costTotal) ? Math.round(unrealized / costTotal * 10000) / 100 : null;

  var realizedTotal = 0;
  sold.forEach(function (s) {
    realizedTotal += (s.sell_price - s.buy_price) * s.quantity;
  });

  document.getElementById('sum-market-value').textContent = marketKnown ? fmtYen(marketTotal) : '取得中…';
  document.getElementById('sum-cost-value').textContent = fmtYen(costTotal);

  var unrealizedEl = document.getElementById('sum-unrealized');
  unrealizedEl.textContent = unrealized !== null
    ? fmtYenSigned(unrealized) + ' (' + (unrealizedPct > 0 ? '+' : '') + unrealizedPct.toFixed(2) + '%)'
    : '―';
  unrealizedEl.className = 'value ' + (unrealized !== null ? chgClass(unrealized) : '');

  var realizedEl = document.getElementById('sum-realized');
  realizedEl.textContent = fmtYenSigned(realizedTotal);
  realizedEl.className = 'value small ' + chgClass(realizedTotal);
}

function render(stocks) {
  var holding = stocks.filter(function (s) { return !s.is_sold; });
  var sold = stocks.filter(function (s) { return s.is_sold; });

  document.getElementById('holding-count').textContent = holding.length;
  document.getElementById('sold-count').textContent = sold.length;
  document.getElementById('holding-empty').classList.toggle('hidden', holding.length > 0);
  document.getElementById('sold-empty').classList.toggle('hidden', sold.length > 0);

  document.getElementById('holding-body').innerHTML = holding.map(holdingRowHtml).join('');
  document.getElementById('sold-body').innerHTML = sold.map(soldRowHtml).join('');

  renderSummary(holding, sold);

  setLastUpdated();
  showLoading(false);
}

function onError(err) {
  showLoading(false);
  alert('エラー: ' + (err && err.message ? err.message : err));
}

function loadStocks() {
  showLoading(true);
  callApi('list').then(render).catch(onError);
}

document.getElementById('add-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var form = e.target;
  var data = {
    ticker: form.ticker.value,
    name: form.name.value,
    quantity: form.quantity.value,
    buy_price: form.buy_price.value,
    buy_date: form.buy_date.value,
    memo: form.memo.value
  };
  showLoading(true);
  callApi('add', data).then(function (stocks) {
    form.reset();
    form.buy_date.value = todayStr;
    form.quantity.value = 100;
    render(stocks);
  }).catch(onError);
});

function handleTableSubmit(e) {
  var form = e.target;
  if (form.classList.contains('memo-form')) {
    e.preventDefault();
    showLoading(true);
    callApi('memo', { id: form.dataset.id, memo: form.memo.value }).then(render).catch(onError);
  } else if (form.classList.contains('sell-form')) {
    e.preventDefault();
    showLoading(true);
    callApi('sell', { id: form.dataset.id, sell_price: form.sell_price.value, sell_date: form.sell_date.value })
      .then(render).catch(onError);
  }
}

function handleTableClick(e) {
  var target = e.target;
  if (target.classList.contains('chart-btn')) {
    openChart(target.dataset.id, target.dataset.name);
  } else if (target.classList.contains('delete-btn')) {
    if (confirm('削除しますか?')) {
      showLoading(true);
      callApi('delete', { id: target.dataset.id }).then(render).catch(onError);
    }
  } else if (target.classList.contains('unsell-btn')) {
    showLoading(true);
    callApi('unsell', { id: target.dataset.id }).then(render).catch(onError);
  }
}

document.getElementById('holding-body').addEventListener('submit', handleTableSubmit);
document.getElementById('sold-body').addEventListener('submit', handleTableSubmit);
document.getElementById('holding-body').addEventListener('click', handleTableClick);
document.getElementById('sold-body').addEventListener('click', handleTableClick);

document.getElementById('refresh-btn').addEventListener('click', function () {
  showLoading(true);
  callApi('refresh').then(render).catch(onError);
});

setInterval(function () {
  callApi('refresh').then(render).catch(function () {});
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
function openChart(id, name) {
  modalTitle.textContent = name + ' の株価推移';
  modal.classList.remove('hidden');
  callApi('history', { id: id }).then(function (data) {
    var labels = data.history.map(function (h) { return h.date; });
    var closes = data.history.map(function (h) { return h.close; });
    var ctx = document.getElementById('price-chart').getContext('2d');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '終値', data: closes, borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.1)', tension: 0.2, pointRadius: 0
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

loadStocks();

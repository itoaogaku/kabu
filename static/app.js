const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5分ごとに自動更新

function setLastUpdated() {
  const el = document.getElementById("last-updated");
  const now = new Date();
  el.textContent = "最終更新: " + now.toLocaleTimeString("ja-JP");
}

async function refreshPrices() {
  try {
    await fetch("/api/refresh", { method: "POST" });
    location.reload();
  } catch (e) {
    console.error("価格更新に失敗しました", e);
  }
}

document.getElementById("refresh-btn").addEventListener("click", refreshPrices);
setLastUpdated();
setInterval(refreshPrices, AUTO_REFRESH_MS);

// --- タブ切り替え ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.tab).classList.remove("hidden");
  });
});

// --- チャートモーダル ---
const modal = document.getElementById("chart-modal");
const modalTitle = document.getElementById("modal-title");
const modalClose = document.getElementById("modal-close");
let chartInstance = null;

modalClose.addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

document.querySelectorAll(".chart-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const id = btn.dataset.id;
    const name = btn.dataset.name;
    modalTitle.textContent = name + " の株価推移";
    modal.classList.remove("hidden");

    const res = await fetch(`/api/history/${id}`);
    const data = await res.json();
    const labels = data.history.map((h) => h.date);
    const closes = data.history.map((h) => h.close);

    const ctx = document.getElementById("price-chart").getContext("2d");
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "終値",
            data: closes,
            borderColor: "#1a56c4",
            backgroundColor: "rgba(26,86,196,0.1)",
            tension: 0.2,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { maxTicksLimit: 8 } } },
      },
    });
  });
});

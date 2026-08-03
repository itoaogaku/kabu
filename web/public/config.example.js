// ローカルで動作確認する場合はこのファイルを config.js としてコピーし、値を書き換える。
// Vercel 上では build.js が環境変数から自動生成するため、config.js はコミットしない。
window.KABU_CONFIG = {
  apiUrl: "https://script.google.com/macros/s/xxxxxxxxxxxxxxxx/exec",
  token: "your-api-token"
};

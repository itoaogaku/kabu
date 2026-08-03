// Vercel のビルド時に環境変数から public/config.js を生成する。
// GAS_API_URL / GAS_API_TOKEN はリポジトリにコミットせず、Vercel の
// プロジェクト設定 (Environment Variables) に登録すること。
const fs = require('fs');
const path = require('path');

const apiUrl = process.env.GAS_API_URL || '';
const token = process.env.GAS_API_TOKEN || '';

if (!apiUrl) {
  console.warn('警告: 環境変数 GAS_API_URL が設定されていません。Vercel のプロジェクト設定で追加してください。');
}

const content =
  'window.KABU_CONFIG = ' + JSON.stringify({ apiUrl: apiUrl, token: token }) + ';\n';

fs.writeFileSync(path.join(__dirname, 'public', 'config.js'), content);
console.log('public/config.js を生成しました');

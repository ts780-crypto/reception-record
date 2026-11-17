// Firebase Realtime Database REST API エンドポイント
const DB_URL = "https://nf-reception-default-rtdb.asia-southeast1.firebasedatabase.app/moneyLogs";
// 削除不可の履歴アーカイブ用URL
const HISTORY_DB_URL = "https://nf-reception-default-rtdb.asia-southeast1.firebasedatabase.app/moneyLogsHistory";

// 入力画面のパスワード設定
const APP_PASSWORD = "nf2026";

// 定数・変数（PayPayラベル付きプリセットに対応）
const DEFAULT_PRESETS = [
  250,
  { label: "PayPay", amount: 250 },
  200,
  100
];

let remoteLogs = [];   // Firebaseから同期されたデータ
let pendingLogs = [];  // ローカル（localStorage）にある未送信データ
let presetAmounts = [...DEFAULT_PRESETS];
let eventSource = null; // リアルタイム通信オブジェクト
let isSyncing = false;  // 二重送信防止ロックフラグ

window.onload = function() {
  checkAuthStatus();
  
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW Error:', err));
  }

  const savedName = localStorage.getItem('savedUserName');
  if (savedName) document.getElementById('userName').value = savedName;

  loadPresets();
  renderButtons();

  loadPendingLogs();
  loadCachedRemoteLogs();
  renderData();

  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);

  initRealtimeStream();
};

// --- 認証機能 ---
function checkAuthStatus() {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;

  if (sessionStorage.getItem('nf_authenticated') === 'true') {
    overlay.style.display = 'none';
  } else {
    overlay.style.display = 'flex';
  }
}

function authenticate(event) {
  if (event) event.preventDefault();

  const input = document.getElementById('passInput').value;
  const errorMsg = document.getElementById('authError');

  if (input === APP_PASSWORD) {
    sessionStorage.setItem('nf_authenticated', 'true');
    document.getElementById('authOverlay').style.display = 'none';
    if (errorMsg) errorMsg.style.display = 'none';
  } else {
    if (errorMsg) errorMsg.style.display = 'block';
  }
}

// --- ローカルキャッシュ操作 ---
function loadCachedRemoteLogs() {
  const cached = localStorage.getItem('nf_cached_remote_logs');
  if (cached) {
    try { remoteLogs = JSON.parse(cached); } catch (e) { console.error("キャッシュ読み込みエラー", e); }
  }
}

function saveCachedRemoteLogs() {
  localStorage.setItem('nf_cached_remote_logs', JSON.stringify(remoteLogs));
}

// --- 金額プリセット機能 ---
function loadPresets() {
  const saved = localStorage.getItem('nf_preset_amounts');
  if (saved) {
    try { presetAmounts = JSON.parse(saved); } catch (e) { console.error("プリセット読み込みエラー", e); }
  }
}

function renderButtons() {
  const grid = document.getElementById('btnGrid');
  if (!grid) return;
  
  const fragment = document.createDocumentFragment();
  presetAmounts.forEach(item => {
    const isObj = typeof item === 'object' && item !== null;
    const amount = isObj ? Number(item.amount) : Number(item);
    const labelText = isObj && item.label ? `${item.label} ` : '';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-input';
    btn.innerHTML = `${labelText}${amount}<span class="btn-unit">円</span>`;
    btn.onclick = () => recordLog(amount, isObj ? item.label : '');
    fragment.appendChild(btn);
  });

  grid.innerHTML = '';
  grid.appendChild(fragment);
}

function toggleSettings() {
  const panel = document.getElementById('settingsPanel');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';

  if (isHidden) {
    const getVal = (item) => (typeof item === 'object' && item !== null) ? item.amount : item;
    document.getElementById('preset1').value = getVal(presetAmounts[0]) || '';
    document.getElementById('preset2').value = getVal(presetAmounts[1]) || '';
    document.getElementById('preset3').value = getVal(presetAmounts[2]) || '';
    document.getElementById('preset4').value = getVal(presetAmounts[3]) || '';
  }
}

function savePresets() {
  const vals = [
    Number(document.getElementById('preset1').value) || 0,
    Number(document.getElementById('preset2').value) || 0,
    Number(document.getElementById('preset3').value) || 0,
    Number(document.getElementById('preset4').value) || 0
  ];

  presetAmounts = vals.map((val, idx) => {
    const orig = presetAmounts[idx];
    if (typeof orig === 'object' && orig !== null && orig.label) {
      return { label: orig.label, amount: val };
    }
    return val;
  });

  localStorage.setItem('nf_preset_amounts', JSON.stringify(presetAmounts));
  renderButtons();
  toggleSettings();
}

function resetPresets() {
  if (confirm('金額ボタンを初期設定（250円・PayPay 250円・200円・100円）に戻しますか？')) {
    presetAmounts = [...DEFAULT_PRESETS];
    localStorage.removeItem('nf_preset_amounts');
    renderButtons();
    toggleSettings();
  }
}

// --- REST API リアルタイム監視 (EventSource) ---
function initRealtimeStream() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`${DB_URL}.json`);

  eventSource.onopen = () => updateNetworkStatus();

  eventSource.addEventListener('put', (e) => {
    updateNetworkStatus();
    const res = JSON.parse(e.data);
    if (!res) return;

    if (res.path === '/') {
      const rawData = res.data || {};
      remoteLogs = Object.keys(rawData).map(key => ({ key, ...rawData[key] }));
    } else {
      const key = res.path.split('/')[1];
      if (res.data === null) {
        remoteLogs = remoteLogs.filter(item => item.key !== key);
      } else {
        const index = remoteLogs.findIndex(item => item.key === key);
        if (index > -1) {
          remoteLogs[index] = { key, ...res.data };
        } else {
          remoteLogs.push({ key, ...res.data });
        }
      }
    }
    
    saveCachedRemoteLogs();
    renderData();
  });

  eventSource.onerror = (err) => {
    console.warn("リアルタイム接続切断。再接続を待機中...", err);
    updateNetworkStatus();
  };
}

// --- ローカルキュー (localStorage) ---
function loadPendingLogs() {
  const stored = localStorage.getItem('nf_pending_logs');
  pendingLogs = stored ? JSON.parse(stored) : [];
}

function savePendingLogs() {
  localStorage.setItem('nf_pending_logs', JSON.stringify(pendingLogs));
}

// --- ネットワーク状態＆自動同期処理 ---
function updateNetworkStatus() {
  const statusBadge = document.getElementById('netStatus');
  const statusText = document.getElementById('netStatusText');
  if (!statusBadge || !statusText) return;

  if (!navigator.onLine) {
    statusBadge.className = "net-badge offline";
    statusText.textContent = "オフライン";
  } else if (eventSource && eventSource.readyState === EventSource.OPEN) {
    statusBadge.className = "net-badge online";
    statusText.textContent = "オンライン";
    syncPendingLogs();
  } else {
    statusBadge.className = "net-badge offline";
    statusText.textContent = "接続中...";
  }
  renderData();
}

// モバイル端末対応：排他制御（ロック）付き一括同期＆確実な履歴保存
async function syncPendingLogs() {
  if (!navigator.onLine || pendingLogs.length === 0 || isSyncing) return;

  isSyncing = true;

  try {
    const itemsToSync = [...pendingLogs];
    for (const item of itemsToSync) {
      const payload = {
        id: String(item.id),
        date: String(item.date),
        amount: Number(item.amount),
        user: String(item.user || "未設定"),
        timestamp: Number(item.timestamp || Date.now())
      };

      // 1. メイン領域へ送信
      const res = await fetch(`${DB_URL}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const resData = await res.json();

      // 2. 削除不可能な履歴アーカイブへ確実に同期
      try {
        await fetch(`${HISTORY_DB_URL}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (historyErr) {
        console.error("履歴アーカイブ送信エラー:", historyErr);
      }

      if (resData && resData.name) {
        if (!remoteLogs.some(r => r.key === resData.name)) {
          remoteLogs.push({
            key: resData.name,
            ...payload
          });
        }
      }

      pendingLogs = pendingLogs.filter(p => p.id !== item.id);
      savePendingLogs();
    }
  } catch (err) {
    console.error("送信エラー:", err);
  } finally {
    isSyncing = false;
    saveCachedRemoteLogs();
    renderData();
  }
}

// --- 記録処理 ---
function recordLog(amount, paymentMethod = '') {
  const baseUser = document.getElementById('userName').value || "未設定";
  const userName = paymentMethod ? `${baseUser} (${paymentMethod})` : baseUser;

  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const logItem = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    date: dateStr,
    amount: Number(amount),
    user: userName,
    timestamp: Date.now()
  };

  pendingLogs.push(logItem);
  savePendingLogs();
  renderData();

  if (navigator.onLine) {
    syncPendingLogs();
  }
}

// --- 高速画面描画（DocumentFragment 使用） ---
function renderData() {
  const tbody = document.getElementById('logTableBody');
  if (!tbody) return;

  const remoteIds = new Set(remoteLogs.map(r => r.id).filter(Boolean));
  const activePendingLogs = pendingLogs.filter(p => !remoteIds.has(p.id));
  const allLogs = [...remoteLogs, ...activePendingLogs.map(p => ({ ...p, isPending: true }))];

  const count = allLogs.length;
  const sum = allLogs.reduce((total, item) => total + Number(item.amount || 0), 0);

  document.getElementById('totalCount').innerHTML = `${count} <span class="unit">件</span>`;
  document.getElementById('totalAmount').innerHTML = `${sum.toLocaleString()} <span class="unit">円</span>`;

  const syncInfo = document.getElementById('syncInfo');
  if (syncInfo) {
    if (!navigator.onLine && activePendingLogs.length > 0) {
      syncInfo.textContent = `未送信: ${activePendingLogs.length}件`;
      syncInfo.style.color = 'var(--cancel-text)';
    } else {
      syncInfo.textContent = "全データ同期完了";
      syncInfo.style.color = 'var(--text-sub)';
    }
  }

  const fragment = document.createDocumentFragment();
  const logsToRender = allLogs.slice().reverse();

  logsToRender.forEach(item => {
    const tr = document.createElement('tr');
    
    const tdDate = document.createElement('td');
    tdDate.textContent = item.date;
    
    const tdAmount = document.createElement('td');
    tdAmount.textContent = item.amount;

    const tdUser = document.createElement('td');
    tdUser.textContent = item.user || "未設定";

    if (item.isPending && !navigator.onLine) {
      const tag = document.createElement('span');
      tag.className = 'pending-tag';
      tag.textContent = '未送信';
      tdUser.appendChild(tag);
    }

    tr.appendChild(tdDate);
    tr.appendChild(tdAmount);
    tr.appendChild(tdUser);
    fragment.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);
}

// --- 操作機能 ---
async function deleteLastLog() {
  const baseUser = document.getElementById('userName').value || "未設定";
  const isMyRecord = (recordUser) => {
    const u = recordUser || "未設定";
    return u === baseUser || u.startsWith(`${baseUser} (`);
  };

  const remoteIds = new Set(remoteLogs.map(r => r.id).filter(Boolean));
  const activePendingLogs = pendingLogs.filter(p => !remoteIds.has(p.id));

  const myPendingLogs = activePendingLogs.filter(p => isMyRecord(p.user));
  if (myPendingLogs.length > 0) {
    const lastPending = myPendingLogs[myPendingLogs.length - 1];
    if (confirm(`【未送信データ】${baseUser}さんの直近の記録を取り消しますか？\n・金額: ${lastPending.amount}円`)) {
      pendingLogs = pendingLogs.filter(p => p.id !== lastPending.id);
      savePendingLogs();
      renderData();
    }
    return;
  }

  const myRemoteLogs = remoteLogs.filter(r => isMyRecord(r.user));
  if (myRemoteLogs.length > 0) {
    const lastLog = myRemoteLogs[myRemoteLogs.length - 1];
    if (confirm(`【${baseUser}さんの直近の記録】を取り消しますか？\n・日時: ${lastLog.date}\n・金額: ${lastLog.amount}円`)) {
      try {
        await fetch(`${DB_URL}/${lastLog.key}.json`, { method: 'DELETE' });
      } catch (err) {
        alert("削除に失敗しました: " + err.message);
      }
    }
    return;
  }

  alert(`${baseUser}さんの削除可能なデータがありません`);
}

function downloadCSV() {
  const remoteIds = new Set(remoteLogs.map(r => r.id).filter(Boolean));
  const activePendingLogs = pendingLogs.filter(p => !remoteIds.has(p.id));
  const allLogs = [...remoteLogs, ...activePendingLogs];

  if (allLogs.length === 0) {
    alert('データがありません');
    return;
  }

  let csvContent = '\uFEFF日時,金額,担当者,ステータス\n';
  allLogs.forEach(item => {
    const status = activePendingLogs.some(p => p.id === item.id) ? '未送信' : '同期済';
    csvContent += `"${item.date}",${item.amount},"${item.user || ''}","${status}"\n`;
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '共有金額記録.csv';
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteAllLogs() {
  if (confirm('全員の共有記録およびローカルの未送信データをすべて削除しますか？\n※元に戻せません。NF期間中は絶対に消さないでください')) {
    pendingLogs = [];
    remoteLogs = [];
    savePendingLogs();
    saveCachedRemoteLogs();
    try {
      await fetch(`${DB_URL}.json`, { method: 'DELETE' });
    } catch (err) {
      alert("全削除に失敗しました: " + err.message);
    }
  }
}

window.記録 = recordLog;
window.直近1件削除 = deleteLastLog;
window.csvダウンロード = downloadCSV;
window.データ全削除 = deleteAllLogs;
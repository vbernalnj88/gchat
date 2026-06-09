/**
 * popup.js — GG Chat Tracker Popup Logic
 *
 * Single-file SPA managing three views:
 *   main     → stats + sync + profile list + paste-import tab
 *   profile  → editable fields + full chat history
 *   settings → export / import JSON / clear all
 */

'use strict';

// ============================================================
// STATE
// ============================================================

const S = {
  view:          'main',      // 'main' | 'profile' | 'settings'
  tab:           'profiles',  // 'profiles' | 'import'
  profiles:      {},
  stats:         {},
  selectedUser:  null,
  query:         '',
  syncing:       false,
};

// ============================================================
// DOM HELPERS
// ============================================================

const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    // Show full or short depending on age
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000)       return 'just now';
    if (diff < 3_600_000)    return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000)   return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(ts); }
}

function fmtTs(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return String(ts); }
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function toast(msg, type = '') {
  const tc   = $('#toast-container');
  const el   = document.createElement('div');
  el.className = `toast${type ? ' toast-' + type : ''}`;
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

// ============================================================
// BACKGROUND MESSAGING
// ============================================================

function bgMsg(payload) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(payload, res => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

async function tabMsg(payload) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, payload, res => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res);
      });
    });
  } catch { return null; }
}

// ============================================================
// DATA LOADING
// ============================================================

async function loadData() {
  const [pr, sr] = await Promise.all([
    bgMsg({ type: 'GET_PROFILES' }),
    bgMsg({ type: 'GET_STATS' }),
  ]);
  S.profiles = pr?.profiles ?? {};
  S.stats    = sr?.stats    ?? {};
}

// ============================================================
// NAVIGATION
// ============================================================

function nav(viewName) {
  S.view = viewName;
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${viewName}`)?.classList.remove('hidden');

  const backBtn     = $('#btn-back');
  const title       = $('#hdr-title');
  const settingsBtn = $('#btn-settings');

  if (viewName === 'main') {
    backBtn.classList.add('hidden');
    title.textContent = 'GG Chat Tracker';
    settingsBtn.classList.remove('hidden');
  } else if (viewName === 'profile') {
    backBtn.classList.remove('hidden');
    title.textContent = S.selectedUser ?? 'Profile';
    settingsBtn.classList.add('hidden');
  } else if (viewName === 'settings') {
    backBtn.classList.remove('hidden');
    title.textContent = 'Settings';
    settingsBtn.classList.add('hidden');
  }
}

function switchTab(tabName) {
  S.tab = tabName;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.tab-content').forEach(c => c.classList.add('hidden'));
  $(`#tab-${tabName}`)?.classList.remove('hidden');
}

// ============================================================
// MAIN VIEW — STATS
// ============================================================

function renderStats() {
  const count = Object.keys(S.profiles).length;
  const msgs  = S.stats.totalMessages ?? 0;
  const last  = S.stats.lastSync;

  $('#sp-profiles').textContent = `${count} profile${count !== 1 ? 's' : ''}`;
  $('#sp-messages').textContent = `${msgs} msg${msgs !== 1 ? 's' : ''}`;
  $('#sp-sync').textContent     = last ? `synced ${fmtDate(last)}` : 'never synced';
}

// ============================================================
// MAIN VIEW — PROFILE LIST
// ============================================================

function filteredProfiles() {
  const q = S.query.toLowerCase().trim();
  let entries = Object.values(S.profiles);

  if (q) {
    entries = entries.filter(p =>
      p.username.toLowerCase().includes(q) ||
      (p.aliases ?? []).some(a => a.toLowerCase().includes(q)) ||
      (p.notes    ?? '').toLowerCase().includes(q) ||
      (p.kinks    ?? '').toLowerCase().includes(q) ||
      (p.traits   ?? '').toLowerCase().includes(q) ||
      (p.position ?? '').toLowerCase().includes(q) ||
      p.history.some(h => (h.message ?? '').toLowerCase().includes(q))
    );
  }

  // Sort: starred first, then by lastSeen descending
  entries.sort((a, b) => {
    if (a.starred && !b.starred) return -1;
    if (!a.starred && b.starred) return  1;
    return new Date(b.lastSeen ?? 0) - new Date(a.lastSeen ?? 0);
  });

  return entries;
}

function renderProfileList() {
  const list    = $('#profile-list');
  const empty   = $('#empty-state');
  const entries = filteredProfiles();

  if (entries.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Build HTML string for performance
  list.innerHTML = entries.map(p => {
    const init    = escHtml((p.avatarInitial || p.username.charAt(0)).toUpperCase());
    const lastMsg = p.history.length > 0
      ? p.history[p.history.length - 1].message
      : '—';
    const preview = lastMsg.length > 55 ? lastMsg.slice(0, 55) + '…' : lastMsg;
    const badges  = [
      p.position && `<span class="tag">${escHtml(p.position)}</span>`,
    ].filter(Boolean).join('');

    return `
      <div class="profile-card${p.starred ? ' starred' : ''}"
           data-user="${escHtml(p.username)}" role="button" tabindex="0">
        <div class="p-avatar">${init}</div>
        <div class="p-info">
          <div class="p-name">${escHtml(p.username)}${badges}</div>
          <div class="p-preview">${escHtml(preview)}</div>
          <div class="p-meta">${p.messageCount ?? 0} msgs · ${fmtDate(p.lastSeen)}</div>
        </div>
        <button class="btn-del" data-del="${escHtml(p.username)}"
                title="Delete profile" aria-label="Delete ${escHtml(p.username)}">✕</button>
      </div>`;
  }).join('');

  // Event delegation
  list.querySelectorAll('.profile-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.btn-del')) return;
      openProfile(card.dataset.user);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter') openProfile(card.dataset.user);
    });
  });

  list.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const user = btn.dataset.del;
      if (!confirm(`Delete all data for "${user}"?\nThis cannot be undone.`)) return;
      await bgMsg({ type: 'DELETE_PROFILE', payload: { username: user } });
      await loadData();
      renderMain();
      toast(`Deleted ${user}`, 'warn');
    });
  });
}

function renderMain() {
  renderStats();
  renderProfileList();
}

// ============================================================
// PROFILE DETAIL VIEW
// ============================================================

function openProfile(username) {
  S.selectedUser = username;
  nav('profile');
  renderProfileDetail();
}

function buildHistoryHtml(history) {
  if (!history.length) return '<div class="empty" style="padding:12px">No messages yet.</div>';
  return history.map(h => {
    const type = h.type ?? 'chat';
    const ts   = fmtTs(h.timestamp) || escHtml(String(h.timestamp ?? ''));
    return `<div class="chat-msg type-${escHtml(type)}">
      <span class="msg-ts">${ts}</span>
      <span class="msg-txt">${escHtml(h.message ?? '')}</span>
    </div>`;
  }).join('');
}

function renderProfileDetail() {
  const username = S.selectedUser;
  const p        = S.profiles[username];
  if (!p) { nav('main'); return; }

  // Sort history oldest-first for display
  const history = [...p.history].sort(
    (a, b) => new Date(a.timestamp ?? 0) - new Date(b.timestamp ?? 0)
  );

  const init = escHtml((p.avatarInitial || p.username.charAt(0)).toUpperCase());

  $('#profile-detail').innerHTML = `
    <!-- Header -->
    <div class="pd-header">
      <div class="pd-avatar">${init}</div>
      <div class="pd-meta">
        <div class="pd-username">${escHtml(p.username)}</div>
        <div class="pd-sub">
          ${p.messageCount ?? 0} messages ·
          first seen ${fmtDate(p.firstSeen)} ·
          last seen ${fmtDate(p.lastSeen)}
        </div>
        <div class="pd-sub" style="margin-top:2px;color:var(--txt2)">
          source: ${escHtml(p.source ?? 'auto')}
        </div>
      </div>
    </div>

    <!-- Editable fields -->
    <div class="pd-fields">
      <div class="field-grp">
        <label>Aliases (comma-separated)</label>
        <input id="f-aliases" type="text"
               value="${escHtml((p.aliases ?? []).join(', '))}"
               placeholder="e.g. alt-nick, real-name…" />
      </div>
      <div class="field-grp">
        <label>Position</label>
        <input id="f-position" type="text"
               value="${escHtml(p.position ?? '')}"
               placeholder="e.g. dom, sub, switch…" />
      </div>
      <div class="field-grp">
        <label>Kinks</label>
        <input id="f-kinks" type="text"
               value="${escHtml(p.kinks ?? '')}"
               placeholder="e.g. bdsm, goth, furry…" />
      </div>
      <div class="field-grp">
        <label>Traits</label>
        <input id="f-traits" type="text"
               value="${escHtml(p.traits ?? '')}"
               placeholder="e.g. talkative, generous…" />
      </div>
      <div class="field-grp">
        <label>Notes</label>
        <textarea id="f-notes" placeholder="Your personal notes…">${escHtml(p.notes ?? '')}</textarea>
      </div>
    </div>

    <!-- Action row -->
    <div class="pd-actions">
      <button id="btn-save"   class="btn-primary">💾 Save</button>
      <button id="btn-star"   class="btn-secondary">${p.starred ? '★ Unstar' : '☆ Star'}</button>
      <button id="btn-copy"   class="btn-secondary">📋 Copy Chat</button>
      <button id="btn-filter" class="btn-secondary">🕐 Filter</button>
    </div>

    <!-- Time filter (hidden by default) -->
    <div class="filter-row hidden" id="filter-row">
      <label>Show:</label>
      <select id="filter-sel">
        <option value="all">All time</option>
        <option value="60">Last hour</option>
        <option value="360">Last 6 hrs</option>
        <option value="1440">Last 24 hrs</option>
        <option value="10080">Last 7 days</option>
      </select>
    </div>

    <!-- Chat history -->
    <div class="history-section">
      <h4>Chat history (${history.length})</h4>
      <div class="chat-history" id="chat-history">
        ${buildHistoryHtml(history)}
      </div>
    </div>`;

  // ── Scroll history to bottom (most recent)
  const histEl = $('#chat-history');
  histEl.scrollTop = histEl.scrollHeight;

  // ── Save
  $('#btn-save').addEventListener('click', async () => {
    const aliases = $('#f-aliases').value
      .split(',').map(s => s.trim()).filter(Boolean);
    const updates = {
      aliases,
      position: $('#f-position').value.trim(),
      kinks:    $('#f-kinks').value.trim(),
      traits:   $('#f-traits').value.trim(),
      notes:    $('#f-notes').value.trim(),
    };
    await bgMsg({ type: 'UPDATE_PROFILE', payload: { username, updates } });
    await loadData();
    toast('Profile saved ✓', 'ok');
  });

  // ── Star / Unstar
  $('#btn-star').addEventListener('click', async () => {
    const nowStarred = !S.profiles[username]?.starred;
    await bgMsg({ type: 'UPDATE_PROFILE', payload: { username, updates: { starred: nowStarred } } });
    await loadData();
    renderProfileDetail();
    toast(nowStarred ? 'Starred ★' : 'Unstarred', '');
  });

  // ── Copy chat to clipboard
  $('#btn-copy').addEventListener('click', () => {
    const lines = history.map(h => {
      const ts = fmtTs(h.timestamp) || String(h.timestamp ?? '');
      return `${username} — ${ts}: ${h.message ?? ''}`;
    });
    const text = lines.join('\n');
    navigator.clipboard.writeText(text)
      .then(() => toast('Chat copied to clipboard ✓', 'ok'))
      .catch(() => toast('Clipboard unavailable', 'err'));
  });

  // ── Toggle time filter
  $('#btn-filter').addEventListener('click', () => {
    $('#filter-row').classList.toggle('hidden');
  });

  // ── Apply time filter
  $('#filter-sel').addEventListener('change', () => {
    const val = $('#filter-sel').value;
    const histBox = $('#chat-history');

    if (val === 'all') {
      histBox.innerHTML = buildHistoryHtml(history);
    } else {
      const minutes = parseInt(val, 10);
      const cutoff  = Date.now() - minutes * 60_000;
      const filtered = history.filter(h => {
        try { return new Date(h.timestamp).getTime() >= cutoff; } catch { return true; }
      });
      histBox.innerHTML = filtered.length
        ? buildHistoryHtml(filtered)
        : '<div class="empty" style="padding:10px">No messages in this range.</div>';
    }

    histBox.scrollTop = histBox.scrollHeight;
  });
}

// ============================================================
// SYNC
// ============================================================

async function doSync() {
  if (S.syncing) return;
  S.syncing = true;

  const btn     = $('#btn-sync');
  const spinner = $('#sync-spinner');
  btn.disabled  = true;
  spinner.classList.add('spinning');
  btn.childNodes[btn.childNodes.length - 1].textContent = ' Syncing…';

  try {
    const res = await tabMsg({ type: 'SYNC_CHAT' });
    await loadData();
    renderMain();

    if (res) {
      toast(`Synced ${res.synced} new · ${res.total} total in chat`, 'ok');
    } else {
      toast('Not on gooning.games — open a chat room first', 'warn');
    }
  } catch (e) {
    toast('Sync error: ' + e.message, 'err');
  } finally {
    S.syncing = false;
    btn.disabled = false;
    spinner.classList.remove('spinning');
    btn.childNodes[btn.childNodes.length - 1].textContent = ' Sync Chat';
  }
}

// ============================================================
// IMPORT — paste manual chat
// ============================================================

function initImport() {
  $('#btn-parse').addEventListener('click', async () => {
    const text   = $('#import-area').value.trim();
    const target = $('#import-target').value.trim() || null;

    if (!text) { toast('Paste some chat text first', 'warn'); return; }

    const res = await bgMsg({ type: 'PARSE_MANUAL_CHAT', payload: { text, targetUsername: target } });

    if (res?.error) {
      toast('Parse error: ' + res.error, 'err');
      return;
    }

    await loadData();
    renderMain();

    const msg = `✅ Imported ${res?.count ?? 0} messages across ${res?.profileCount ?? 0} profiles`;
    $('#import-status').textContent = msg;
    toast(msg, 'ok');
  });
}

// ============================================================
// SETTINGS VIEW
// ============================================================

function initSettings() {
  // ── Export JSON
  $('#btn-export').addEventListener('click', () => {
    const json = JSON.stringify(S.profiles, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `gg-chat-tracker-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Export saved ✓', 'ok');
  });

  // ── Import JSON
  $('#btn-import-json').addEventListener('click', async () => {
    const file = $('#file-import').files?.[0];
    if (!file) { toast('Select a JSON file first', 'warn'); return; }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        const res  = await bgMsg({ type: 'IMPORT_JSON', payload: { data } });
        if (res?.ok) {
          await loadData();
          toast('Import merged ✓', 'ok');
          $('#settings-msg').textContent = '✅ Import complete.';
        } else {
          toast('Import failed: ' + (res?.error ?? 'unknown'), 'err');
        }
      } catch (err) {
        toast('Invalid JSON file', 'err');
      }
    };
    reader.readAsText(file);
  });

  // ── Clear all
  $('#btn-clear-all').addEventListener('click', async () => {
    const confirm1 = confirm(
      '⚠️ This will permanently delete ALL profiles and chat history.\n\nAre you sure?'
    );
    if (!confirm1) return;
    const confirm2 = confirm('Last chance — delete everything?');
    if (!confirm2) return;

    await bgMsg({ type: 'CLEAR_ALL' });
    S.profiles = {};
    S.stats    = {};
    toast('All data deleted', 'warn');
    nav('main');
    renderMain();
  });
}

// ============================================================
// KEYBOARD SHORTCUT
// ============================================================

document.addEventListener('keydown', e => {
  // Esc → back to main
  if (e.key === 'Escape' && S.view !== 'main') nav('main');
});

// ============================================================
// WIRE UP EVENT LISTENERS
// ============================================================

function wireEvents() {
  // Header back button
  $('#btn-back').addEventListener('click', () => nav('main'));

  // Header settings button
  $('#btn-settings').addEventListener('click', () => {
    nav('settings');
    initSettings();
  });

  // Sync button
  $('#btn-sync').addEventListener('click', doSync);

  // Force resend button
  $('#btn-force-resend').addEventListener('click', async () => {
    if (!confirm('This will clear the sent history and resend ALL messages in the chat. Make sure your server is ready to receive them. Continue?')) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      alert('No active tab found.');
      return;
    }
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { type: 'FORCE_RESEND_ALL' }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });
      console.log('[Popup] Force resend result:', response);
      if (!response) {
        throw new Error('No response from content script');
      }
      alert(`Force resend complete!\n\nResent: ${response.resent} messages\nCleared from history: ${response.cleared}\nTotal in DOM: ${response.total}`);
      // Refresh stats
      await loadData();
      renderMain();
    } catch (err) {
      console.error('[Popup] Force resend error:', err);
      alert('Failed to communicate with content script. Make sure you are on a gooning.games chat page and the extension is loaded.\n\nError: ' + err.message);
    }
  });

  // Search input
  $('#search-input').addEventListener('input', e => {
    S.query = e.target.value;
    renderProfileList();
  });

  // Tab switching
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Paste import
  initImport();
}

// ============================================================
// INIT
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  wireEvents();
  nav('main');
  renderMain();
});

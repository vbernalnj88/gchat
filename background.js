/**
 * background.js — GG Chat Tracker Service Worker
 *
 * Acts as the single source of truth for all stored data.
 * Content script → background (store messages)
 * Popup        ↔ background (CRUD, export, import, stats)
 */

'use strict';

// ============================================================
// STORAGE HELPERS
// ============================================================

/** @returns {Promise<Record<string, UserProfile>>} */
async function getProfiles() {
  const r = await chrome.storage.local.get('gg_profiles');
  return r.gg_profiles || {};
}

async function saveProfiles(profiles) {
  await chrome.storage.local.set({ gg_profiles: profiles });
}

/** @returns {Promise<GGStats>} */
async function getStats() {
  const r = await chrome.storage.local.get('gg_stats');
  return r.gg_stats || { totalMessages: 0, totalProfiles: 0, lastSync: null };
}

async function recomputeStats(profiles) {
  const totalMessages = Object.values(profiles).reduce((s, p) => s + p.history.length, 0);
  const stats = {
    totalMessages,
    totalProfiles: Object.keys(profiles).length,
    lastSync: new Date().toISOString(),
  };
  await chrome.storage.local.set({ gg_stats: stats });
  return stats;
}

// ============================================================
// PROFILE / MESSAGE UPSERT
// ============================================================

/**
 * Insert a new message into the appropriate user profile.
 * Creates the profile if it doesn't exist yet.
 *
 * @param {ParsedMessage} payload
 * @returns {{ isNewProfile: boolean, isNewMessage: boolean }}
 */
async function upsertMessage(payload) {
  const {
    msgId, username, timestamp, messageText,
    messageType, directedAt, avatarUrl, avatarInitial,
    pageUrl, pageTitle,
  } = payload;

  // Sanity guards
  if (!username || !messageText || !msgId) {
    return { isNewProfile: false, isNewMessage: false };
  }

  const profiles = await getProfiles();
  const isNewProfile = !profiles[username];

  // ── Create profile skeleton if needed ──────────────────────────────
  if (isNewProfile) {
    profiles[username] = {
      username,
      aliases:      [],
      traits:       '',
      position:     '',
      kinks:        '',
      notes:        '',
      avatarUrl:    avatarUrl || null,
      avatarInitial: avatarInitial || username.charAt(0).toUpperCase(),
      firstSeen:    timestamp,
      lastSeen:     timestamp,
      messageCount: 0,
      history:      [],
      source:       'auto',
      starred:      false,
    };
  }

  const profile = profiles[username];

  // Update avatar if we now have one
  if (avatarUrl && !profile.avatarUrl)       profile.avatarUrl    = avatarUrl;
  if (avatarInitial && !profile.avatarInitial) profile.avatarInitial = avatarInitial;

  // Deduplicate by msgId
  if (profile.history.some(h => h.msgId === msgId)) {
    return { isNewProfile, isNewMessage: false };
  }

  // ── Append message ─────────────────────────────────────────────────
  profile.history.push({
    msgId,
    timestamp,
    message: messageText,
    type:    messageType || 'chat',
    directedAt: directedAt || null,
    pageUrl: pageUrl || null,
    pageTitle: pageTitle || null,
  });

  profile.lastSeen     = timestamp;
  profile.messageCount = profile.history.length;

  await saveProfiles(profiles);
  await recomputeStats(profiles);

  return { isNewProfile, isNewMessage: true };
}

// ============================================================
// MANUAL CHAT PARSER
// ============================================================

/**
 * Parses pasted chat text into structured messages and stores them.
 *
 * Supported formats:
 *   [time] Username: message
 *   Username - time: message
 *   Username: message
 *
 * @param {string} text  Raw pasted text
 * @param {string|null} targetUsername  Force all messages into one profile
 */
async function parseAndStoreManualChat(text, targetUsername) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const extracted = [];

  // Regex patterns (order matters — most specific first)
  const PATTERNS = [
    // [time] Username: message
    /^\[([^\]]+)\]\s+(.+?):\s+(.+)$/,
    // Username - time: message
    /^(.+?)\s+[-–]\s+([0-9:apmAPM ]+):\s+(.+)$/,
    // Username: message  (generic fallback)
    /^([^:\n]{1,60}):\s+(.+)$/,
  ];

  for (const line of lines) {
    let match;
    if ((match = PATTERNS[0].exec(line))) {
      extracted.push({ timestamp: match[1].trim(), username: match[2].trim(), message: match[3].trim() });
    } else if ((match = PATTERNS[1].exec(line))) {
      extracted.push({ username: match[1].trim(), timestamp: match[2].trim(), message: match[3].trim() });
    } else if ((match = PATTERNS[2].exec(line))) {
      const possible = match[1].trim();
      // Skip things that look like URLs or are suspiciously long
      if (!possible.includes('http') && possible.length < 60) {
        extracted.push({ username: possible, timestamp: new Date().toISOString(), message: match[2].trim() });
      }
    }
  }

  if (extracted.length === 0) return { count: 0, profileCount: 0 };

  const profiles = await getProfiles();
  let added = 0;

  for (const m of extracted) {
    const user = targetUsername || m.username;
    if (!user) continue;

    if (!profiles[user]) {
      profiles[user] = {
        username:     user,
        aliases:      [],
        traits:       '',
        position:     '',
        kinks:        '',
        notes:        '',
        avatarUrl:    null,
        avatarInitial: user.charAt(0).toUpperCase(),
        firstSeen:    m.timestamp,
        lastSeen:     m.timestamp,
        messageCount: 0,
        history:      [],
        source:       'manual',
        starred:      false,
      };
    }

    const msgId = `manual_${user}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Loose deduplicate: same text + same rough time
    const dup = profiles[user].history.find(
      h => h.message === m.message && h.timestamp === m.timestamp
    );
    if (!dup) {
      profiles[user].history.push({
        msgId,
        timestamp: m.timestamp,
        message:   m.message,
        type:      'manual',
        directedAt: null,
        pageUrl:   null,
      });
      profiles[user].messageCount = profiles[user].history.length;
      profiles[user].lastSeen     = m.timestamp;
      added++;
    }
  }

  await saveProfiles(profiles);
  await recomputeStats(profiles);

  return { count: added, profileCount: Object.keys(profiles).length };
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {

        // ── Content script sends a new chat message ────────────────
        case 'NEW_MESSAGE': {
          const result = await upsertMessage(msg.payload);
          sendResponse(result);
          break;
        }

        // ── Popup requests all profiles ────────────────────────────
        case 'GET_PROFILES': {
          const profiles = await getProfiles();
          sendResponse({ profiles });
          break;
        }

        // ── Popup requests stats ───────────────────────────────────
        case 'GET_STATS': {
          const stats = await getStats();
          const profiles = await getProfiles();
          // Always return live counts
          stats.totalProfiles = Object.keys(profiles).length;
          stats.totalMessages = Object.values(profiles).reduce((s, p) => s + p.history.length, 0);
          sendResponse({ stats });
          break;
        }

        // ── Popup updates editable profile fields ──────────────────
        case 'UPDATE_PROFILE': {
          const { username, updates } = msg.payload;
          const profiles = await getProfiles();
          if (profiles[username]) {
            // Whitelist the editable fields
            const allowed = ['aliases', 'position', 'kinks', 'traits', 'notes', 'starred', 'avatarInitial'];
            for (const key of allowed) {
              if (key in updates) profiles[username][key] = updates[key];
            }
            await saveProfiles(profiles);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Profile not found' });
          }
          break;
        }

        // ── Popup deletes a profile ────────────────────────────────
        case 'DELETE_PROFILE': {
          const profiles = await getProfiles();
          delete profiles[msg.payload.username];
          await saveProfiles(profiles);
          await recomputeStats(profiles);
          sendResponse({ ok: true });
          break;
        }

        // ── Popup imports a JSON backup (merge strategy) ───────────
        case 'IMPORT_JSON': {
          const incoming = msg.payload.data;
          if (typeof incoming !== 'object' || Array.isArray(incoming)) {
            sendResponse({ ok: false, error: 'Invalid format' });
            break;
          }
          const profiles = await getProfiles();
          for (const [key, profile] of Object.entries(incoming)) {
            if (!profiles[key]) {
              profiles[key] = profile;
            } else {
              // Merge history (deduplicate by msgId)
              const existingIds = new Set(profiles[key].history.map(h => h.msgId));
              const newMsgs = (profile.history || []).filter(h => !existingIds.has(h.msgId));
              profiles[key].history.push(...newMsgs);
              profiles[key].messageCount = profiles[key].history.length;
              // Merge user-editable fields (only if blank in current)
              for (const f of ['aliases', 'traits', 'position', 'kinks', 'notes']) {
                if (!profiles[key][f] || (Array.isArray(profiles[key][f]) && profiles[key][f].length === 0)) {
                  profiles[key][f] = profile[f];
                }
              }
            }
          }
          await saveProfiles(profiles);
          await recomputeStats(profiles);
          sendResponse({ ok: true });
          break;
        }

        // ── Popup clears all data ──────────────────────────────────
        case 'CLEAR_ALL': {
          await chrome.storage.local.clear();
          sendResponse({ ok: true });
          break;
        }

        // ── Popup imports pasted manual chat text ──────────────────
        case 'PARSE_MANUAL_CHAT': {
          const { text, targetUsername } = msg.payload;
          const result = await parseAndStoreManualChat(text, targetUsername || null);
          sendResponse(result);
          break;
        }

        default:
          sendResponse({ error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      console.error('[GG Tracker BG] Error:', err);
      sendResponse({ error: err.message });
    }
  })();

  // Return true to keep the message channel open for async response
  return true;
});

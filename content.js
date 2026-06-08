/**
 * content.js — GG Chat Tracker Content Script  (v1.1 — continuation fix)
 *
 * ─────────────────────────────────────────────────────────────────────
 * SELECTOR GUIDE (gooning.games Tailwind/React HTML — confirmed live):
 *
 *  FULL message (new user block, class contains "mt-3"):
 *    <div data-message-id="UUID" class="… mt-3">
 *      <div class="flex items-start gap-2">
 *        <button aria-label="View USERNAME profile">   ← username source
 *          <img class="… rounded-full …" src="/api/uploads/…">
 *        </button>
 *        <div class="min-w-0 flex-1">
 *          <span class="min-w-0 truncate">USERNAME</span>  ← fallback
 *          <span class="… tabular-nums">4:03 PM</span>     ← timestamp
 *          <p class="… whitespace-pre-wrap … leading-relaxed">text</p>
 *        </div>
 *      </div>
 *    </div>
 *
 *  CONTINUATION message (same user, no avatar re-shown, class "mt-1"):
 *    <div data-message-id="UUID" class="… mt-1">
 *      <div class="pl-10">                              ← indented, NO profile btn
 *        <p class="… whitespace-pre-wrap …">text</p>
 *      </div>
 *    </div>
 *
 *  CONTINUATION + TASK/QUESTION card:
 *    <div data-message-id="UUID" class="… mt-1">
 *      <div class="pl-10">
 *        <div class="border-l-4 … border-blue-500 …">
 *          <span class="text-blue-400">Question</span>
 *          <span class="max-w-[10rem] truncate">TargetUser</span>
 *          <p>…question text…</p>
 *        </div>
 *      </div>
 *    </div>
 *
 *  SYSTEM message (no data-message-id — correctly skipped):
 *    <div class="mx-auto … rounded-xl border border-purple-400/20 …">
 *      <p>It appears USERNAME has lost connection.</p>
 *    </div>
 * ─────────────────────────────────────────────────────────────────────
 */

(function ggChatTracker() {
  'use strict';

  // ============================================================
  // SELECTORS
  // ============================================================
  const SEL = {
    msgAttr:           'data-message-id',
    profileBtn:        '[aria-label^="View "][aria-label$=" profile"]',
    usernameTruncated: '.min-w-0.truncate',
    timestamp:         '.tabular-nums',
    messagePara:       'p.whitespace-pre-wrap, p.break-words, p.leading-relaxed',
    continuationInner: '.pl-10',          // inner div on continuation messages
    fullMsgInner:      '.flex.items-start', // inner div on full (new-user) messages
    borderYellow:      '[class*="border-yellow"]',
    borderBlue:        '[class*="border-blue"]',
    borderRed:         '[class*="border-red"]',
    borderGreen:       '[class*="border-green"]',
    avatarImg:         '.rounded-full img, img.rounded-full',
  };

  // ============================================================
  // STATE
  // ============================================================

  /** Message IDs already forwarded to the background. */
  const sent = new Set();

  /**
   * Last successfully identified user.
   * Used to attribute continuation messages to the same sender.
   */
  let lastUser = {
    username:      null,
    avatarUrl:     null,
    avatarInitial: null,
    timestamp:     null,
  };

  let observer  = null;
  let initTimer = null;
  const SCAN_INTERVAL_MS = 30_000;

  // ============================================================
  // CONTINUATION ATTRIBUTION — DOM traversal
  // ============================================================

  /**
   * Walk backwards through previous siblings to find the nearest
   * full message (one that has a profile button).  Returns an object
   * with {username, avatarUrl} or null.
   *
   * This is the primary attribution method for continuation messages.
   * It is O(n) but n is typically tiny (< 5 hops back).
   */
  function findPreviousUser(el) {
    let sibling = el.previousElementSibling;
    let hops = 0;
    while (sibling && hops < 30) {
      if (sibling.hasAttribute && sibling.hasAttribute(SEL.msgAttr)) {
        const btn = sibling.querySelector(SEL.profileBtn);
        if (btn) {
          const m = (btn.getAttribute('aria-label') || '')
            .match(/^View\s+(.+?)\s+profile$/);
          if (m && m[1].trim()) {
            return {
              username:  m[1].trim(),
              avatarUrl: sibling.querySelector(SEL.avatarImg)?.src ?? null,
            };
          }
        }
        // Fallback: truncated span (catches any future layout changes)
        const span = sibling.querySelector(SEL.usernameTruncated);
        if (span) {
          const clone = span.cloneNode(true);
          clone.querySelectorAll('.gg-badge').forEach(b => b.remove());
          const t = clone.textContent.trim();
          if (t) return { username: t, avatarUrl: sibling.querySelector(SEL.avatarImg)?.src ?? null };
        }
      }
      sibling = sibling.previousElementSibling;
      hops++;
    }
    return null;
  }

  // ============================================================
  // TEXT HELPERS
  // ============================================================

  /** Read textContent of an element safely, stripping our own injected badges. */
  function safeText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.gg-badge').forEach(b => b.remove());
    return clone.textContent.trim();
  }

  // ============================================================
  // PARSE A SINGLE MESSAGE ELEMENT
  // ============================================================

  /**
   * Convert one [data-message-id] DOM element into a structured object.
   *
   * Returns null when:
   *   • Already in the `sent` set (duplicate)
   *   • No message text found
   *   • Cannot attribute a username (genuine anonymous system card)
   *
   * KEY FIX v1.1:
   *   Continuation messages (mt-1 / pl-10 layout) carry no visible username.
   *   We attribute them by:
   *     1. DOM traversal back to the nearest full message  (reliable)
   *     2. Fallback to `lastUser` module-level state      (catch-all)
   */
  function parseMessageEl(el) {
    const msgId = el.getAttribute(SEL.msgAttr);
    if (!msgId || sent.has(msgId)) return null;

    // ── Detect message layout ─────────────────────────────────────────
    //
    //  Full messages have: <div class="flex items-start gap-2"> inside
    //  Continuation messages have: <div class="pl-10"> inside
    //
    const hasProfileArea = !!el.querySelector(SEL.fullMsgInner);
    const isContinuation = !hasProfileArea && !!el.querySelector(SEL.continuationInner);

    // ── USERNAME ──────────────────────────────────────────────────────

    let username      = null;
    let avatarUrl     = null;
    let avatarInitial = null;

    if (hasProfileArea) {
      // ── Full message: extract from profile button aria-label ──────
      const profileBtn = el.querySelector(SEL.profileBtn);
      if (profileBtn) {
        const m = (profileBtn.getAttribute('aria-label') || '')
          .match(/^View\s+(.+?)\s+profile$/);
        if (m) username = m[1].trim();
        // Grab real avatar URL from the <img> inside the button
        const img = profileBtn.querySelector('img') ?? el.querySelector(SEL.avatarImg);
        if (img) avatarUrl = img.src;
      }
      // Fallback: visible truncated span (future-proof)
      if (!username) {
        const span = el.querySelector(SEL.usernameTruncated);
        if (span) username = safeText(span) || null;
      }
    }

    if (!username && isContinuation) {
      // ── Continuation message: attribute to previous sender ────────
      //
      // Strategy 1 — DOM traversal (most reliable, doesn't depend on
      //              processing order or module-level state)
      const prev = findPreviousUser(el);
      if (prev) {
        username  = prev.username;
        avatarUrl = prev.avatarUrl;
      }

      // Strategy 2 — module-level state (fallback, handles edge cases
      //              where traversal finds nothing, e.g. very first msg)
      if (!username) {
        username      = lastUser.username;
        avatarUrl     = avatarUrl ?? lastUser.avatarUrl;
        avatarInitial = lastUser.avatarInitial;
      }
    }

    // Cannot attribute — genuine anonymous system message, skip
    if (!username) return null;

    // ── Update lastUser state for subsequent continuations ────────────
    //    Only update on full messages so the state always points to the
    //    most recent CONFIRMED sender identity.
    if (hasProfileArea && username) {
      lastUser = {
        username,
        avatarUrl:     avatarUrl ?? null,
        avatarInitial: username.charAt(0).toUpperCase(),
        timestamp:     null, // filled below
      };
    }

    // ── TIMESTAMP ─────────────────────────────────────────────────────
    //    Full messages show the timestamp; continuation messages often
    //    don't.  Fall back to lastUser.timestamp so history stays sorted.

    let timestamp = new Date().toISOString();
    const tsEl = el.querySelector(SEL.timestamp);
    if (tsEl) {
      const raw = tsEl.textContent.trim();
      if (raw) {
        const parsed = new Date(`${new Date().toDateString()} ${raw}`);
        timestamp = isNaN(parsed.getTime())
          ? `${new Date().toLocaleDateString()} ${raw}`
          : parsed.toISOString();
      }
    } else if (lastUser.timestamp) {
      // Use the same timestamp as the parent full message
      timestamp = lastUser.timestamp;
    }

    // Persist so continuation siblings can reuse it
    if (hasProfileArea) lastUser.timestamp = timestamp;

    // ── MESSAGE TEXT ──────────────────────────────────────────────────
    let messageText = '';
    for (const p of el.querySelectorAll(SEL.messagePara)) {
      const t = safeText(p);
      if (t) { messageText = t; break; }
    }
    if (!messageText) return null;

    // ── MESSAGE TYPE ──────────────────────────────────────────────────
    let messageType = isContinuation ? 'continuation' : 'chat';
    if (el.querySelector(SEL.borderYellow)) messageType = 'task';
    else if (el.querySelector(SEL.borderBlue))  messageType = 'question';
    else if (el.querySelector(SEL.borderRed))   messageType = 'action';
    else if (el.querySelector(SEL.borderGreen)) messageType = 'achievement';

    // ── DIRECTED-AT USER (task / question cards) ──────────────────────
    let directedAt = null;
    if (messageType === 'task' || messageType === 'question') {
      // The target username lives in the pill badge: class contains "max-w-"
      // e.g. <span class="max-w-[10rem] truncate">GermanGoonBoy</span>
      for (const badge of el.querySelectorAll('[class*="max-w-"]')) {
        const t = safeText(badge);
        if (t && t.length < 60 && t !== username) { directedAt = t; break; }
      }
    }

    // ── AVATAR ────────────────────────────────────────────────────────
    if (!avatarUrl) {
      const img = el.querySelector(SEL.avatarImg);
      if (img) avatarUrl = img.src;
    }
    // Inherit avatar from lastUser if not found in this element
    if (!avatarUrl)     avatarUrl     = lastUser.avatarUrl     ?? null;
    if (!avatarInitial) avatarInitial = lastUser.avatarInitial ?? username.charAt(0).toUpperCase();

    return {
      msgId,
      username,
      timestamp,
      messageText,
      messageType,
      directedAt,
      avatarUrl,
      avatarInitial,
      isContinuation,
      pageUrl:   window.location.href,
      pageTitle: document.title,
    };
  }

  // ============================================================
  // SEND TO BACKGROUND
  // ============================================================

  function sendToBg(parsed) {
    if (!parsed) return;
    sent.add(parsed.msgId); // Mark before async send to prevent race dupes
    chrome.runtime.sendMessage({ type: 'NEW_MESSAGE', payload: parsed }, () => {
      void chrome.runtime.lastError; // suppress "no listener" when popup closed
    });
  }

  // ============================================================
  // SCAN — process all visible [data-message-id] elements
  // ============================================================

  /**
   * Processes every message in the DOM in document order.
   * Document order is critical: continuation messages must be processed
   * AFTER their preceding full message so DOM traversal succeeds.
   *
   * Returns count of newly sent messages.
   */
  function scanAll() {
    const elements = document.querySelectorAll(`[${SEL.msgAttr}]`);
    let count = 0;
    elements.forEach(el => {
      if (sent.has(el.getAttribute(SEL.msgAttr))) return;
      const parsed = parseMessageEl(el);
      if (parsed) { sendToBg(parsed); count++; }
    });
    return count;
  }

  // ============================================================
  // MUTATION OBSERVER
  // ============================================================

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(mutations => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.hasAttribute && node.hasAttribute(SEL.msgAttr)) {
            // Single message added directly
            sendToBg(parseMessageEl(node));
          } else if (node.querySelectorAll) {
            // Batch of messages inside a container (page hydration / scroll-load)
            node.querySelectorAll(`[${SEL.msgAttr}]`).forEach(el => {
              sendToBg(parseMessageEl(el));
            });
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // HIGHLIGHT TRACKED USERS IN CHAT
  // ============================================================

  async function highlightTrackedUsers() {
    try {
      const res = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'GET_PROFILES' }, resolve)
      );
      if (!res?.profiles) return;

      const known = new Set(Object.keys(res.profiles));

      document.querySelectorAll(`[${SEL.msgAttr}]`).forEach(el => {
        if (el.dataset.ggHighlighted) return;

        const btn = el.querySelector(SEL.profileBtn);
        if (!btn) return;

        const m    = (btn.getAttribute('aria-label') || '').match(/^View\s+(.+?)\s+profile$/);
        const user = m?.[1]?.trim();
        if (!user || !known.has(user)) return;

        const nameSpan = el.querySelector(SEL.usernameTruncated);
        if (nameSpan && !nameSpan.querySelector('.gg-badge')) {
          const dot = document.createElement('span');
          dot.className  = 'gg-badge';
          dot.title      = 'Tracked by GG Chat Tracker';
          dot.style.cssText = [
            'display:inline-block', 'width:6px', 'height:6px',
            'border-radius:50%', 'background:#a855f7',
            'margin-left:5px', 'vertical-align:middle',
            'opacity:0.85', 'flex-shrink:0',
          ].join(';');
          nameSpan.appendChild(dot);
        }
        el.dataset.ggHighlighted = '1';
      });
    } catch { /* cosmetic — fail silently */ }
  }

  // ============================================================
  // RUNTIME MESSAGE LISTENER (popup ↔ content script)
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'SYNC_CHAT': {
        const count = scanAll();
        highlightTrackedUsers();
        sendResponse({
          synced: count,
          total:  document.querySelectorAll(`[${SEL.msgAttr}]`).length,
          sent:   sent.size,
        });
        break;
      }
      case 'GET_CHAT_INFO': {
        sendResponse({
          url:            window.location.href,
          title:          document.title,
          totalInDom:     document.querySelectorAll(`[${SEL.msgAttr}]`).length,
          alreadySent:    sent.size,
          observerActive: !!observer,
        });
        break;
      }
      default: break;
    }
    return true;
  });

  // ============================================================
  // INIT — multi-wave scanning to handle lazy-loaded chat
  // ============================================================

  /**
   * Why multi-wave?
   *
   * gooning.games loads the chat widget asynchronously. The page HTML
   * arrives before the React/WebSocket messages do, so a single
   * setTimeout(fn, 2000) can fire before messages are rendered.
   *
   * We fire five increasingly-delayed scans on page load (covering
   * fast connections AND slow ones), then rely on the MutationObserver
   * + the 30-second periodic scan for everything that comes in later.
   */
  const BOOT_DELAYS_MS = [0, 500, 1500, 3500, 7000];

  function init() {
    console.log('[GG Tracker] v1.1 loaded →', window.location.href);

    startObserver();

    let lastCount = 0;
    BOOT_DELAYS_MS.forEach(delay => {
      setTimeout(() => {
        const n = scanAll();
        if (n !== lastCount) {
          console.log(`[GG Tracker] scan @${delay}ms: ${n} new messages captured`);
          lastCount = n;
          highlightTrackedUsers();
        }
      }, delay);
    });

    // Periodic fallback — catches scroll-loaded history, reconnects, etc.
    setInterval(() => {
      const n = scanAll();
      if (n > 0) highlightTrackedUsers();
    }, SCAN_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

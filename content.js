/**
 * content.js — GG Chat Tracker Content Script  (v1.9 — fixed task/question card username extraction)
 *
 * ─────────────────────────────────────────────────────────────────────
 * SELECTOR GUIDE (gooning.games Tailwind/React HTML — confirmed live):
 *
 *  FULL message (new user block, class contains "mt-3" or "mt-0"):
 *    <div data-message-id="UUID" class="… mt-3">
 *      <div class="flex items-start gap-2">              ← DIRECT CHILD
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
 *      <div class="pl-10">                              ← DIRECT CHILD, indented
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
    borderYellow:      '[class*="border-yellow"]',
    borderBlue:        '[class*="border-blue"]',
    borderRed:         '[class*="border-red"]',
    borderGreen:       '[class*="border-green"]',
    avatarImg:         '.rounded-full img, img.rounded-full',
  };

  // ============================================================
  // STATE
  // ============================================================

  /** Message IDs confirmed as successfully received by background. */
  const sent = new Set();

  /** Message IDs that we attempted to send but may need retry. */
  const attempted = new Map(); // msgId -> {parsed, attempts, lastAttempt}

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
  const MAX_SEND_ATTEMPTS = 3;

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
   * 
   * KEY FIX v1.3: Also check if sibling itself contains a profile button
   * directly (not just via querySelector) to handle cases where the
   * profile button is nested differently in historical messages.
   */
  function findPreviousUser(el) {
    let sibling = el.previousElementSibling;
    let hops = 0;
    while (sibling && hops < 30) {
      if (sibling.hasAttribute && sibling.hasAttribute(SEL.msgAttr)) {
        // Try direct child first, then nested
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
   * KEY FIX v1.3:
   *   Continuation messages (mt-1 / pl-10 layout) carry no visible username.
   *   We detect them by checking for the DIRECT CHILD structure:
   *     - Full messages have: > div.flex.items-start.gap-2 OR > div containing profile button
   *     - Continuation messages have: > div.pl-10
   *   Attribution is done by:
   *     1. DOM traversal back to the nearest full message  (reliable)
   *     2. Fallback to `lastUser` module-level state      (catch-all)
   */
  function parseMessageEl(el) {
    const msgId = el.getAttribute(SEL.msgAttr);
    if (!msgId || sent.has(msgId)) return null;

    console.log(`[GG Tracker] Parsing message ID: ${msgId}`);

    // ── Detect message layout ─────────────────────────────────────────
    //
    //  Full messages have a DIRECT CHILD with profile button OR class "flex items-start gap-2"
    //  Continuation messages have a DIRECT CHILD with class "pl-10" BUT not task/question cards
    //  Task/Question cards also have pl-10 but contain special border divs with username inside
    //
    //  We use :scope > to ensure we're checking direct children only.
    //  Check for profile button first as it's the most reliable indicator
    //
    const hasProfileBtn = !!el.querySelector(':scope > * ' + SEL.profileBtn);
    const fullMsgChild = el.querySelector(':scope > .flex, :scope > div[class*="flex"]');
    const continuationChild = el.querySelector(':scope > .pl-10, :scope > div[class*="pl-10"]');
    
    // Check if this is a task/question card (has special border classes)
    const isTaskQuestion = !!(el.querySelector(SEL.borderYellow) || el.querySelector(SEL.borderBlue));
    
    // Task/question cards with pl-10 are NOT continuations - they have username inside the card
    const hasProfileArea = hasProfileBtn || (!!fullMsgChild && !continuationChild) || isTaskQuestion;
    const isContinuation = !!continuationChild && !hasProfileArea;

    console.log(`[GG Tracker] Message ${msgId}: hasProfileArea=${hasProfileArea}, isContinuation=${isContinuation}, isTaskQuestion=${isTaskQuestion}`);

    // ── USERNAME ──────────────────────────────────────────────────────

    let username      = null;
    let avatarUrl     = null;
    let avatarInitial = null;

    if (hasProfileArea) {
      // ── Full message: extract from profile button aria-label ──────
      const profileBtn = hasProfileBtn ? el.querySelector(':scope > * ' + SEL.profileBtn) : (fullMsgChild?.querySelector(SEL.profileBtn));
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
      
      // Special handling for task/question cards - extract username from the pill badge
      if (isTaskQuestion && !username) {
        // The target username lives in the pill badge: class contains "max-w-"
        // e.g. <span class="max-w-[10rem] truncate">GermanGoonBoy</span>
        for (const badge of el.querySelectorAll('[class*="max-w-"]')) {
          const t = safeText(badge);
          if (t && t.length < 60) { 
            username = t; 
            console.log(`[GG Tracker] Message ${msgId}: Task/Question - extracted username from badge: ${username}`);
            break; 
          }
        }
      }
      
      console.log(`[GG Tracker] Message ${msgId}: Full message - username=${username}, avatarUrl=${avatarUrl ? 'found' : 'null'}`);
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
        console.log(`[GG Tracker] Message ${msgId}: Continuation - found via DOM traversal: username=${username}`);
      }

      // Strategy 2 — module-level state (fallback, handles edge cases
      //              where traversal finds nothing, e.g. very first msg)
      if (!username) {
        username      = lastUser.username;
        avatarUrl     = avatarUrl ?? lastUser.avatarUrl;
        avatarInitial = lastUser.avatarInitial;
        console.log(`[GG Tracker] Message ${msgId}: Continuation - found via lastUser state: username=${username}`);
      }
    }

    // Cannot attribute — genuine anonymous system message, skip
    if (!username) {
      console.log(`[GG Tracker] Message ${msgId}: SKIPPED - no username could be attributed`);
      return null;
    }

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

  function sendToBg(parsed, isRetry = false) {
    if (!parsed) return;
    
    const msgId = parsed.msgId;
    const now = Date.now();
    
    // Track attempt
    const attemptInfo = attempted.get(msgId) || { attempts: 0, lastAttempt: 0 };
    attemptInfo.attempts++;
    attemptInfo.lastAttempt = now;
    attemptInfo.parsed = parsed;
    attempted.set(msgId, attemptInfo);
    
    console.log(`[GG Tracker] Sending message ${msgId} (attempt ${attemptInfo.attempts}${isRetry ? ', RETRY' : ''})`);
    
    chrome.runtime.sendMessage({ type: 'NEW_MESSAGE', payload: parsed }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.log(`[GG Tracker] Send failed for ${msgId}: ${err.message}`);
        // Don't mark as sent - will be retried on next scan if under limit
      } else {
        sent.add(msgId);
        attempted.delete(msgId); // Clean up on success
        console.log(`[GG Tracker] Successfully sent message ${msgId}`);
      }
    });
  }
  
  /** Retry messages that failed to send previously */
  function retryFailedMessages() {
    let retryCount = 0;
    attempted.forEach((info, msgId) => {
      if (info.attempts < MAX_SEND_ATTEMPTS) {
        sendToBg(info.parsed, true);
        retryCount++;
      } else {
        console.log(`[GG Tracker] Giving up on message ${msgId} after ${info.attempts} attempts`);
        attempted.delete(msgId);
      }
    });
    if (retryCount > 0) {
      console.log(`[GG Tracker] Retrying ${retryCount} failed messages`);
    }
  }

  // ============================================================
  // SCAN — process all visible [data-message-id] elements
  // ============================================================

  /**
   * Processes every message in the DOM in document order.
   * Document order is critical: continuation messages must be processed
   * AFTER their preceding full message so DOM traversal succeeds.
   *
   * KEY FIX v1.7: Messages are only skipped if in `sent` Set (confirmed delivered).
   * Messages that failed to send are kept in `attempted` Map and will be retried
   * on next scan (including when user clicks Sync).
   * Returns count of messages attempted (new + retries).
   */
  function scanAll() {
    // DO NOT reset lastUser here - we need it to persist across messages
    // so continuation messages can properly attribute to their sender.
    // The state will naturally update as we process full messages in order.
    const elements = document.querySelectorAll(`[${SEL.msgAttr}]`);
    console.log(`[GG Tracker] scanAll: Found ${elements.length} total messages in DOM, ${sent.size} confirmed sent, ${attempted.size} pending retry`);
    let count = 0;
    let skipped = 0;
    let failed = 0;
    elements.forEach((el, idx) => {
      const msgId = el.getAttribute(SEL.msgAttr);
      // Only skip if confirmed sent (not in attempted/retry queue)
      if (sent.has(msgId)) {
        skipped++;
        return;
      }
      const parsed = parseMessageEl(el);
      if (parsed) { 
        sendToBg(parsed); 
        count++; 
      } else {
        failed++;
        console.log(`[GG Tracker] Failed to parse message ${idx + 1}/${elements.length} (ID: ${msgId})`);
      }
    });
    console.log(`[GG Tracker] scanAll: Attempted ${count} (new/retry), skipped ${skipped} confirmed, ${failed} parse-failed`);
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
        console.log('[GG Tracker] SYNC_CHAT triggered by user');
        // First retry any failed messages from previous attempts
        retryFailedMessages();
        // Then scan for any new messages in DOM
        const count = scanAll();
        highlightTrackedUsers();
        console.log(`[GG Tracker] SYNC_CHAT complete: synced ${count} messages`);
        sendResponse({
          synced: count,
          total:  document.querySelectorAll(`[${SEL.msgAttr}]`).length,
          sent:   sent.size,
          pending: attempted.size,
        });
        break;
      }
      case 'FORCE_RESEND_ALL': {
        console.log('[GG Tracker] FORCE_RESEND_ALL triggered - clearing history and batching all messages');
        
        // Clear the sent set immediately
        const previouslySent = sent.size;
        sent.clear();
        attempted.clear();
        
        // Grab ALL messages from the DOM right now
        const allMessageNodes = Array.from(document.querySelectorAll(MESSAGE_SELECTOR));
        const totalMessages = allMessageNodes.length;
        
        if (totalMessages === 0) {
            console.log('[GG Tracker] No messages found in DOM to resend');
            sendResponse({ resent: 0, cleared: previouslySent, total: 0 });
            return true;
        }

        console.log(`[GG Tracker] Found ${totalMessages} messages to batch resend`);

        let successCount = 0;
        let failCount = 0;

        // Process all messages in a tight loop
        for (const node of allMessageNodes) {
            const parsed = parseMessageNode(node);
            if (!parsed) {
                failCount++;
                continue;
            }

            // Fire and forget for the batch, but track locally
            chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', ...parsed }, (response) => {
                if (chrome.runtime.lastError || !response?.success) {
                    failCount++;
                } else {
                    successCount++;
                    // Add to sent set immediately so normal scan ignores them
                    sent.add(parsed.id);
                }
                
                // Log completion when the last one finishes (approximate)
                if (successCount + failCount >= totalMessages) {
                    console.log(`[GG Tracker] Batch resend complete: ${successCount} sent, ${failCount} failed`);
                }
            });
            
            // Optimistically add to attempted to prevent double firing if scan runs mid-batch
            attempted.set(parsed.id, 1);
        }

        console.log(`[GG Tracker] Dispatched ${totalMessages} messages for batch resend (cleared ${previouslySent} from sent set)`);
        
        // Respond immediately with the count we're processing
        sendResponse({ 
            resent: totalMessages, 
            cleared: previouslySent, 
            total: totalMessages,
            status: 'batch_processing'
        });
        return true; // Keep channel open for async response
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
    console.log('[GG Tracker] v1.7 loaded →', window.location.href);

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
      if (n > 0) {
        console.log(`[GG Tracker] periodic scan: ${n} new messages`);
        highlightTrackedUsers();
      }
    }, SCAN_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

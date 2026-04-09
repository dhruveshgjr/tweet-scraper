/**
 * observer.js
 * ============
 * MutationObserver watcher for new tweet DOM nodes.
 *
 * Runs as a content script on x.com / twitter.com.
 * Loaded AFTER formatters.js, BEFORE scraper.js.
 * Sets window.__tweetObserverNewCount and window.__newTweetsAvailable
 * for scraper.js to read on each loop tick.
 */

// ── Observer Instance ────────────────────────────────
var tweetObserver = null;
var observedTweetCount = 0;

// ── Expose state for scraper.js ──────────────────────
window.__tweetObserverNewCount = 0;
window.__newTweetsAvailable = false;

// ── Find the timeline container ──────────────────────

function findTimelineContainer() {
  var el = document.querySelector('[aria-label="Timeline"]');
  if (el) return el;

  var sections = document.querySelectorAll('section');
  for (var i = 0; i < sections.length; i++) {
    if (sections[i].querySelector('article[data-testid="tweet"]')) {
      return sections[i];
    }
  }

  var main = document.querySelector('main');
  if (main) {
    var divs = main.querySelectorAll('div');
    for (var j = 0; j < divs.length; j++) {
      if (divs[j].querySelector('article[data-testid="tweet"]') && divs[j].querySelector('[role="feed"]')) {
        return divs[j];
      }
    }
  }

  return document.body;
}

// ── Setup Observer ───────────────────────────────────

function initTweetObserver() {
  disconnectTweetObserver();

  var container = findTimelineContainer();
  if (!container) {
    console.warn('[Observer] Timeline container not found — retrying in 2s');
    setTimeout(initTweetObserver, 2000);
    return;
  }

  console.log('[Observer] Watching timeline container');

  tweetObserver = new MutationObserver(function (mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      if (!added) continue;
      for (var n = 0; n < added.length; n++) {
        var node = added[n];
        if (node.nodeType !== 1) continue;
        if (node.querySelector && node.querySelector('[data-testid="tweet"]')) {
          observedTweetCount++;
          window.__tweetObserverNewCount++;
          window.__newTweetsAvailable = true;
        }
        if (node.getAttribute && node.getAttribute('data-testid') === 'tweet') {
          observedTweetCount++;
          window.__tweetObserverNewCount++;
          window.__newTweetsAvailable = true;
        }
      }
    }
  });

  tweetObserver.observe(container, { childList: true, subtree: true });
}

// ── Teardown Observer ────────────────────────────────

function disconnectTweetObserver() {
  if (tweetObserver) {
    tweetObserver.disconnect();
    tweetObserver = null;
  }
  observedTweetCount = 0;
  window.__tweetObserverNewCount = 0;
  window.__newTweetsAvailable = false;
}

// ── Message Listener ─────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'init-observer') {
    initTweetObserver();
    sendResponse({ status: 'observer-initialized' });
  } else if (message.type === 'stop-observer') {
    disconnectTweetObserver();
    sendResponse({ status: 'observer-stopped' });
  }
});

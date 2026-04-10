/**
 * observer.js
 * ============
 * MutationObserver watcher for new tweet DOM nodes.
 *
 * Runs as a content script on x.com / twitter.com.
 * Loaded AFTER formatters.js, BEFORE scraper.js.
 *
 * Exposes for scraper.js:
 *   window.__newTweetsAvailable   — set true when new articles appear
 *   window.__tweetObserverNewCount — count of new articles since last reset
 *   window.__lastNewTweetTimestamp — epoch ms of newest article's time
 *   window.__tweetsInDOM          — live count of all tweet articles in DOM
 *
 * Phase 2 ready: GraphQL layer...
 * To intercept GraphQL on Manifest V3, we inject a <script> into the absolute DOM 
 * to hook `window.fetch` or `XMLHttpRequest`, parse the 'UserTweets'/'SearchTimeline' 
 * endpoints, and pass the JSON out to this content script via window.postMessage.
 * window.__graphqlTweets is exposed to scraper.js.
 */

// ── Observer Instance ────────────────────────────────
var tweetObserver = null;
var observedTweetCount = 0;

// ── Expose state for scraper.js ──────────────────────
window.__tweetObserverNewCount = 0;
window.__newTweetsAvailable = false;
window.__lastNewTweetTimestamp = 0;
window.__tweetsInDOM = 0;

// Phase 2: Reserved for GraphQL interception data
// window.__graphqlTweets = [];

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

// ── Update live tweet count ─────────────────────────────

function updateLiveTweetCount() {
  window.__tweetsInDOM = document.querySelectorAll('article[data-testid="tweet"]').length;
}

// ── Check if a node contains a real tweet article ──────

function nodeContainsTweetArticle(node) {
  if (node.nodeType !== 1) return false;

  if (node.getAttribute && node.getAttribute('data-testid') === 'tweet' && node.tagName === 'ARTICLE') {
    return true;
  }

  if (node.querySelector) {
    return !!node.querySelector('article[data-testid="tweet"]');
  }

  return false;
}

// ── Extract timestamp from a tweet article ──────────────

function extractArticleTimestamp(articleEl) {
  var timeEl = articleEl.querySelector('time[datetime]');
  if (!timeEl) return null;
  var dt = timeEl.getAttribute('datetime');
  if (!dt) return null;
  var d = new Date(dt);
  return isNaN(d.getTime()) ? null : d.getTime();
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

  updateLiveTweetCount();

  tweetObserver = new MutationObserver(function (mutations) {
    var sawNewTweet = false;

    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      if (!added) continue;

      for (var n = 0; n < added.length; n++) {
        var node = added[n];

        if (!nodeContainsTweetArticle(node)) continue;

        var articles = [];
        if (node.tagName === 'ARTICLE' && node.getAttribute('data-testid') === 'tweet') {
          articles.push(node);
        } else if (node.querySelector) {
          var found = node.querySelectorAll('article[data-testid="tweet"]');
          for (var a = 0; a < found.length; a++) {
            articles.push(found[a]);
          }
        }

        for (var ai = 0; ai < articles.length; ai++) {
          observedTweetCount++;
          window.__tweetObserverNewCount++;
          sawNewTweet = true;

          var ts = extractArticleTimestamp(articles[ai]);
          if (ts !== null) {
            window.__lastNewTweetTimestamp = ts;
          }
        }
      }
    }

    if (sawNewTweet) {
      window.__newTweetsAvailable = true;
    }

    updateLiveTweetCount();
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
  window.__lastNewTweetTimestamp = 0;
  updateLiveTweetCount();
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
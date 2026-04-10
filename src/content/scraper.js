/**
 * scraper.js
 * ===========
 * Content script: main extraction engine.
 *
 * Runs as a content script on x.com / twitter.com.
 * Loaded AFTER formatters.js and observer.js.
 * Depends on global functions from formatters.js:
 *   parseTweet, parseEngagementCount, sanitizeTweetText
 * And reads flags set by observer.js:
 *   window.__newTweetsAvailable, window.__tweetObserverNewCount
 */

// ── State ────────────────────────────────────────────
var isExtracting = false;
var isPaused = false;
var extractedTweetIds = {};
var extractedTweets = [];
var batchBuffer = [];
var scrollStallCount = 0;
var lastScrollHeight = 0;
var config = {};
var stopRequested = false;
var reachedDateRange = false;
var totalInRange = 0;
var MAX_TWEETS = 10000;

var BATCH_SIZE = 15;
var SCROLL_MIN_DELAY = 800;
var SCROLL_MAX_DELAY = 1200;
var MAX_STALL_SCROLLS = 8;
var JIGGLE_AMOUNT = 120;

// ── Utility ──────────────────────────────────────────

function randomDelay() {
  return SCROLL_MIN_DELAY + Math.floor(Math.random() * (SCROLL_MAX_DELAY - SCROLL_MIN_DELAY));
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ── Message Listener (commands from background) ─────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  switch (message.type) {
    case 'start-scraping':
      config = message.config || {};
      startScrapeLoop();
      sendResponse({ status: 'scraping-started' });
      break;

    case 'stop-scraping':
      stopRequested = true;
      isExtracting = false;
      sendResponse({ status: 'scraping-stopped' });
      break;

    case 'pause-scraping':
      isPaused = true;
      sendResponse({ status: 'scraping-paused' });
      break;

    case 'resume-scraping':
      isPaused = false;
      sendResponse({ status: 'scraping-resumed' });
      break;

    default:
      break;
  }
  return false;
});

// ── Main Scrape Loop ─────────────────────────────────

async function startScrapeLoop() {
  if (isExtracting) return;

  isExtracting = true;
  isPaused = false;
  stopRequested = false;
  reachedDateRange = false;
  extractedTweetIds = {};
  extractedTweets = [];
  batchBuffer = [];
  scrollStallCount = 0;
  lastScrollHeight = 0;
  totalInRange = 0;

  console.log('[Scraper] Starting extraction for @' + (config.username || 'unknown') + ' | dateFrom=' + config.dateFrom + ' dateTo=' + config.dateTo);

  // Scroll to top first to ensure we start from the newest tweets
  window.scrollTo(0, 0);
  await sleep(1500);

  while (isExtracting && !stopRequested) {
    // Pause handling
    if (isPaused) {
      await sleep(500);
      continue;
    }

    // 1. Extract new tweets from the current DOM
    var newTweets = extractTweetsFromDOM();

    // 2. Filter by date range & detect early-stop boundary
    var inRangeTweets = [];
    for (var ti = 0; ti < newTweets.length; ti++) {
      var t = newTweets[ti];

      if (config.dateTo && isNewerThan(t.timestamp, config.dateTo)) continue;

      if (config.dateFrom && t.timestamp && isOlderThan(t.timestamp, config.dateFrom)) {
        console.log('[Scraper] Reached date range limit → tweet ' + t.tweet_id + ' @ ' + t.timestamp + ' is older than ' + config.dateFrom);
        reachedDateRange = true;
        break;
      }

      inRangeTweets.push(t);
    }

    // 3. Add in-range tweets to batch buffer
    if (inRangeTweets.length > 0) {
      batchBuffer = batchBuffer.concat(inRangeTweets);
      totalInRange += inRangeTweets.length;
      scrollStallCount = 0;
    }

    // 4. Send batch if threshold reached
    if (batchBuffer.length >= BATCH_SIZE) {
      sendBatchToBackground(batchBuffer);
      batchBuffer = [];
    }

    // 5. Check for rate limit / CAPTCHA
    if (detectRateLimitOrCaptcha()) {
      console.warn('[Scraper] Rate limit or CAPTCHA detected — stopping');
      isExtracting = false;
      chrome.runtime.sendMessage({ type: 'RATE_LIMIT' });
      break;
    }

    // 6. Check end-of-feed
    if (isEndOfFeed()) {
      console.log('[Scraper] End of feed reached');
      break;
    }

    // 7. Date range early-stop: flush remaining buffer and stop
    if (reachedDateRange) {
      console.log('[Scraper] Reached date range limit — stopping');
      if (batchBuffer.length > 0) {
        sendBatchToBackground(batchBuffer);
        batchBuffer = [];
      }
      break;
    }

    // 8. Hard cap: 10,000 tweets max
    if (totalInRange >= MAX_TWEETS) {
      console.log('[Scraper] Reached 10,000 tweet hard cap — stopping');
      if (batchBuffer.length > 0) {
        sendBatchToBackground(batchBuffer);
        batchBuffer = [];
      }
      break;
    }

// 9. Auto-scroll
    await autoScroll();

    // 10. Wait for new content to load
    await sleep(randomDelay());

    // 11. Stall detection
    var currentHeight = document.body.scrollHeight;
    if (currentHeight === lastScrollHeight) {
      scrollStallCount++;
    } else {
      scrollStallCount = 0;
    }
    lastScrollHeight = currentHeight;

    if (scrollStallCount >= MAX_STALL_SCROLLS) {
      console.log('[Scraper] Stalled for ' + MAX_STALL_SCROLLS + ' scrolls — ending');
      break;
    }
  }

  // Flush any remaining tweets in the buffer
  if (batchBuffer.length > 0) {
    sendBatchToBackground(batchBuffer);
    batchBuffer = [];
  }

  isExtracting = false;

  var stopReason = reachedDateRange ? 'date_range' : (totalInRange >= MAX_TWEETS ? 'hard_cap' : 'end_of_feed');

  chrome.runtime.sendMessage({ type: 'SCRAPE_COMPLETE', reason: stopReason, totalInRange: totalInRange }, function () {
  });

  console.log('[Scraper] Extraction complete. In-range tweets:', totalInRange, '| Total unique seen:', extractedTweets.length);
}

// ── Tweet Extraction ─────────────────────────────────

function extractTweetsFromDOM() {
  var articles = document.querySelectorAll('article[data-testid="tweet"]');
  var newTweets = [];

  for (var i = 0; i < articles.length; i++) {
    var tweet = parseTweet(articles[i]);
    if (!tweet) continue;
    if (!tweet.tweet_id) continue;

    // De-duplicate
    if (extractedTweetIds[tweet.tweet_id]) continue;
    extractedTweetIds[tweet.tweet_id] = true;

    // Filter: include replies
    if (!config.includeReplies && tweet.is_reply) continue;

    // Filter: only media
    if (config.onlyMedia && !tweet.media_urls) continue;

    extractedTweets.push(tweet);
    newTweets.push(tweet);
  }

  // Reset observer flag
  window.__newTweetsAvailable = false;
  window.__tweetObserverNewCount = 0;

  return newTweets;
}

// ── Date Comparison Helpers ──────────────────────────
// Tweets on profile page are newest-first.
// timestamp: ISO string or null.  dateStr: 'YYYY-MM-DD'

function isOlderThan(timestamp, dateStr) {
  if (!timestamp || !dateStr) return false;
  try {
    var tweetDate = new Date(timestamp);
    if (isNaN(tweetDate.getTime())) return false;
    var limit = new Date(dateStr + 'T00:00:00Z');
    return tweetDate < limit;
  } catch (_) {
    return false;
  }
}

function isNewerThan(timestamp, dateStr) {
  if (!timestamp || !dateStr) return false;
  try {
    var tweetDate = new Date(timestamp);
    if (isNaN(tweetDate.getTime())) return false;
    var limit = new Date(dateStr + 'T23:59:59.999Z');
    return tweetDate > limit;
  } catch (_) {
    return false;
  }
}

// ── Auto-Scroll Logic ───────────────────────────────

async function autoScroll() {
  if (reachedDateRange || totalInRange >= MAX_TWEETS) return;

  var scrollY = window.scrollY;
  var maxScroll = document.body.scrollHeight - window.innerHeight;

  // Main scroll to bottom
  window.scrollTo({
    top: maxScroll,
    behavior: 'smooth'
  });

  await sleep(300);

  // Gentle jiggle: scroll up slightly, then back down
  var jiggle = Math.floor(Math.random() * JIGGLE_AMOUNT) + 40;
  window.scrollTo({
    top: Math.max(scrollY, maxScroll - jiggle),
    behavior: 'smooth'
  });

  await sleep(200);

  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: 'smooth'
  });
}

// ── Batch Sender ─────────────────────────────────────

function sendBatchToBackground(tweets) {
  if (!tweets || tweets.length === 0) return;
  try {
    chrome.runtime.sendMessage({ type: 'TWEET_BATCH', tweets: tweets });
  } catch (e) {
    console.warn('[Scraper] Failed to send batch:', e.message);
  }
}

// ── Rate Limit / CAPTCHA Detection ───────────────────

function detectRateLimitOrCaptcha() {
  // Check for rate limit banners
  var rateLimitEl = document.querySelector('[data-testid="toast"] span');
  if (rateLimitEl) {
    var text = rateLimitEl.textContent || '';
    if (text.indexOf('rate limit') !== -1 || text.indexOf('try again') !== -1) {
      return true;
    }
  }

  // Check for generic error banners
  var errorBanners = document.querySelectorAll('[role="alert"]');
  for (var i = 0; i < errorBanners.length; i++) {
    var alertText = errorBanners[i].textContent || '';
    if (alertText.indexOf('rate limit') !== -1 || alertText.indexOf('temporarily locked') !== -1) {
      return true;
    }
  }

  return false;
}

// ── End-of-Feed Detection ────────────────────────────

function isEndOfFeed() {
  // Look for explicit "no more tweets" or end-of-feed signals
  var allText = document.body.innerText;
  if (allText.indexOf('Something went wrong') !== -1 && allText.indexOf('Try reloading') !== -1) {
    return true;
  }

  // Check for the empty state at the bottom of the timeline
  var sentinel = document.querySelector('[data-testid="emptyState"]');
  if (sentinel) return true;

  // If stalled for too many scrolls with no new tweets detected
  if (scrollStallCount >= MAX_STALL_SCROLLS) return true;

  return false;
}

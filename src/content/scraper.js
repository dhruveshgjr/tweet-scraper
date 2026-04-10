/**
 * scraper.js
 * ===========
 * Content script: main extraction engine.
 *
 * Runs as a content script on x.com / twitter.com.
 * Loaded AFTER formatters.js and observer.js.
 *
 * Key design decisions for reliability on high-volume accounts:
 * - Never scrolls faster than the page can render
 * - Waits intelligently for new content (polls DOM + observer, up to 4s)
 * - Resets stall counter when ANY new tweets are found (not just in-range)
 * - Does a second extraction pass after content loads to catch late renders
 * - Date-range stop checks both single-tweet and multi-tweet confirmation
 */

// ── State ────────────────────────────────────────────
var isExtracting = false;
var isPaused = false;
var extractedTweetIds = {};
var extractedTweets = [];
var batchBuffer = [];
var scrollStallCount = 0;
var lastScrollHeight = 0;
var lastTweetCountInDOM = 0;
var emptyPassCount = 0;
var config = {};
var stopRequested = false;
var reachedDateRange = false;
var totalInRange = 0;
var MAX_TWEETS = 10000;

var BATCH_SIZE = 15;
var MAX_STALL_SCROLLS = 15;
var MAX_EMPTY_PASSES = 5;
var JIGGLE_AMOUNT = 120;
var CONTENT_WAIT_MS = 4000;
var CONTENT_POLL_MS = 200;
var SECOND_PASS_DELAY_MS = 800;

// ── Utility ──────────────────────────────────────────

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * waitForNewContent — intelligent wait after scrolling.
 * Polls the MutationObserver flag but waits for the exact render cycle to settle.
 * Returns true if new content was detected, false if timed out.
 */
function waitForNewContent() {
  return new Promise(function (resolve) {
    var elapsed = 0;
    var idleTime = 0;
    var sawNewContent = false;

    var poll = setInterval(function () {
      elapsed += CONTENT_POLL_MS;

      // Check MutationObserver signal
      if (window.__newTweetsAvailable) {
        sawNewContent = true;
        idleTime = 0; // Reset idle timer since DOM is still actively mutating
        window.__newTweetsAvailable = false;
      } else if (sawNewContent) {
        // We saw content, but now the DOM is quiet
        idleTime += CONTENT_POLL_MS;
        if (idleTime >= 400 || elapsed >= CONTENT_WAIT_MS) {
          clearInterval(poll);
          resolve(true);
          return;
        }
      }

      if (elapsed >= CONTENT_WAIT_MS) {
        clearInterval(poll);
        resolve(sawNewContent);
      }
    }, CONTENT_POLL_MS);
  });
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
      console.log('[Scraper] Resumed from pause');
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
  lastTweetCountInDOM = 0;
  emptyPassCount = 0;
  totalInRange = 0;

  var opts = [];
  if (config.includeReplies !== undefined) opts.push('replies=' + config.includeReplies);
  if (config.includeReposts !== undefined) opts.push('reposts=' + config.includeReposts);
  console.log('[Scraper] Starting extraction for @' + (config.username || 'unknown') + ' | dateFrom=' + config.dateFrom + ' dateTo=' + config.dateTo + ' | ' + opts.join(', '));

  // Scroll to top, then wait longer for initial page render
  window.scrollTo(0, 0);
  await sleep(2000);

  while (isExtracting && !stopRequested) {
    if (isPaused) {
      await sleep(500);
      continue;
    }

    // ── 1. Extract new tweets from the current DOM ────────
    var newTweets = extractTweetsFromDOM();
    var newTweetsFound = newTweets.length > 0;

    // ── 2. Filter by date range early-stop ──────────────
    var inRangeTweets = [];
    for (var ti = 0; ti < newTweets.length; ti++) {
      var t = newTweets[ti];

      // Skip tweets newer than dateTo
      if (config.dateTo && isNewerThan(t.timestamp, config.dateTo)) continue;

      // Check if tweet is older than dateFrom IMMEDIATELY
      if (config.dateFrom && t.timestamp && isOlderThan(t.timestamp, config.dateFrom)) {
        console.log('[Scraper] Date boundary → tweet ' + t.tweet_id + ' @ ' + t.timestamp + ' older than ' + config.dateFrom);
        reachedDateRange = true;
        break;
      }

      inRangeTweets.push(t);
    }

    // ── 3. Add in-range tweets to batch buffer ──────────
    if (inRangeTweets.length > 0) {
      batchBuffer = batchBuffer.concat(inRangeTweets);
      totalInRange += inRangeTweets.length;
    }

    // Reset stall and empty-pass counters whenever we find ANY new tweet
    // (not just in-range ones — this is the key fix for high-volume accounts)
    if (newTweetsFound) {
      scrollStallCount = 0;
      emptyPassCount = 0;
    }

    // ── 4. Send batch if threshold reached ──────────────
    if (batchBuffer.length >= BATCH_SIZE) {
      sendBatchToBackground(batchBuffer);
      batchBuffer = [];
    }

    // ── 5. Check for rate limit / CAPTCHA ───────────────
    var rateLimitDetected = detectRateLimitOrCaptcha();
    if (rateLimitDetected) {
      console.warn('[Scraper] Rate limit or CAPTCHA detected — pausing');
      isPaused = true;
      chrome.runtime.sendMessage({ type: 'RATE_LIMIT', reason: rateLimitDetected });
      broadcastScrapeStatus('rate_limited');
      break;
    }

    // ── 6. Check end-of-feed ───────────────────────────
    if (isEndOfFeed()) {
      console.log('[Scraper] End of feed reached');
      break;
    }

    // ── 7. Date range early-stop ────────────────────────
    if (reachedDateRange) {
      console.log('[Scraper] Reached date range limit — stopping');
      if (batchBuffer.length > 0) {
        sendBatchToBackground(batchBuffer);
        batchBuffer = [];
      }
      break;
    }

    // ── 8. Hard cap: 10,000 tweets max ──────────────────
    if (totalInRange >= MAX_TWEETS) {
      console.log('[Scraper] Reached 10,000 tweet hard cap — stopping');
      if (batchBuffer.length > 0) {
        sendBatchToBackground(batchBuffer);
        batchBuffer = [];
      }
      break;
    }

    // ── 9. Auto-scroll ──────────────────────────────────
    var preScrollHeight = document.body.scrollHeight;
    var preScrollTweetCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    await autoScroll();

    // ── 10. Intelligent wait for new content ────────────
    var gotNewContent = await waitForNewContent();

    if (!gotNewContent) {
      // No MutationObserver signal and no DOM count increase.
      // Check if page grew at all (height change without tweet count change
      // can mean X is lazy-rendering intermediate content)
      var postScrollHeight = document.body.scrollHeight;
      if (postScrollHeight > preScrollHeight) {
        await sleep(1500);
      }

      // Second extraction pass: after the extra wait, check again
      var secondPassTweets = extractTweetsFromDOM();
      if (secondPassTweets.length > 0) {
        newTweetsFound = true;
        emptyPassCount = 0;
        // Process these tweets through date filter
        for (var si = 0; si < secondPassTweets.length; si++) {
          var st = secondPassTweets[si];
          if (config.dateTo && isNewerThan(st.timestamp, config.dateTo)) continue;
          if (config.dateFrom && st.timestamp && isOlderThan(st.timestamp, config.dateFrom)) {
            reachedDateRange = true;
            break;
          }
          inRangeTweets.push(st);
          batchBuffer.push(st);
          totalInRange++;
        }
        scrollStallCount = 0;
      }
    }

    // ── 11. Stall detection ─────────────────────────────
    // Count tweets in DOM to detect real content changes
    var currentTweetCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    var currentHeight = document.body.scrollHeight;

    // A stall is when: page height doesn't change AND tweet count doesn't change
    var heightStalled = (currentHeight === lastScrollHeight);
    var countStalled = (currentTweetCount === lastTweetCountInDOM);

    if (heightStalled && countStalled) {
      scrollStallCount++;
      emptyPassCount++;
    } else {
      scrollStallCount = 0;
    }

    lastScrollHeight = currentHeight;
    lastTweetCountInDOM = currentTweetCount;

    // Too many consecutive empty passes = true end of feed
    if (scrollStallCount >= MAX_STALL_SCROLLS || emptyPassCount >= MAX_EMPTY_PASSES) {
      console.log('[Scraper] Stalled — no new content for ' + emptyPassCount + ' passes (height stalled: ' + heightStalled + ', count stalled: ' + countStalled + ')');
      break;
    }
  }

  // ── Flush remaining buffer ────────────────────────────
  if (batchBuffer.length > 0) {
    sendBatchToBackground(batchBuffer);
    batchBuffer = [];
  }

  isExtracting = false;

  var stopReason = reachedDateRange ? 'date_range' : (totalInRange >= MAX_TWEETS ? 'hard_cap' : 'end_of_feed');

  chrome.runtime.sendMessage({ type: 'SCRAPE_COMPLETE', reason: stopReason, totalInRange: totalInRange }, function () {
  });

  console.log('[Scraper] Extraction complete. In-range:', totalInRange, '| Total unique seen:', extractedTweets.length);
}

// ── Tweet Extraction ─────────────────────────────────

function extractTweetsFromDOM() {
  if (reachedDateRange) return [];

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

    // Filter: include reposts & quotes - EXCLUDE both if toggled off
    if (config.includeReposts === false && (tweet.is_retweet || tweet.quoted_tweet_id)) continue;

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

  // Step 1: Smooth scroll down to near the bottom
  window.scrollTo({
    top: maxScroll,
    behavior: 'smooth'
  });

  // Brief pause to let the browser render the scroll
  await sleep(400);

  // Step 2: Gentle jiggle — scroll up slightly, then back down
  // This triggers X's lazy-loading by revealing content just above the bottom
  var jiggle = Math.floor(Math.random() * JIGGLE_AMOUNT) + 50;
  window.scrollTo({
    top: Math.max(scrollY, maxScroll - jiggle),
    behavior: 'smooth'
  });

  await sleep(250);

  // Step 3: Final scroll to absolute bottom
  window.scrollTo({
    top: document.body.scrollHeight,
    behavior: 'smooth'
  });

  // Small settle delay after the final scroll
  await sleep(300);
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
  var rateLimitEl = document.querySelector('[data-testid="toast"] span');
  if (rateLimitEl) {
    var text = rateLimitEl.textContent || '';
    if (text.indexOf('rate limit') !== -1 || text.indexOf('try again') !== -1) {
      return 'rate_limit';
    }
  }

  var errorBanners = document.querySelectorAll('[role="alert"]');
  for (var i = 0; i < errorBanners.length; i++) {
    var alertText = errorBanners[i].textContent || '';
    if (alertText.indexOf('rate limit') !== -1) {
      return 'rate_limit';
    }
    if (alertText.indexOf('temporarily locked') !== -1 || alertText.indexOf('temporarily restricted') !== -1) {
      return 'locked';
    }
  }

  return false;
}

// ── End-of-Feed Detection ────────────────────────────

function isEndOfFeed() {
  var allText = document.body.innerText;
  if (allText.indexOf('Something went wrong') !== -1 && allText.indexOf('Try reloading') !== -1) {
    return true;
  }

  var sentinel = document.querySelector('[data-testid="emptyState"]');
  if (sentinel) return true;

  return false;
}

// ── Status Broadcast Helper ────────────────────────────

function broadcastScrapeStatus(status) {
  try {
    chrome.runtime.sendMessage({ type: 'SCRAPE_STATUS', status: status });
  } catch (_) {}
}
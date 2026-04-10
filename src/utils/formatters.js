/**
 * formatters.js
 * =============
 * Shared utility: parsing, formatting, and DOM extraction helpers.
 *
 * Loaded as a content script BEFORE observer.js and scraper.js,
 * so all functions are available globally in the content script world.
 */

// ── Date Parsing ─────────────────────────────────────

function parseXTimestamp(timeElement) {
  if (!timeElement) return null;
  var dt = timeElement.getAttribute('datetime');
  if (!dt || typeof dt !== 'string') return null;

  var d = tryParseDate(dt);
  if (d && !isNaN(d.getTime())) {
    return d.toISOString();
  }

  return null;
}

function tryParseDate(dt) {
  var d = new Date(dt);
  if (!isNaN(d.getTime())) return d;

  var m;

  m = dt.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  }

  m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (m) {
    return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10)));
  }

  m = dt.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    return new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0));
  }

  return null;
}

// ── Date Formatting for Search URLs ──────────────────

function formatDateForSearch(dateString) {
  if (!dateString) return '';
  return dateString;
}

// ── Number Parsing ───────────────────────────────────

function parseEngagementCount(text) {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim();
  if (!cleaned) return 0;
  const match = cleaned.match(/([\d.]+)\s*([KkMmBb]?)/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  if (isNaN(num)) return 0;
  const suffix = match[2].toUpperCase();
  if (suffix === 'K') num *= 1000;
  else if (suffix === 'M') num *= 1000000;
  else if (suffix === 'B') num *= 1000000000;
  return Math.floor(num);
}

// ── Text Sanitization ────────────────────────────────

function sanitizeTweetText(rawText) {
  if (!rawText) return '';
  return rawText
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ── URL Builders ─────────────────────────────────────

function buildProfileURL(username) {
  return 'https://x.com/' + encodeURIComponent(username.replace(/^@/, ''));
}

function buildSearchURL(username, dateFrom, dateTo, includeReplies) {
  let q = 'from:' + username;
  if (dateFrom) q += ' since:' + formatDateForSearch(dateFrom);
  if (dateTo) q += ' until:' + formatDateForSearch(dateTo);
  if (!includeReplies) q += ' -filter:replies';
  return 'https://x.com/search?q=' + encodeURIComponent(q) + '&src=typed_query&f=live';
}

// ── Tweet DOM Parser ─────────────────────────────────
// Extracts all 14 CSV columns from a single tweet <article> node.

function parseTweet(article) {
  if (!article) return null;

  // ── tweet_id & tweet_url ───────────────────────────
  var tweetId = '';
  var tweetUrl = '';
  var timeEl = article.querySelector('time[datetime]');
  if (timeEl) {
    var link = timeEl.closest('a[href]');
    if (link) {
      tweetUrl = link.href;
      var idMatch = tweetUrl.match(/\/status\/(\d+)/);
      if (idMatch) tweetId = idMatch[1];
    }
  }

  if (!tweetId) return null;

  // ── timestamp ──────────────────────────────────────
  var timestamp = timeEl ? parseXTimestamp(timeEl) : null;

  // ── full_text & language ───────────────────────────
  var tweetTextEl = article.querySelector('[data-testid="tweetText"]');
  var full_text = tweetTextEl ? sanitizeTweetText(tweetTextEl.innerText) : '';
  var language = tweetTextEl ? (tweetTextEl.getAttribute('lang') || '') : '';

  // ── engagement counts ──────────────────────────────
  var replyCount = 0;
  var replyBtn = article.querySelector('[data-testid="reply"]');
  if (replyBtn) {
    replyCount = parseEngagementCount(replyBtn.getAttribute('aria-label'));
  }

  var repostCount = 0;
  var retweetBtn = article.querySelector('[data-testid="retweet"]');
  if (retweetBtn) {
    repostCount = parseEngagementCount(retweetBtn.getAttribute('aria-label'));
  }

  var likeCount = 0;
  var likeBtn = article.querySelector('[data-testid="like"]');
  if (likeBtn) {
    likeCount = parseEngagementCount(likeBtn.getAttribute('aria-label'));
  }

  // ── view_count ─────────────────────────────────────
  var viewCount = 0;
  var viewEl = article.querySelector('[data-testid="view"]');
  if (viewEl) {
    viewCount = parseEngagementCount(viewEl.getAttribute('aria-label'));
  }
  if (!viewCount) {
    var analyticsLink = article.querySelector('a[href*="analytics"]');
    if (analyticsLink) {
      viewCount = parseEngagementCount(analyticsLink.getAttribute('aria-label'));
    }
  }

  // ── is_reply ───────────────────────────────────────
  var isReply = false;
  if (tweetTextEl && tweetTextEl.parentElement) {
    var siblings = tweetTextEl.parentElement.children;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i] === tweetTextEl) break;
      if (siblings[i].textContent.indexOf('Replying to') !== -1) {
        isReply = true;
        break;
      }
    }
  }
  if (!isReply) {
    var spans = article.querySelectorAll('span');
    for (var j = 0; j < spans.length; j++) {
      if (spans[j].textContent.indexOf('Replying to') !== -1) {
        isReply = true;
        break;
      }
    }
  }

  // ── is_retweet ─────────────────────────────────────
  var isRetweet = false;
  var repostAuthor = '';

  // Primary: socialContext data-testid (X 2025+ repost header)
  var socialCtx = article.querySelector('[data-testid="socialContext"]');
  if (socialCtx) {
    var ctxText = (socialCtx.textContent || '').trim().toLowerCase();
    if (ctxText.indexOf('reposted') !== -1 || ctxText.indexOf('retweeted') !== -1) {
      isRetweet = true;
      // Try to extract the reposter context — "User Reposted"
      var repostLink = socialCtx.querySelector('a[href^="/"]');
      if (repostLink) {
        repostAuthor = (repostLink.getAttribute('href') || '').replace(/^\//, '');
      } else {
        var words = ctxText.split(' ');
        if (words.length > 0) repostAuthor = words[0];
      }
    }
  }

  // Fallback 1: Check parent/sibling elements for repost label outside the article
  if (!isRetweet && article.parentElement) {
    var parent = article.parentElement;
    var children = parent.children;
    for (var k = 0; k < children.length; k++) {
      if (children[k] === article) continue;
      var sibText = (children[k].textContent || '').trim().toLowerCase();
      if (sibText.indexOf('reposted') !== -1 || sibText.indexOf('retweeted') !== -1) {
        isRetweet = true;
        var sibLink = children[k].querySelector('a[href^="/"]');
        if (sibLink) {
          repostAuthor = (sibLink.getAttribute('href') || '').replace(/^\//, '');
        }
        break;
      }
    }
  }

  // Fallback 2: Check for "Reposted" spans within the article itself
  if (!isRetweet) {
    var allSpans = article.querySelectorAll('span');
    for (var si = 0; si < allSpans.length; si++) {
      var spanText = (allSpans[si].textContent || '').trim().toLowerCase();
      // X uses "You Reposted" or "Username Reposted" in a small header span
      if (spanText === 'reposted' || spanText === 'retweeted' ||
          spanText.indexOf(' reposted') !== -1 || spanText.indexOf(' retweeted') !== -1) {
        // Make sure this isn't the engagement count button text
        var spanParent = allSpans[si].closest('[data-testid="retweet"]');
        if (spanParent) continue;
        isRetweet = true;
        break;
      }
    }
  }

  // ── quoted_tweet_id ────────────────────────────────
  var quotedTweetId = '';
  // Primary: data-testid="quoteTweet" container
  var quoteEl = article.querySelector('[data-testid="quoteTweet"]');
  
  // Fallback: look for generic link wrappers that contain status urls but not the main tweet
  if (!quoteEl) {
    var links = article.querySelectorAll('div[role="link"]:not([data-testid="tweet"])');
    for (var li = 0; li < links.length; li++) {
      var hrefNode = links[li].querySelector('a[href*="/status/"]');
      if (hrefNode) {
        var hrefStr = hrefNode.getAttribute('href') || '';
        if (hrefStr.indexOf('/photo/') !== -1 || hrefStr.indexOf('/video/') !== -1) continue;
        var qmFallback = hrefStr.match(/\/status\/(\d+)/);
        if (qmFallback && qmFallback[1] !== tweetId) {
          quoteEl = links[li];
          break;
        }
      }
    }
  }

  // Final fallback
  if (!quoteEl) {
    var allQuoteLinks = article.querySelectorAll('a[href*="/status/"]');
    for (var qi = 0; qi < allQuoteLinks.length; qi++) {
      var qaHref = allQuoteLinks[qi].getAttribute('href') || allQuoteLinks[qi].href || '';
      // Skip the tweet's own permalink, analytics, media
      if (qaHref.indexOf('analytics') !== -1 || qaHref.indexOf('/photo/') !== -1 || qaHref.indexOf('/video/') !== -1) continue;
      var qm = qaHref.match(/\/status\/(\d+)/);
      if (qm && qm[1] !== tweetId) {
        quoteEl = allQuoteLinks[qi];
        break;
      }
    }
  }
  
  if (quoteEl) {
    var qLink = quoteEl.tagName === 'A' ? quoteEl : (quoteEl.querySelector('a[href*="/status/"]') || quoteEl);
    var qHref = qLink ? (qLink.getAttribute('href') || qLink.href || '') : '';
    var qMatch = qHref.match(/\/status\/(\d+)/);
    if (qMatch) quotedTweetId = qMatch[1];
  }

  // ── media_urls ─────────────────────────────────────
  var mediaUrls = [];
  var photos = article.querySelectorAll('[data-testid="tweetPhoto"] img');
  for (var p = 0; p < photos.length; p++) {
    var src = photos[p].getAttribute('src');
    if (src) mediaUrls.push(src);
  }
  var videos = article.querySelectorAll('video source, video[src]');
  for (var v = 0; v < videos.length; v++) {
    var vSrc = videos[v].getAttribute('src');
    if (vSrc) mediaUrls.push(vSrc);
  }

  // ── source ─────────────────────────────────────────
  var source = '';
  var sourceEl = article.querySelector('a[href*="source"]');
  if (sourceEl) source = sourceEl.textContent.trim();

  return {
    tweet_id: tweetId,
    timestamp: timestamp,
    full_text: full_text,
    reply_count: replyCount,
    repost_count: repostCount,
    like_count: likeCount,
    view_count: viewCount,
    is_reply: isReply,
    is_retweet: isRetweet,
    repost_author: repostAuthor,
    quoted_tweet_id: quotedTweetId,
    media_urls: mediaUrls.join(','),
    tweet_url: tweetUrl,
    language: language,
    source: source
  };
}

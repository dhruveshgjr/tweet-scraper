/**
 * service_worker.js
 * =================
 * Background service worker: central hub for the extension.
 *
 * Orchestrates real extraction: navigates to X profile,
 * commands content scripts to scrape, aggregates tweet data,
 * and triggers CSV download on completion.
 */

import { tweetsToCSV, createCSVBlob } from '../utils/csv_exporter.js';

// ── Session State ────────────────────────────────────
var sessionState = {
  isRunning: false,
  isPaused: false,
  stopReason: '',
  username: '',
  dateFrom: null,
  dateTo: null,
  includeReplies: false,
  onlyMedia: false,
  includeReposts: true,
  exportAll: false,
  tweets: [],
  totalCaptured: 0,
  estimatedTotal: 10000,
  activeTabId: null,
  lastDownloadId: null,
  downloadTriggered: false
};

// ── Message Router ───────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  switch (message.type) {

    case 'START_EXPORT':
      handleStartExport(message.config, sendResponse);
      return true;

    case 'STOP_EXPORT':
      handleStopExport(sendResponse);
      return true;

    case 'RESUME_EXPORT':
      handleResumeExport(sendResponse);
      return true;

    case 'GET_STATUS':
      sendResponse({
        isRunning: sessionState.isRunning,
        isPaused: sessionState.isPaused,
        username: sessionState.username,
        totalCaptured: sessionState.totalCaptured,
        estimatedTotal: sessionState.estimatedTotal,
        stopReason: sessionState.stopReason,
        lastDownloadId: sessionState.lastDownloadId
      });
      return false;

    case 'TWEET_BATCH':
      handleTweetBatch(message.tweets);
      sendResponse({ status: 'received' });
      return false;

    case 'RATE_LIMIT':
      handleRateLimit(message.reason);
      sendResponse({ status: 'acknowledged' });
      return false;

    case 'SCRAPE_COMPLETE':
      handleScrapeComplete(message.reason);
      sendResponse({ status: 'acknowledged' });
      return false;

    case 'OPEN_CSV':
      handleOpenCSV(sendResponse);
      return true;

    default:
      sendResponse({ status: 'unknown_type' });
      return false;
  }
});

// ── Handler: Start Export ────────────────────────────

function handleStartExport(config, sendResponse) {
  sessionState.isRunning = true;
  sessionState.isPaused = false;
  sessionState.stopReason = '';
  sessionState.username = config.username;
  sessionState.dateFrom = config.dateFrom;
  sessionState.dateTo = config.dateTo;
  sessionState.includeReplies = config.includeReplies;
  sessionState.onlyMedia = config.onlyMedia;
  sessionState.includeReposts = config.includeReposts;
  sessionState.exportAll = config.exportAll;
  sessionState.tweets = [];
  sessionState.totalCaptured = 0;
  sessionState.estimatedTotal = 10000;
  sessionState.lastDownloadId = null;
  sessionState.downloadTriggered = false;

  console.log('[ServiceWorker] Export started for @' + config.username, config);

  saveLastConfig(config);
  startExtraction(config);

  sendResponse({ status: 'started' });
}

// ── Handler: Stop Export ─────────────────────────────

function handleStopExport(sendResponse) {
  console.log('[ServiceWorker] Export stopped by user. Total captured:', sessionState.totalCaptured);

  stopExtraction();
  sessionState.isRunning = false;
  sessionState.isPaused = false;
  sessionState.stopReason = 'user_stop';

  broadcastToPopup({
    type: 'EXPORT_STOPPING',
    totalCaptured: sessionState.totalCaptured
  });

  triggerCSVDownload();

  sendResponse({ status: 'stopped', totalCaptured: sessionState.totalCaptured });
}

// ── Handler: Resume Export ────────────────────────────

function handleResumeExport(sendResponse) {
  if (!sessionState.isPaused) {
    sendResponse({ status: 'not_paused' });
    return;
  }

  console.log('[ServiceWorker] Resuming export for @' + sessionState.username);
  sessionState.isPaused = false;
  sessionState.isRunning = true;
  sessionState.stopReason = '';
  sessionState.downloadTriggered = false;

  if (sessionState.activeTabId) {
    chrome.tabs.sendMessage(sessionState.activeTabId, { type: 'resume-scraping' }).catch(function () {});
  }

  broadcastToPopup({ type: 'PROGRESS_UPDATE', totalCaptured: sessionState.totalCaptured, estimatedTotal: sessionState.estimatedTotal });
  sendResponse({ status: 'resumed' });
}

// ── Handler: Tweet Batch ─────────────────────────────

function handleTweetBatch(tweets) {
  if (!Array.isArray(tweets)) return;

  sessionState.tweets = sessionState.tweets.concat(tweets);
  sessionState.totalCaptured = sessionState.tweets.length;

  console.log('[ServiceWorker] Batch received:', tweets.length, 'Total:', sessionState.totalCaptured);

  broadcastProgress();
}

// ── Handler: Rate Limit ──────────────────────────────

function handleRateLimit(reason) {
  console.warn('[ServiceWorker] Rate limit detected —', reason, '| Pausing extraction');
  sessionState.isPaused = true;
  sessionState.stopReason = 'rate_limit';

  if (sessionState.activeTabId) {
    chrome.tabs.sendMessage(sessionState.activeTabId, { type: 'pause-scraping' }).catch(function () {});
  }

  broadcastToPopup({
    type: 'RATE_LIMIT',
    reason: reason || 'rate_limit',
    totalCaptured: sessionState.totalCaptured
  });
}

// ── Handler: Scrape Complete ─────────────────────────

function handleScrapeComplete(reason) {
  var reasonText = '';
  if (reason === 'date_range') {
    reasonText = ' (date range limit reached)';
  } else if (reason === 'hard_cap') {
    reasonText = ' (10k hard cap reached)';
  }
  console.log('[ServiceWorker] Scrape complete.' + reasonText + ' Total captured:', sessionState.totalCaptured, '| dateFrom:', sessionState.dateFrom, '| dateTo:', sessionState.dateTo);
  sessionState.isRunning = false;
  sessionState.isPaused = false;
  sessionState.stopReason = reason || 'complete';

  if (!sessionState.downloadTriggered) {
    triggerCSVDownload();
  }

  broadcastToPopup({
    type: 'EXPORT_COMPLETE',
    reason: reason || 'complete',
    totalCaptured: sessionState.totalCaptured
  });
}

// ── Handler: Open CSV ────────────────────────────────

function handleOpenCSV(sendResponse) {
  if (sessionState.lastDownloadId) {
    chrome.downloads.show(sessionState.lastDownloadId);
    sendResponse({ status: 'opened' });
  } else {
    sendResponse({ status: 'no_download' });
  }
}

// ── Real Extraction Orchestration ────────────────────

async function startExtraction(config) {
  var url = 'https://x.com/' + encodeURIComponent(config.username.replace(/^@/, ''));

  try {
    var tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    var tab;

    if (tabs.length > 0) {
      tab = tabs[0];
      await chrome.tabs.update(tab.id, { url: url, active: true });
    } else {
      tab = await chrome.tabs.create({ url: url, active: true });
    }

    sessionState.activeTabId = tab.id;

    await waitForTabLoad(tab.id);
    await sleep(2000);

    await sendMessageToTab(tab.id, { type: 'init-observer' });

    await sendMessageToTab(tab.id, {
      type: 'start-scraping',
      config: {
        username: config.username,
        dateFrom: config.dateFrom,
        dateTo: config.dateTo,
        includeReplies: config.includeReplies,
        includeReposts: config.includeReposts,
        onlyMedia: config.onlyMedia
      }
    });

    console.log('[ServiceWorker] Scraper started on tab', tab.id);

  } catch (e) {
    console.error('[ServiceWorker] Failed to start extraction:', e);
    sessionState.isRunning = false;
    broadcastToPopup({
      type: 'EXPORT_ERROR',
      error: 'Failed to start extraction: ' + e.message
    });
  }
}

function stopExtraction() {
  if (sessionState.activeTabId) {
    chrome.tabs.sendMessage(sessionState.activeTabId, { type: 'stop-scraping' }).catch(function () {});
    chrome.tabs.sendMessage(sessionState.activeTabId, { type: 'stop-observer' }).catch(function () {});
  }
}

// ── Tab Helpers ──────────────────────────────────────

function waitForTabLoad(tabId) {
  return new Promise(function (resolve) {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(function () {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

function sendMessageToTab(tabId, message, maxRetries) {
  maxRetries = maxRetries || 3;
  var attempts = 0;

  function trySend() {
    return chrome.tabs.sendMessage(tabId, message).catch(function (e) {
      attempts++;
      if (attempts < maxRetries) {
        console.log('[ServiceWorker] Retry', attempts, 'for tab', tabId);
        return sleep(1500 * attempts).then(trySend);
      }
      throw e;
    });
  }

  return trySend();
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ── CSV Download ─────────────────────────────────────

function triggerCSVDownload() {
  if (sessionState.downloadTriggered) {
    console.log('[ServiceWorker] CSV download already triggered — skipping duplicate');
    return;
  }
  sessionState.downloadTriggered = true;

  if (sessionState.tweets.length === 0) {
    console.warn('[ServiceWorker] No tweets to export');
    broadcastToPopup({ type: 'EXPORT_COMPLETE', reason: 'no_data', totalCaptured: 0 });
    return;
  }

  try {
    var csvString = tweetsToCSV(sessionState.tweets);
    var blobContent = createCSVBlob(csvString);
    var dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(blobContent);

    var df = sessionState.dateFrom || 'unknown';
    var dt = sessionState.dateTo || 'unknown';
    var filename = sessionState.username + '_tweets_' + df + '_to_' + dt + '.csv';

    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    }).then(function (downloadId) {
      console.log('[ServiceWorker] CSV download started, id:', downloadId, 'filename:', filename);
      sessionState.lastDownloadId = downloadId;

      broadcastToPopup({
        type: 'DOWNLOAD_READY',
        downloadId: downloadId,
        filename: filename,
        totalCaptured: sessionState.totalCaptured
      });
    }).catch(function (e) {
      console.error('[ServiceWorker] CSV download failed:', e);
    });

  } catch (e) {
    console.error('[ServiceWorker] CSV generation failed:', e);
  }
}

// ── Progress Broadcasting ────────────────────────────

function broadcastProgress() {
  broadcastToPopup({
    type: 'PROGRESS_UPDATE',
    totalCaptured: sessionState.totalCaptured,
    estimatedTotal: sessionState.estimatedTotal
  });
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage(message).catch(function () {});
}

// ── Persistent Config (chrome.storage.local) ────────

function saveLastConfig(config) {
  try {
    chrome.storage.local.set({
      lastConfig: {
        username: config.username,
        dateFrom: config.dateFrom,
        dateTo: config.dateTo,
        includeReplies: config.includeReplies,
        includeReposts: config.includeReposts,
        onlyMedia: config.onlyMedia,
        exportAll: config.exportAll
      }
    });
  } catch (_) {}
}
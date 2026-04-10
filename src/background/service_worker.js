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
  username: '',
  dateFrom: null,
  dateTo: null,
  includeReplies: false,
  onlyMedia: false,
  exportAll: false,
  tweets: [],
  totalCaptured: 0,
  estimatedTotal: 10000,
  activeTabId: null
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

    case 'GET_STATUS':
      sendResponse({
        isRunning: sessionState.isRunning,
        username: sessionState.username,
        totalCaptured: sessionState.totalCaptured,
        estimatedTotal: sessionState.estimatedTotal
      });
      return false;

    case 'TWEET_BATCH':
      handleTweetBatch(message.tweets);
      sendResponse({ status: 'received' });
      return false;

    case 'RATE_LIMIT':
      handleRateLimit();
      sendResponse({ status: 'acknowledged' });
      return false;

    case 'SCRAPE_COMPLETE':
      handleScrapeComplete(message.reason);
      sendResponse({ status: 'acknowledged' });
      return false;

    default:
      sendResponse({ status: 'unknown_type' });
      return false;
  }
});

// ── Handler: Start Export ────────────────────────────

function handleStartExport(config, sendResponse) {
  sessionState.isRunning = true;
  sessionState.username = config.username;
  sessionState.dateFrom = config.dateFrom;
  sessionState.dateTo = config.dateTo;
  sessionState.includeReplies = config.includeReplies;
  sessionState.onlyMedia = config.onlyMedia;
  sessionState.exportAll = config.exportAll;
  sessionState.tweets = [];
  sessionState.totalCaptured = 0;
  sessionState.estimatedTotal = 10000;

  console.log('[ServiceWorker] Export started for @' + config.username, config);

  startExtraction(config);

  sendResponse({ status: 'started' });
}

// ── Handler: Stop Export ─────────────────────────────

function handleStopExport(sendResponse) {
  console.log('[ServiceWorker] Export stopped. Total captured:', sessionState.totalCaptured);

  stopExtraction();
  sessionState.isRunning = false;

  sendResponse({ status: 'stopped', totalCaptured: sessionState.totalCaptured });
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

function handleRateLimit() {
  console.warn('[ServiceWorker] Rate limit detected — extraction paused');
  sessionState.isRunning = false;

  if (sessionState.activeTabId) {
    chrome.tabs.sendMessage(sessionState.activeTabId, { type: 'stop-scraping' }).catch(function () {});
  }

  broadcastToPopup({ type: 'RATE_LIMIT' });
}

// ── Handler: Scrape Complete ─────────────────────────

function handleScrapeComplete(reason) {
  var reasonText = '';
  if (reason === 'date_range') {
    reasonText = ' (date range limit reached — stopped early)';
  } else if (reason === 'hard_cap') {
    reasonText = ' (10k hard cap reached — stopped early)';
  }
  console.log('[ServiceWorker] Scrape complete.' + reasonText + ' Total captured:', sessionState.totalCaptured, '| dateFrom:', sessionState.dateFrom, '| dateTo:', sessionState.dateTo);
  sessionState.isRunning = false;

  triggerCSVDownload();

  broadcastToPopup({
    type: 'EXPORT_COMPLETE',
    totalCaptured: sessionState.totalCaptured
  });
}

// ── Real Extraction Orchestration ────────────────────

async function startExtraction(config) {
  var url = 'https://x.com/' + encodeURIComponent(config.username.replace(/^@/, ''));

  try {
    // Find or create an x.com tab
    var tabs = await chrome.tabs.query({ url: 'https://x.com/*' });
    var tab;

    if (tabs.length > 0) {
      tab = tabs[0];
      await chrome.tabs.update(tab.id, { url: url, active: true });
    } else {
      tab = await chrome.tabs.create({ url: url, active: true });
    }

    sessionState.activeTabId = tab.id;

    // Wait for the page to finish loading
    await waitForTabLoad(tab.id);

    // Extra delay for content scripts to initialize
    await sleep(2000);

    // Initialize the mutation observer
    await sendMessageToTab(tab.id, { type: 'init-observer' });

    // Start scraping with config
    await sendMessageToTab(tab.id, {
      type: 'start-scraping',
      config: {
        username: config.username,
        dateFrom: config.dateFrom,
        dateTo: config.dateTo,
        includeReplies: config.includeReplies,
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
    sessionState.activeTabId = null;
  }

  // Download whatever we have so far
  if (sessionState.tweets.length > 0) {
    triggerCSVDownload();
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

    // Timeout after 30 seconds
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
  if (sessionState.tweets.length === 0) {
    console.warn('[ServiceWorker] No tweets to export');
    return;
  }

  try {
    var csvString = tweetsToCSV(sessionState.tweets);
    var blobContent = createCSVBlob(csvString);
    var dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(blobContent);

    var filename = sessionState.username + '_tweets_' + new Date().toISOString().slice(0, 10) + '.csv';

    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: true
    }).then(function (downloadId) {
      console.log('[ServiceWorker] CSV download started, id:', downloadId, 'filename:', filename);
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

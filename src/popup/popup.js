/**
 * popup.js
 * ========
 * Controls the extension popup UI interactions.
 *
 * Responsible for:
 * - Reading user inputs (username, date range, toggles)
 * - Sending START_EXPORT / STOP_EXPORT / RESUME_EXPORT messages
 * - Listening for progress, rate-limit, and completion events
 * - Enabling/disabling buttons based on export state
 * - Restoring last config from chrome.storage.local on popup open
 * - Showing "Open CSV" button after successful download
 */

// ── DOM References ───────────────────────────────────
const usernameInput   = document.getElementById('username');
const dateFromInput   = document.getElementById('date-from');
const dateToInput     = document.getElementById('date-to');
const includeReplies  = document.getElementById('include-replies');
const onlyMedia       = document.getElementById('only-media');
const includeReposts  = document.getElementById('include-reposts');
const btnExportAll    = document.getElementById('btn-export-all');
const btnStart        = document.getElementById('btn-start');
const btnStop         = document.getElementById('btn-stop');
const btnResume       = document.getElementById('btn-resume');
const btnOpenCSV      = document.getElementById('btn-open-csv');
const progressSection = document.getElementById('progress-section');
const progressBar     = document.getElementById('progress-bar');
const progressBarGlow = document.getElementById('progress-bar-glow');
const progressText    = document.getElementById('progress-text');
const progressStatus  = document.getElementById('progress-status');
const progressPercent = document.getElementById('progress-percent');
const statusMessage   = document.getElementById('status-message');
const actionsResume   = document.getElementById('actions-resume');

// ── State ────────────────────────────────────────────
let isRunning = false;
let isPaused = false;
let lastDownloadId = null;

// ── Helper: Format number with commas ────────────────
function formatNumber(n) {
  return n.toLocaleString('en-US');
}

// ── Helper: Set default date range (last 6 months) ──
function setDefaultDates() {
  const today = new Date();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  dateToInput.value = today.toISOString().split('T')[0];
  dateFromInput.value = sixMonthsAgo.toISOString().split('T')[0];
}

// ── Helper: Show status message with type ────────────
function showStatus(text, type) {
  type = type || 'info';
  statusMessage.textContent = text;
  statusMessage.className = 'status-message ' + type;
}

// ── Helper: Clear status message ─────────────────────
function clearStatus() {
  statusMessage.textContent = '';
  statusMessage.className = 'status-message';
}

// ── Helper: Update progress UI ───────────────────────
function updateProgress(captured, estimated) {
  const percent = Math.min(Math.round((captured / estimated) * 100), 100);

  progressBar.style.width = percent + '%';
  progressBarGlow.style.width = percent + '%';
  progressPercent.textContent = percent + '%';
  progressText.textContent = 'Extracted ' + formatNumber(captured) + ' / ~' + formatNumber(estimated);
}

// ── Helper: Set running/idle UI state ────────────────
function setRunningState(running) {
  isRunning = running;
  isPaused = false;

  if (running) {
    document.body.classList.add('running');
    document.body.classList.remove('paused');
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnResume.disabled = true;
    progressSection.classList.add('visible');
    progressStatus.textContent = 'Extracting…';
    lastDownloadId = null;
    btnOpenCSV.style.display = 'none';
    actionsResume.style.display = 'none';
    clearStatus();
  } else {
    document.body.classList.remove('running');
    document.body.classList.remove('paused');
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnResume.disabled = true;
    actionsResume.style.display = 'none';
  }
}

// ── Helper: Set paused UI state ──────────────────────
function setPausedState() {
  isPaused = true;
  isRunning = true;

  document.body.classList.add('running');
  document.body.classList.add('paused');
  btnStart.disabled = true;
  btnStop.disabled = true;
  btnResume.disabled = false;
  actionsResume.style.display = 'flex';
  progressStatus.textContent = 'Paused';
}

// ── Helper: Reset progress to zero ───────────────────
function resetProgress() {
  progressBar.style.width = '0%';
  progressBarGlow.style.width = '0%';
  progressPercent.textContent = '0%';
  progressText.textContent = 'Extracted 0 / ~10,000';
}

// ── Validate inputs before starting ──────────────────
function validateInputs() {
  const username = usernameInput.value.trim();
  if (!username) {
    showStatus('Please enter a username', 'error');
    usernameInput.focus();
    return false;
  }

  const dateFrom = dateFromInput.value;
  const dateTo = dateToInput.value;

  if (!dateFrom || !dateTo) {
    showStatus('Please select both From and To dates', 'error');
    return false;
  }

  if (new Date(dateFrom) > new Date(dateTo)) {
    showStatus('From date must be before To date', 'error');
    return false;
  }

  return true;
}

// ── Build export config from form ────────────────────
function buildConfig() {
  return {
    username: usernameInput.value.trim().replace(/^@/, ''),
    dateFrom: dateFromInput.value,
    dateTo: dateToInput.value,
    includeReplies: includeReplies.checked,
    onlyMedia: onlyMedia.checked,
    includeReposts: includeReposts.checked,
    exportAll: btnExportAll.classList.contains('active')
  };
}

// ── Event: Start Export ──────────────────────────────
btnStart.addEventListener('click', () => {
  if (!validateInputs()) return;

  const config = buildConfig();
  resetProgress();
  setRunningState(true);

  chrome.runtime.sendMessage({
    type: 'START_EXPORT',
    config: config
  }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Failed to start export: ' + chrome.runtime.lastError.message, 'error');
      setRunningState(false);
      return;
    }
    if (response && response.status === 'started') {
      showStatus('Export started for @' + config.username, 'info');
    }
  });
});

// ── Event: Stop Export ───────────────────────────────
btnStop.addEventListener('click', () => {
  btnStop.disabled = true;
  btnStop.textContent = 'Stopping…';

  chrome.runtime.sendMessage({
    type: 'STOP_EXPORT'
  }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Error stopping export', 'error');
      setRunningState(false);
      btnStop.innerHTML = '<span class="btn-icon">■</span> Stop';
      return;
    }

    const captured = (response && response.totalCaptured) || 0;
    setRunningState(false);
    progressStatus.textContent = 'Stopped';
    showStatus('Export stopped — ' + formatNumber(captured) + ' tweets captured. CSV downloading…', 'warning');
    btnStop.innerHTML = '<span class="btn-icon">■</span> Stop';
  });
});

// ── Event: Resume Export ────────────────────────────
btnResume.addEventListener('click', () => {
  btnResume.disabled = true;
  btnResume.textContent = 'Resuming…';

  chrome.runtime.sendMessage({
    type: 'RESUME_EXPORT'
  }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Error resuming export', 'error');
      btnResume.disabled = false;
      btnResume.innerHTML = '<span class="btn-icon">▶</span> Resume Export';
      return;
    }

    if (response && response.status === 'resumed') {
      isRunning = true;
      isPaused = false;
      document.body.classList.add('running');
      document.body.classList.remove('paused');
      btnStart.disabled = true;
      btnStop.disabled = false;
      btnResume.disabled = true;
      actionsResume.style.display = 'none';
      progressStatus.textContent = 'Extracting…';
      clearStatus();
    } else {
      showStatus('Cannot resume — no paused export found', 'error');
      btnResume.disabled = false;
      btnResume.innerHTML = '<span class="btn-icon">▶</span> Resume Export';
    }
  });
});

// ── Event: Open CSV ─────────────────────────────────
btnOpenCSV.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_CSV' }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Could not open CSV file', 'error');
    }
  });
});

// ── Event: Export Everything Available ────────────────
btnExportAll.addEventListener('click', () => {
  const isActive = btnExportAll.classList.toggle('active');

  if (isActive) {
    dateFromInput.value = '2006-03-21';
    dateToInput.value = new Date().toISOString().split('T')[0];
    includeReplies.checked = true;
    includeReposts.checked = true;
    showStatus('Will export all available tweets', 'info');
  } else {
    setDefaultDates();
    includeReplies.checked = false;
    includeReposts.checked = true;
    clearStatus();
  }
});

// ── Message Listener (progress updates from background) ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'PROGRESS_UPDATE':
      updateProgress(message.totalCaptured, message.estimatedTotal);
      break;

    case 'EXPORT_COMPLETE': {
      const reason = message.reason || 'complete';
      const captured = message.totalCaptured || 0;

      setRunningState(false);
      progressBar.style.width = '100%';
      progressBarGlow.style.width = '100%';
      progressPercent.textContent = '100%';

      let statusText = '';
      let statusType = 'success';

      if (reason === 'date_range') {
        statusText = 'Done — ' + formatNumber(captured) + ' tweets captured (date range reached)';
        progressStatus.textContent = 'Date range complete';
      } else if (reason === 'hard_cap') {
        statusText = 'Done — ' + formatNumber(captured) + ' tweets captured (10k cap reached)';
        progressStatus.textContent = '10k cap reached';
      } else if (reason === 'no_data') {
        statusText = 'No tweets found for this account/date range';
        progressStatus.textContent = 'No data';
        statusType = 'warning';
      } else {
        statusText = 'Exported ' + formatNumber(captured) + ' tweets successfully';
        progressStatus.textContent = 'Complete!';
      }

      showStatus(statusText, statusType);

      if (captured > 0 && !lastDownloadId) {
        btnOpenCSV.style.display = 'flex';
      }
      break;
    }

    case 'DOWNLOAD_READY': {
      lastDownloadId = message.downloadId;
      btnOpenCSV.style.display = 'flex';
      const captured = message.totalCaptured || 0;
      if (!isRunning) {
        showStatus('CSV downloaded — ' + formatNumber(captured) + ' tweets', 'success');
      }
      break;
    }

    case 'EXPORT_STOPPING': {
      const captured = message.totalCaptured || 0;
      showStatus('Stopping… ' + formatNumber(captured) + ' tweets captured so far', 'warning');
      break;
    }

    case 'EXPORT_ERROR':
      setRunningState(false);
      progressStatus.textContent = 'Error';
      showStatus(message.error || 'An error occurred during export', 'error');
      break;

    case 'RATE_LIMIT': {
      const reason = message.reason || 'rate_limit';
      const captured = message.totalCaptured || 0;

      setPausedState();

      if (reason === 'locked') {
        showStatus('Account temporarily locked — export paused. ' + formatNumber(captured) + ' tweets saved.', 'error');
      } else {
        showStatus('Rate limit detected — export paused after ' + formatNumber(captured) + ' tweets. Click Resume when ready.', 'warning');
      }
      break;
    }
  }
});

// ── On popup load: restore state from background ─────
function initPopup() {
  setDefaultDates();

  // Restore last config from storage
  chrome.storage.local.get('lastConfig', (result) => {
    if (result.lastConfig) {
      const cfg = result.lastConfig;
      if (cfg.username) usernameInput.value = cfg.username;
      if (cfg.dateFrom) dateFromInput.value = cfg.dateFrom;
      if (cfg.dateTo) dateToInput.value = cfg.dateTo;
if (cfg.includeReplies) includeReplies.checked = true;
        if (cfg.includeReposts === false) includeReposts.checked = false;
        if (cfg.onlyMedia) onlyMedia.checked = true;
      if (cfg.exportAll) {
        btnExportAll.classList.add('active');
      }
    }
  });

  // Check if an export is already running or paused in the background
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) return;

    if (response) {
      if (response.isPaused) {
        setPausedState();
        updateProgress(response.totalCaptured || 0, response.estimatedTotal || 10000);
        if (response.username) usernameInput.value = response.username;
        showStatus('Export paused — click Resume to continue', 'warning');
      } else if (response.isRunning) {
        setRunningState(true);
        if (response.username) usernameInput.value = response.username;
        updateProgress(response.totalCaptured || 0, response.estimatedTotal || 10000);
      }

      if (response.lastDownloadId) {
        lastDownloadId = response.lastDownloadId;
        btnOpenCSV.style.display = 'flex';
      }
    }
  });
}

// ── Initialize ───────────────────────────────────────
initPopup();
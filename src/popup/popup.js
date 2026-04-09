/**
 * popup.js
 * ========
 * Controls the extension popup UI interactions.
 *
 * Responsible for:
 * - Reading user inputs (username, date range, toggles)
 * - Sending "START_EXPORT" / "STOP_EXPORT" messages to the background service worker
 * - Listening for progress updates and rendering the progress bar + tweet counter
 * - Enabling/disabling buttons based on export state
 *
 * See SPEC.md section 4 (Popup UI) for full requirements.
 */

// ── DOM References ───────────────────────────────────
const usernameInput   = document.getElementById('username');
const dateFromInput   = document.getElementById('date-from');
const dateToInput     = document.getElementById('date-to');
const includeReplies  = document.getElementById('include-replies');
const onlyMedia       = document.getElementById('only-media');
const btnExportAll    = document.getElementById('btn-export-all');
const btnStart        = document.getElementById('btn-start');
const btnStop         = document.getElementById('btn-stop');
const progressSection = document.getElementById('progress-section');
const progressBar     = document.getElementById('progress-bar');
const progressBarGlow = document.getElementById('progress-bar-glow');
const progressText    = document.getElementById('progress-text');
const progressStatus  = document.getElementById('progress-status');
const progressPercent = document.getElementById('progress-percent');
const statusMessage   = document.getElementById('status-message');

// ── State ────────────────────────────────────────────
let isRunning = false;

// ── Helper: Format number with commas ────────────────
function formatNumber(n) {
  return n.toLocaleString('en-US');
}

// ── Helper: Set default date range (last 6 months) ──
function setDefaultDates() {
  const today = new Date();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  // Format as YYYY-MM-DD for the date input
  dateToInput.value = today.toISOString().split('T')[0];
  dateFromInput.value = sixMonthsAgo.toISOString().split('T')[0];
}

// ── Helper: Show status message with type ────────────
function showStatus(text, type = 'info') {
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
  progressText.textContent = `Extracted ${formatNumber(captured)} / ~${formatNumber(estimated)}`;
}

// ── Helper: Set running/idle UI state ────────────────
function setRunningState(running) {
  isRunning = running;

  if (running) {
    document.body.classList.add('running');
    btnStart.disabled = true;
    btnStop.disabled = false;
    progressSection.classList.add('visible');
    progressStatus.textContent = 'Extracting…';
    clearStatus();
  } else {
    document.body.classList.remove('running');
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
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
    exportAll: btnExportAll.classList.contains('active')
  };
}

// ── Event: Start Export ──────────────────────────────
btnStart.addEventListener('click', () => {
  if (!validateInputs()) return;

  const config = buildConfig();
  resetProgress();
  setRunningState(true);

  // Send to background service worker
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
  chrome.runtime.sendMessage({
    type: 'STOP_EXPORT'
  }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus('Error stopping export', 'error');
      return;
    }
    setRunningState(false);
    progressStatus.textContent = 'Stopped';
    showStatus('Export stopped — CSV will download shortly', 'warning');
  });
});

// ── Event: Export Everything Available ────────────────
btnExportAll.addEventListener('click', () => {
  const isActive = btnExportAll.classList.toggle('active');

  if (isActive) {
    // Clear date range restriction — export everything
    dateFromInput.value = '2006-03-21'; // Twitter's founding date
    dateToInput.value = new Date().toISOString().split('T')[0];
    includeReplies.checked = true;
    showStatus('Will export all available tweets', 'info');
  } else {
    // Reset to default 6 months
    setDefaultDates();
    includeReplies.checked = false;
    clearStatus();
  }
});

// ── Message Listener (progress updates from background) ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'PROGRESS_UPDATE':
      updateProgress(message.totalCaptured, message.estimatedTotal);
      break;

    case 'EXPORT_COMPLETE':
      setRunningState(false);
      progressStatus.textContent = 'Complete!';
      progressPercent.textContent = '100%';
      progressBar.style.width = '100%';
      progressBarGlow.style.width = '100%';
      showStatus(
        `✓ Exported ${formatNumber(message.totalCaptured)} tweets successfully`,
        'success'
      );
      break;

    case 'EXPORT_ERROR':
      setRunningState(false);
      progressStatus.textContent = 'Error';
      showStatus(message.error || 'An error occurred during export', 'error');
      break;

    case 'RATE_LIMIT':
      progressStatus.textContent = 'Rate Limited';
      showStatus(
        '⚠ Rate limit detected — extraction paused. Please wait.',
        'warning'
      );
      break;
  }
});

// ── On popup load: restore state from background ─────
function initPopup() {
  setDefaultDates();

  // Check if an export is already running in the background
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) return;

    if (response && response.isRunning) {
      setRunningState(true);
      usernameInput.value = response.username || '';
      updateProgress(response.totalCaptured || 0, response.estimatedTotal || 10000);
    }
  });
}

// ── Initialize ───────────────────────────────────────
initPopup();

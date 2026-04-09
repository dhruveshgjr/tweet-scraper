# Project Spec: X Tweet Exporter Chrome Extension

## 1. Objective & Success Criteria
**Objective:** Build a robust, reliable Manifest V3 Chrome extension that allows users to export up to the ~10,000 most recent tweets from any public X (Twitter) account to a clean, well-formatted CSV file.
**Success Criteria:**
- User can input a username and date range.
- The extension seamlessly accesses X's web interface (Profile or Advanced Search) to gather tweets on behalf of the user.
- It effectively extracts tweet data via DOM parsing or intercepting page data state.
- The user is presented with a live progress bar mapping the extraction session.
- On completion or early stopping, a valid CSV file is downloaded locally. Zero external servers.

## 2. Tech Stack & Project Structure (Manifest V3, folders, files)
**Tech Stack:**
- **Core:** Vanilla JavaScript (ES6 Modules) + HTML.
- **Manifest:** Manifest V3 for Chrome.
- **Styling:** Vanilla CSS (Lightweight, dark-mode default). 
- **Data Export:** Lightweight native JS CSV generator (or Papa Parse if complexity demands it).

**Project Structure:**
```text
tweet-scraper/
├── manifest.json
├── src/
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   ├── content/
│   │   ├── scraper.js        # DOM parsing & auto-scrolling logic
│   │   └── observer.js       # Mutation observers for new tweets
│   ├── background/
│   │   └── service_worker.js # Message handling, state management, file export
│   └── utils/
│       ├── csv_exporter.js   # Transforms JSON arrays to CSV blobs
│       └── formatters.js     # Date & string utility functions
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── SPEC.md
```

## 3. Commands (npm scripts, build, test, load in Chrome)
We maintain a zero-build-step philosophy for maximum simplicity and iteration speed unless a bundler becomes necessary.
- **Load in Chrome:**
  1. Open `chrome://extensions/`
  2. Enable "Developer mode" toggle.
  3. Click "Load unpacked".
  4. Select the `tweet-scraper` directory.
- **Reloading:** After making changes to background workers, hit the refresh icon on the extension page. Content scripts reload when you refresh the X.com tab.

## 4. Core Features
**Popup UI (`src/popup`):**
- **Inputs:** Username field (e.g. `elonmusk` — no '@' needed), Date Range picker (From/To, defaults to last 6 months).
- **Toggles/Options:** Include/exclude replies, "Export everything available" quick action.
- **Actions:** "Start Export", "Stop & Download CSV".
- **Feedback:** Live progress bar and tweet counter ("Extracted 1,247 / ~10,000").

**Content Script Scraper (`src/content`):**
- Injected on X.com directly (Targeting `https://x.com/search?q=from%3A...` or profile pages).
- **Scrolling Logic:** Auto-scrolls the page dynamically to load tweets.
- **Data Extraction:** Parses DOM nodes specifically bypassing brittle CSS classes. Alternatively, reads data directly from intercepted React internal state / GraphQL JSON stubs on the page.
- Streams extracted batches to the Background Service Worker.

**Background Service Worker (`src/background`):**
- Standardizes the global state of the export session (is extracting, total captured).
- Acts as the central hub: instructs the content script to pause/resume/stop.
- Retains aggregated tweet data temporarily in memory during extraction.

**CSV Export (`src/utils`):**
- Triggers the file download using the native `chrome.downloads` API.

## 5. Data Model (CSV columns + types)
| Column Name | Data Type | Description |
| :--- | :--- | :--- |
| `tweet_id` | String | Unique identifier |
| `timestamp` | String (ISO) | UTC timestamp of the tweet |
| `full_text` | String | The text body of the tweet |
| `reply_count` | Integer | Number of replies |
| `repost_count` | Integer | Number of retweets/reposts |
| `like_count` | Integer | Number of likes |
| `view_count` | Integer | Number of views |
| `is_reply` | Boolean | True if the tweet is replying to another |
| `is_retweet` | Boolean | True if it's a retweet/quote |
| `quoted_tweet_id` | String | ID of the quoted tweet, if any |
| `media_urls` | String | Comma-separated list of image/video URLs |
| `tweet_url` | String | Direct web link to the tweet |
| `language` | String | Detected language code |
| `source` | String | E.g. "Twitter for iPhone" |

## 6. Boundaries (Always / Ask First / Never rules)
- **ALWAYS:**
  - Pause extraction instantly if X triggers a rate limit or CAPTCHA and alert the user.
  - Rely on the active session.
  - Run completely locally (zero external server calls).
- **ASK FIRST:**
  - Before introducing any framework dependencies (React, Webpack, Vite). 
  - Before pivoting away from DOM extraction towards network request interception.
- **NEVER:**
  - Store or log authentication tokens.
  - Bypass X's 10,000 recent tweet hard limit using brute-force behavior.

## 7. Testing Strategy (live browser tests via Antigravity browser agent)
- We will use the Antigravity browser agent for interactive end-to-end testing.
- **Core Loop:**
  1. Have the browser agent install the unpacked extension.
  2. Navigate to an X profile (e.g., `elonmusk` or `x`).
  3. Open the extension popup, trigger an extraction.
  4. Ensure the auto-scroller activates within the `x.com` tab.
  5. Wait for N tweets to process, stop the extraction, and verify the resulting `.csv` payload.

## 8. Edge Cases & 2026 X Layout Handling
- **Dynamic Classes Bypass:** X uses randomized CSS classes (`.css-1dbjc4n`). We scrape using structural landmarks, `data-testid` nodes (e.g. `data-testid="tweet"`), ARIA labels, and `time` DOM attributes.
- **Infinite Scroll Hiccups:** X's feed sometimes stalls. The scroller must detect dead-time and implement gentle scroll jiggling to trigger subsequent page fetches.
- **Punctured Pagination:** Scraper avoids terminating prematurely heavily simply because no tweets rendered inside a small vertical pixel boundary, waiting for explicit "No more tweets" signals.
- **Memory Pressure:** Continuous loading of tweets bloats the DOM. If possible, the scroller shouldn't crash the renderer; it should instruct the DOM or React tree to clean up unviewport-ed nodes, or cleanly navigate to paginated chunks if doing advanced search.

## 9. Future Nice-to-Haves (phased)
**Phase 2:**
- Resume interrupted exports.
- Export to Google Sheets directly.
**Phase 3:**
- JSON payload option.
- Batch multi-account scraping.
- Auto-detect the date ranges dynamically based on the first discovered tweet within the block.

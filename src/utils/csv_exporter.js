/**
 * csv_exporter.js
 * ===============
 * ES module: transforms tweet arrays into CSV strings.
 *
 * Imported by the background service worker (which uses type:"module").
 * NOT loaded as a content script.
 */

var CSV_COLUMNS = [
  'tweet_id',
  'timestamp',
  'full_text',
  'reply_count',
  'repost_count',
  'like_count',
  'view_count',
  'is_reply',
  'is_retweet',
  'quoted_tweet_id',
  'media_urls',
  'tweet_url',
  'language',
  'source'
];

function escapeCSVField(value) {
  if (value === null || value === undefined) return '';
  var str = String(value);
  if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function tweetsToCSV(tweets) {
  if (!tweets || tweets.length === 0) return '';
  var header = CSV_COLUMNS.map(escapeCSVField).join(',');
  var rows = [];
  for (var i = 0; i < tweets.length; i++) {
    var t = tweets[i];
    var row = [];
    for (var c = 0; c < CSV_COLUMNS.length; c++) {
      row.push(escapeCSVField(t[CSV_COLUMNS[c]]));
    }
    rows.push(row.join(','));
  }
  return header + '\n' + rows.join('\n');
}

function createCSVBlob(csvString) {
  return '\uFEFF' + csvString;
}

export { CSV_COLUMNS, escapeCSVField, tweetsToCSV, createCSVBlob };

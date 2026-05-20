<div align="center">

# X/Twitter Following Manager

![X/Twitter Following Manager preview](docs/assets/github-preview.png)

Languages: [简体中文](README.md) · [English](README-en.md)

</div>

X/Twitter Following Manager is a Chrome extension for X/Twitter on the web. It shows account following and follower counts directly on the page, and provides a local manager for reviewing, filtering, importing, and exporting accounts you encounter while browsing.

It is useful for cleaning up accounts you already follow, reviewing accounts you may follow later, or keeping a local list of X/Twitter users you want to revisit.

## Docs

- Privacy Policy: [PRIVACY-en.md](PRIVACY-en.md)

## Features

- Show following and follower counts directly in feeds and user-list areas.
- Toggle count labels for Feed and user-list surfaces.
- Collect browsed or imported accounts into a local manager page.
- Search by display name, handle, bio, website, and browsed post text.
- Filter accounts by source: Feed, user lists, reply list, or import.
- Show the latest browsed post and label it as original, repost, reply, or import.
- Export selected accounts as CSV or Markdown.
- Import account lists from CSV or Markdown.
- Batch-open selected profile pages for manual review.
- Sequentially refresh selected account data in a single tab.
- Lock the account list so browsing only updates existing records and does not add newly seen accounts.
- Switch the extension interface between English and Chinese.

## Installation

### Load From Source

1. Open Chrome or Edge.
2. Go to `chrome://extensions/` or `edge://extensions/`.
3. Turn on Developer mode.
4. Click **Load unpacked**.
5. Select this project folder.
6. Open or refresh X/Twitter.

If X/Twitter was already open before installation, refresh the page once so the content script can start.

## Usage

Open X/Twitter and browse normally. When a supported account item appears, the extension adds a small stats label near the user name:

```text
388 Following · 26K Followers
```

The popup provides quick controls:

- **Feed**: controls stats labels in home timelines, profile timelines, lists, and other feed-style areas.
- **User lists**: controls stats labels in following pages, follower pages, user search results, and right-side user modules.
- **Lock account list**: updates only accounts that are already captured or imported, and does not add newly seen accounts to the manager.
- **Open manager**: opens the standalone manager page for captured and imported accounts.
- **Rescan this page**: scans the current X/Twitter page again.
- **Clear cache**: clears locally saved account data.

The extension does not show stats labels on X/Twitter notification pages, because notification rows often mix likes, replies, avatars, and grouped activity in ways that can cause false matches.

![Account stats shown in user lists and right-side user modules](docs/assets/screenshot-111.jpg)

![Account stats shown in the Feed and post detail pages](docs/assets/screenshot-222.jpg)

## Account Manager

Click **Open manager** in the popup to open the local manager page. It lists captured or imported accounts with:

- display name
- handle
- following count
- follower count
- source
- latest browsed post
- last seen time

The manager supports search, source filters, select all current results, select records with missing stats, invert selection, clear selection, import, export, batch-open profiles, and sequential refresh.

![Account manager page](docs/assets/screenshot-333.jpg)

## Sources

The manager uses these source labels:

- **Feed**: the account was seen in a feed-style post area.
- **User lists**: the account was seen in a following page, follower page, user search result, or right-side user module.
- **Reply list**: the account was captured only from reply or comment context.
- **Import**: the account came from an imported file and has not yet been refreshed from another source.

If an imported account is later seen in the Feed, a user-list area, or a reply list, the new source replaces the Import label. Import is not shown beside other source labels.

## Latest Browsed Post

For accounts captured from the Feed or reply list, the manager tries to keep the latest browsed content and labels it as:

- **Original**: a regular original post.
- **Repost**: reposted content.
- **Reply**: a reply or comment.
- **Import**: historical content from an imported file.

For accounts that only came from a user list or an imported file, the manager explains that no browsed post has been seen from that source yet.

## Reply Options

- **Show reply-list source**: shows accounts captured only from reply lists. If the same account also appears in the Feed or a user-list area, it remains visible even when this option is off.
- **Prefer replies**: when the same account has both post and reply records, show the reply first in the latest browsed post column. This only changes the displayed post, not which users appear.

## Import And Export

CSV is the default export format. Markdown is also supported.

CSV exports include:

- display name
- handle
- user ID
- profile URL
- following count
- follower count
- source
- bio
- website
- first seen time
- last seen time
- latest post type
- latest captured post
- post URL
- captured post count

Profile URL is the most important field for importing and batch-opening profiles. If an import file keeps X/Twitter profile URLs, the extension can extract handles from those URLs. If imported data does not include following counts, follower counts, or post content, those fields stay empty until the account is browsed again or refreshed sequentially.

Import only adds records to the local manager, updates local data, and helps open profile pages.

## Sequential Refresh

Sequential refresh helps fill missing following and follower counts for imported lists or incomplete records.

Workflow:

1. Select accounts in the manager.
2. Click the refresh icon.
3. The extension opens one dedicated X/Twitter tab.
4. It visits selected profile pages one by one.
5. It lightly scrolls and waits for stats to render.
6. Updated data is written back to local storage.

Closing the dedicated refresh tab stops the process. Switching back to the manager page to watch updates does not stop it.

## Permissions And Privacy

The extension uses these permissions:

- `activeTab`: communicates with the current X/Twitter tab when you use popup actions.
- `storage`: saves account cache and settings locally in the browser.
- `https://x.com/*` and `https://twitter.com/*`: runs the extension script on X/Twitter pages.

The extension does not require an X API key, does not use a third-party backend, and does not send captured account data to external servers. Account data is stored locally in your browser.

## Scope

- Mainly supports X/Twitter on the web.
- X/Twitter page structure changes may require parser updates.
- Private, restricted, suspended, or unusual accounts may not expose complete data.
- If a page was loaded long before the extension started, refreshing the page usually helps capture more data.
- Sequential refresh depends on what X/Twitter actually renders, so it cannot guarantee every account will be filled.

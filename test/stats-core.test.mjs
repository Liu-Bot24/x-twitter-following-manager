import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../stats-core.js", import.meta.url), "utf8");
const i18nSource = await readFile(new URL("../i18n.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const enMessages = JSON.parse(await readFile(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
const zhMessages = JSON.parse(await readFile(new URL("../_locales/zh_CN/messages.json", import.meta.url), "utf8"));
const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
const popupHtml = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
const managerHtml = await readFile(new URL("../manager/manager.html", import.meta.url), "utf8");
const managerSource = await readFile(new URL("../manager/manager.js", import.meta.url), "utf8");
const managerCss = await readFile(new URL("../manager/manager.css", import.meta.url), "utf8");
const contentCss = await readFile(new URL("../content.css", import.meta.url), "utf8");
const popupCss = await readFile(new URL("../popup/popup.css", import.meta.url), "utf8");
const popupSource = await readFile(new URL("../popup/popup.js", import.meta.url), "utf8");
const sandbox = { Intl, URL };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
vm.runInContext(i18nSource, sandbox);

const core = sandbox.XFollowStatsCore;
const i18n = sandbox.XFSI18n;

for (const size of ["16", "32", "48", "128"]) {
  assert.equal(manifest.icons[size], `icons/icon-${size}.png`);
  assert.equal(manifest.action.default_icon[size], `icons/icon-${size}.png`);
  await access(new URL(`../icons/icon-${size}.png`, import.meta.url));
}
await access(new URL("../icons/icon-512.png", import.meta.url));

assert.equal(enMessages.extensionName.message, "X/Twitter Following Manager - Instantly Show Follower Counts & Export Lists");
assert.equal(enMessages.extensionName.message.length, 75);
assert.equal(zhMessages.extensionName.message, "X/Twitter 关注管理器 - 直接显示粉丝数，管理并导出名单");
assert.equal(enMessages.shortName.message, "X/Twitter Following Manager");
assert.equal(zhMessages.shortName.message, "X/Twitter 关注管理器");
assert.equal(enMessages.actionTitle.message, enMessages.shortName.message);
assert.equal(zhMessages.actionTitle.message, zhMessages.shortName.message);
assert.equal(enMessages.authorText.message, "Created by @liuqi");
assert.equal(zhMessages.authorText.message, "Created by @liuqi");
assert.equal(enMessages.sourceComment.message, "Reply list");
assert.equal(zhMessages.sourceComment.message, "评论列表");
for (const key of Object.keys(enMessages)) {
  assert.ok(zhMessages[key], `zh_CN missing message key ${key}`);
}
assert.equal(i18n.resolveLanguage(null, "zh-CN"), "zh_CN");
assert.equal(i18n.resolveLanguage(null, "en-US"), "en");
assert.equal(i18n.resolveLanguage("zh_CN", "en-US"), "zh_CN");
assert.equal(i18n.resolveLanguage("en", "zh-CN"), "en");
assert.equal(i18n.getMessage("shortName", [], "zh_CN"), "X/Twitter 关注管理器");
assert.equal(i18n.getMessage("shortName", [], "en"), "X/Twitter Following Manager");
assert.equal(i18n.getMessage("pillStatsText", ["388", "2.6万"], "zh_CN"), "388 正在关注 · 2.6万 关注者");
assert.equal(i18n.getMessage("pillStatsText", ["388", "26K"], "en"), "388 Following · 26K Followers");
assert.match(i18n.getMessage("tooltipLockList", [], "zh_CN"), /不会把新看到的账号加入管理页/);
assert.match(i18n.getMessage("tooltipSequentialUpdate", [], "en"), /one selected profile at a time/);
assert.match(i18nSource, /data-i18n-tooltip/);
assert.ok(manifest.content_scripts[0].js.indexOf("i18n.js") > manifest.content_scripts[0].js.indexOf("stats-core.js"));
assert.ok(manifest.content_scripts[0].js.indexOf("i18n.js") < manifest.content_scripts[0].js.indexOf("content.js"));

const defaultSettings = core.normalizeDisplaySettings();
assert.equal(defaultSettings.feed, true);
assert.equal(defaultSettings.userList, true);
assert.equal(defaultSettings.updateOnlyExisting, false);
const feedOffSettings = core.normalizeDisplaySettings({ feed: false, userList: true });
assert.equal(feedOffSettings.feed, false);
assert.equal(feedOffSettings.userList, true);
const updateOnlySettings = core.normalizeDisplaySettings({ updateOnlyExisting: true });
assert.equal(updateOnlySettings.updateOnlyExisting, true);
assert.equal(core.classifyStatsSurface({ isTweet: true, isUserCell: false }), "feed");
assert.equal(core.classifyStatsSurface({ isTweet: false, isUserCell: true }), "userList");
assert.equal(core.classifyStatsSurface({ isTweet: false, isUserCell: false }), "userList");
assert.equal(core.isStatsAllowedPath("/home"), true);
assert.equal(core.isStatsAllowedPath("/qq_liu45504/following"), true);
assert.equal(core.isStatsAllowedPath("/notifications"), false);
assert.equal(core.isStatsAllowedPath("/notifications/mentions"), false);

const chineseStats = core.parseStatsText("388 正在关注 2.6万 关注者");
assert.equal(chineseStats.followingDisplay, "388");
assert.equal(chineseStats.followersDisplay, "2.6万");

const englishStats = core.parseStatsText("12.4K Following 1.2M Followers");
assert.equal(englishStats.followingDisplay, "12.4K");
assert.equal(englishStats.followersDisplay, "1.2M");

const bioNumberStats = core.parseStatsText(
  "8年币圈老韭菜，微信视频号20w粉丝，原证券持牌投顾 业务：有个web3群；被盗/被封资产找回 + v :1029381748 743 正在关注 2,862 关注者"
);
assert.equal(bioNumberStats.followingDisplay, "743");
assert.equal(bioNumberStats.followersDisplay, "2,862");

assert.equal(core.parseStatsText("Joined June 2020 Posts 42"), null);

assert.equal(core.usernameFromProfileHref("/ZHO_ZHO_ZHO", "https://x.com"), "zho_zho_zho");
assert.equal(core.usernameFromProfileHref("/home", "https://x.com"), "");
assert.equal(core.usernameFromProfileHref("https://example.com/ZHO_ZHO_ZHO", "https://x.com"), "");

const uppercaseNameLink = { href: "https://x.com/ZHO_ZHO_ZHO", textContent: "-Zho-" };
const uppercaseHandleLink = { href: "https://x.com/ZHO_ZHO_ZHO", textContent: "@ZHO_ZHO_ZHO" };
const unrelatedLink = { href: "https://x.com/home", textContent: "主页" };
assert.equal(
  core.findNameLinkInAnchors([unrelatedLink, uppercaseHandleLink, uppercaseNameLink], "zho_zho_zho", "https://x.com"),
  uppercaseNameLink
);
assert.equal(core.findNameLinkInAnchors([uppercaseHandleLink], "zho_zho_zho", "https://x.com"), null);

const levelsAvatarLink = { href: "https://x.com/levelsio", textContent: "" };
const levelsDisplayNameLink = { href: "https://x.com/levelsio", textContent: "@levelsio" };
const levelsHandleLink = { href: "https://x.com/levelsio", textContent: "@levelsio" };
assert.equal(
  core.findNameLinkInAnchors([levelsAvatarLink, levelsDisplayNameLink, levelsHandleLink], "levelsio", "https://x.com"),
  levelsDisplayNameLink
);

const mergedUser = core.mergeObservedUser(
  {
    username: "levelsio",
    displayName: "@levelsio",
    followingCount: 3007,
    followersCount: 868000,
    sources: ["userList"],
    observedPosts: []
  },
  {
    username: "LevelsIO",
    displayName: "Pieter Levels",
    profileUrl: "https://x.com/levelsio",
    sources: ["feed"],
    observedPost: {
      id: "123",
      url: "https://x.com/levelsio/status/123",
      text: "Shipping a tiny product today.",
      capturedAt: "2026-05-20T00:00:00.000Z"
    }
  },
  "2026-05-20T01:00:00.000Z"
);
assert.equal(mergedUser.username, "levelsio");
assert.equal(mergedUser.displayName, "Pieter Levels");
assert.equal(mergedUser.profileUrl, "https://x.com/levelsio");
assert.equal(mergedUser.followingCount, 3007);
assert.equal(mergedUser.followersCount, 868000);
assert.equal(mergedUser.sources.join("|"), "userList|feed");
assert.equal(mergedUser.observedPosts.length, 1);
assert.equal(mergedUser.observedPosts[0].text, "Shipping a tiny product today.");

const feedThenUserList = core.mergeObservedUser(
  mergedUser,
  {
    username: "levelsio",
    displayName: "@levelsio",
    sources: ["userList", "api"],
    followingDisplay: "3,007",
    followersDisplay: "86.8万"
  },
  "2026-05-20T02:00:00.000Z"
);
assert.equal(feedThenUserList.displayName, "@levelsio");
assert.equal(feedThenUserList.sources.join("|"), "userList|feed|pageData");
assert.equal(feedThenUserList.observedPosts.length, 1);
assert.equal(feedThenUserList.observedPosts[0].url, "https://x.com/levelsio/status/123");
assert.equal(feedThenUserList.observedPosts[0].kind, "original");
assert.match(core.exportUsersToCsv([feedThenUserList]), /userList\|feed/);
assert.doesNotMatch(core.exportUsersToCsv([feedThenUserList]), /api/i);
assert.doesNotMatch(core.exportUsersToCsv([feedThenUserList]), /pageData/);

const mixedFeedUser = core.mergeObservedUser(
  null,
  {
    username: "mixed_user",
    sources: ["feed"],
    observedPosts: [
      { id: "c1", text: "This is a reply", kind: "comment", url: "https://x.com/mixed_user/status/1" },
      { id: "p1", text: "This is a post", kind: "original", url: "https://x.com/mixed_user/status/2" },
      { id: "r1", text: "This is a repost", kind: "retweet", url: "https://x.com/mixed_user/status/3" }
    ]
  },
  "2026-05-20T03:00:00.000Z"
);
assert.equal(core.userHasCommentSource(mixedFeedUser), true);
assert.equal(core.userHasNonCommentSource(mixedFeedUser), true);
assert.equal(core.userSurfaceSources(mixedFeedUser).join("|"), "feed");
assert.equal(core.selectObservedPost(mixedFeedUser).text, "This is a post");
assert.equal(core.selectObservedPost(mixedFeedUser, { preferComments: true }).text, "This is a reply");
assert.equal(core.selectObservedPost(mixedFeedUser, { includeComments: false }).text, "This is a post");

const commentOnlyUser = core.mergeObservedUser(
  null,
  {
    username: "comment_only",
    sources: ["feed"],
    observedPost: { id: "c2", text: "Only reply", kind: "comment", url: "https://x.com/comment_only/status/2" }
  },
  "2026-05-20T03:00:00.000Z"
);
assert.equal(core.userHasCommentSource(commentOnlyUser), true);
assert.equal(core.userHasNonCommentSource(commentOnlyUser), false);
assert.equal(core.userSurfaceSources(commentOnlyUser).join("|"), "");
assert.doesNotMatch(core.exportUsersToCsv([commentOnlyUser]), /comment_only,[^\\n]*feed/);
assert.equal(core.selectObservedPost(commentOnlyUser, { includeComments: false }), null);

const userListWithComment = core.mergeObservedUser(
  { username: "listed_comment", sources: ["userList"] },
  {
    username: "listed_comment",
    sources: ["feed"],
    observedPost: { id: "c3", text: "Listed reply", kind: "comment" }
  },
  "2026-05-20T03:00:00.000Z"
);
assert.equal(core.userHasNonCommentSource(userListWithComment), true);

const csv = core.exportUsersToCsv([mergedUser]);
assert.match(csv.split("\n")[0], /display_name,username,user_id,profile_url/);
assert.doesNotMatch(csv.split("\n")[0], /relationship/);
assert.match(csv.split("\n")[0], /latest_post_kind/);
assert.match(csv, /Pieter Levels,levelsio,,https:\/\/x.com\/levelsio/);
assert.match(csv, /Shipping a tiny product today\./);

const roundTrippedExport = core.parseImportedUsers(csv, "roundtrip.csv");
assert.equal(roundTrippedExport.length, 1);
assert.equal(roundTrippedExport[0].displayName, "Pieter Levels");
assert.equal(roundTrippedExport[0].username, "levelsio");
assert.equal(roundTrippedExport[0].profileUrl, "https://x.com/levelsio");
assert.equal(roundTrippedExport[0].followingCount, 3007);
assert.equal(roundTrippedExport[0].followersCount, 868000);
assert.equal(roundTrippedExport[0].observedPosts[0].kind, "original");
assert.equal(roundTrippedExport[0].observedPosts[0].source, "import");

const refreshedAfterImport = core.mergeObservedUser(
  roundTrippedExport[0],
  {
    username: "levelsio",
    sources: ["feed"],
    observedPost: {
      id: "fresh",
      text: "Freshly browsed post",
      url: "https://x.com/levelsio/status/fresh",
      kind: "original",
      source: "feed"
    }
  },
  "2026-05-20T04:00:00.000Z"
);
assert.equal(core.selectObservedPost(refreshedAfterImport).text, "Freshly browsed post");
assert.equal(core.selectObservedPost(refreshedAfterImport).source, "feed");
assert.equal(refreshedAfterImport.sources.join("|"), "import|feed");
assert.equal(core.userSurfaceSources(refreshedAfterImport).join("|"), "feed");
assert.match(core.exportUsersToCsv([refreshedAfterImport]), /levelsio,[^\n]*,feed,/);
assert.doesNotMatch(core.exportUsersToCsv([refreshedAfterImport]), /import\|feed|feed\|import/);
assert.equal(core.userSurfaceSources({ username: "listed_import", sources: ["import", "userList"] }).join("|"), "userList");

const markdown = core.exportUsersToMarkdown([mergedUser]);
assert.match(markdown, /- \[Pieter Levels\]\(https:\/\/x.com\/levelsio\)/);
assert.match(markdown, /Shipping a tiny product today\./);

const roundTrippedMarkdown = core.parseImportedUsers(markdown, "roundtrip.md");
assert.equal(roundTrippedMarkdown.length, 1);
assert.equal(roundTrippedMarkdown[0].displayName, "Pieter Levels");
assert.equal(roundTrippedMarkdown[0].username, "levelsio");
assert.equal(roundTrippedMarkdown[0].profileUrl, "https://x.com/levelsio");
assert.equal(roundTrippedMarkdown[0].observedPosts[0].kind, "original");
assert.equal(roundTrippedMarkdown[0].observedPosts[0].source, "import");
const importOnlyMarkdown = core.exportUsersToMarkdown([{ username: "import_only", sources: ["import"] }]);
assert.match(importOnlyMarkdown, /来自用户导入，未浏览到推文/);
assert.doesNotMatch(importOnlyMarkdown, /未获取到推文/);
assert.equal(core.parseImportedUsers(importOnlyMarkdown, "import-only.md")[0].observedPosts?.length || 0, 0);
const userListOnlyMarkdown = core.exportUsersToMarkdown([{ username: "list_only", sources: ["userList"] }]);
assert.match(userListOnlyMarkdown, /来自用户列表，未浏览到推文/);
assert.equal(core.parseImportedUsers(userListOnlyMarkdown, "list-only.md")[0].observedPosts?.length || 0, 0);

const users = core.collectUserStats({
  data: {
    user: {
      result: {
        legacy: {
          screen_name: "levelsio",
          name: "Pieter Levels",
          friends_count: 388,
          followers_count: 26000
        }
      }
    }
  }
});

assert.equal(users.length, 1);
assert.equal(users[0].username, "levelsio");
assert.equal(users[0].followingCount, 388);
assert.equal(users[0].followersCount, 26000);

const emptyUsers = core.collectUserStats({
  legacy: {
    screen_name: "not_enough_data"
  }
});

assert.equal(emptyUsers.length, 0);

const importedCsv = core.parseImportedUsers(
  [
    "display_name,username,user_id,profile_url,following_count,followers_count,sources,bio,website,first_seen_at,last_seen_at,latest_post_text,latest_post_url,latest_post_kind,observed_posts_count",
    "First,first_user,,https://x.com/first_user,12,34,feed,,,2026-05-19 10:00:00,2026-05-20 10:00:00,hello,https://x.com/first_user/status/1,comment,1",
    "Second,second_user,,https://x.com/second_user,,,,,,,,,,0"
  ].join("\n"),
  "users.csv"
);
assert.equal(importedCsv.length, 2);
assert.equal(importedCsv[0].username, "first_user");
assert.equal(importedCsv[0].sources.join("|"), "import");
assert.equal(importedCsv[0].lastSeenAt, "2026-05-20 10:00:00");
assert.equal(importedCsv[0].observedPosts[0].kind, "comment");
assert.equal(importedCsv[0].observedPosts[0].source, "import");
assert.equal(importedCsv[1].username, "second_user");
assert.equal(importedCsv[1].lastSeenAt || "", "");
assert.equal(importedCsv[1].followingCount ?? "", "");

const importedCsvWithoutPostKind = core.parseImportedUsers(
  [
    "display_name,username,profile_url,latest_post_text,latest_post_url",
    "No Kind,no_kind,https://x.com/no_kind,imported post,https://x.com/no_kind/status/1"
  ].join("\n"),
  "old-export.csv"
);
assert.equal(importedCsvWithoutPostKind[0].observedPosts[0].kind, "unknown");
assert.doesNotMatch(core.exportUsersToCsv(importedCsvWithoutPostKind).split("\n")[1], /unknown/);

const usernameOnlyImport = core.parseImportedUsers(["用户", "@only_user", "黄小木 @ai_xiaomu"].join("\n"), "users.csv");
assert.equal(usernameOnlyImport.length, 0);

const profileLinkIsMinimumImport = core.parseImportedUsers(
  ["用户,profile_url", "黄小木 @ai_xiaomu,https://x.com/ai_xiaomu"].join("\n"),
  "users.csv"
);
assert.equal(profileLinkIsMinimumImport.length, 1);
assert.equal(profileLinkIsMinimumImport[0].username, "ai_xiaomu");
assert.equal(profileLinkIsMinimumImport[0].sources.join("|"), "import");

const profileOnlyImport = core.parseImportedUsers(
  ["profile_url", "https://x.com/Jackywine"].join("\n"),
  "profile-links.csv"
);
assert.equal(profileOnlyImport.length, 1);
assert.equal(profileOnlyImport[0].username, "jackywine");
assert.equal(profileOnlyImport[0].displayName, "");
assert.equal(profileOnlyImport[0].profileUrl, "https://x.com/Jackywine");

const markdownProfileOnlyImport = core.parseImportedUsers("- https://x.com/Jackywine", "profile-links.md");
assert.equal(markdownProfileOnlyImport.length, 1);
assert.equal(markdownProfileOnlyImport[0].username, "jackywine");
assert.equal(markdownProfileOnlyImport[0].displayName, "");

const importedMarkdown = core.parseImportedUsers(
  [
    "# X 用户导出",
    "",
    "- [Markdown User](https://x.com/md_user) - @md_user - 8 正在关注 / 9 关注者",
    "  - 最新捕获推文（转推）：markdown text",
    "  - 推文链接：https://x.com/md_user/status/9"
  ].join("\n"),
  "users.md"
);
assert.equal(importedMarkdown.length, 1);
assert.equal(importedMarkdown[0].username, "md_user");
assert.equal(importedMarkdown[0].sources.join("|"), "import");
assert.equal(importedMarkdown[0].observedPosts[0].kind, "retweet");

const importedMarkdownWithoutPostKind = core.parseImportedUsers(
  [
    "- [Old Markdown](https://x.com/old_md) - @old_md - 8 正在关注 / 9 关注者",
    "  - 最新捕获推文：old markdown text"
  ].join("\n"),
  "old.md"
);
assert.equal(importedMarkdownWithoutPostKind[0].observedPosts[0].kind, "unknown");

assert.doesNotMatch(managerHtml, />关系</);
assert.doesNotMatch(managerHtml, />推文</);
assert.doesNotMatch(managerHtml, /X 用户管理|X 关注数助手/);
assert.doesNotMatch(popupHtml, /X 关注数助手/);
assert.match(managerHtml, /data-i18n="shortName"/);
assert.match(popupHtml, /data-i18n="shortName"/);
assert.match(popupHtml, /id="language-toggle"/);
assert.match(popupHtml, /class="language-switch"/);
assert.match(popupHtml, /data-i18n-title="languageSwitchTitle"/);
assert.match(popupHtml, /data-i18n="languageSwitchEn"[\s\S]*data-i18n="languageSwitchZh"/);
assert.match(popupHtml, /id="lock-list-toggle"/);
assert.match(popupHtml, /data-i18n="managerLockList"/);
assert.match(popupHtml, /data-i18n-tooltip="tooltipLockList"/);
assert.match(popupHtml, /<script src="\.\.\/i18n\.js"><\/script>|<script src="..\/i18n.js"><\/script>/);
assert.match(managerHtml, /<script src="\.\.\/i18n\.js"><\/script>/);
assert.match(managerHtml, /https:\/\/blog\.liu-qi\.cn\/index\.php\/tools\//);
assert.match(popupHtml, /https:\/\/blog\.liu-qi\.cn\/index\.php\/tools\//);
assert.match(managerHtml, /data-i18n="managerColumnLatestPost"/);
assert.match(managerHtml, /class="count-column" data-i18n="managerColumnFollowing"/);
assert.match(managerHtml, /data-i18n="managerShowComments"/);
assert.match(managerHtml, /data-i18n-tooltip="tooltipShowComments"/);
assert.doesNotMatch(managerHtml, /评论区/);
assert.match(managerHtml, /data-i18n="managerPreferComments"/);
assert.match(managerHtml, /data-i18n-tooltip="tooltipPreferComments"/);
assert.match(managerHtml, /data-i18n="managerImportUsers"/);
assert.match(managerHtml, /data-i18n="managerOpenSelectedProfiles"/);
assert.match(managerHtml, /id="sequential-update"/);
assert.match(managerHtml, /data-i18n-aria-label="managerSequentialUpdateTitle"/);
assert.match(managerHtml, /data-i18n-tooltip="tooltipSequentialUpdate"/);
assert.doesNotMatch(managerHtml, /data-i18n-title="managerSequentialUpdateTitle"/);
assert.match(managerHtml, /data-i18n="managerSelectMissing"/);
assert.match(managerHtml, /data-i18n="managerInvertSelection"/);
assert.match(managerHtml, /value="import" data-i18n="sourceImport"/);
assert.match(managerSource, /"count-cell"/);
assert.doesNotMatch(managerSource, /\.sort\(\(a, b\) => String\(b\.lastSeenAt/);
assert.doesNotMatch(managerSource, /relationshipLabel/);
assert.match(managerSource, /t\("managerNoPostUserList"\)/);
assert.match(managerSource, /t\("managerNoPostImport"\)/);
assert.match(managerSource, /selectObservedPost/);
assert.doesNotMatch(managerSource, /includeComments:\s*showCommentsToggle\.checked/);
assert.match(managerSource, /includeComments:\s*true/);
assert.match(managerSource, /user\.sources\.length > 0 \|\| \(core\.userHasCommentSource/);
assert.match(managerSource, /post-kind-badge/);
assert.match(managerSource, /post-summary-content/);
assert.match(managerSource, /if \(kindLabel\)/);
assert.match(managerSource, /postBadgeLabel\(post,\s*user\)/);
assert.match(managerSource, /return t\("postKindImport"\)/);
assert.match(managerSource, /unknown:\s*t\("postKindOriginal"\)/);
assert.match(managerSource, /comment:\s*t\("sourceComment"\)/);
assert.match(managerSource, /dropImportSourceWhenFresh/);
assert.doesNotMatch(managerSource, /评论区/);
assert.doesNotMatch(managerSource, /来自用户列表|来自用户导入|顺序更新中断|请先选择/);
assert.doesNotMatch(managerSource, /preferCommentsToggle\.disabled\s*=\s*!showCommentsToggle\.checked/);
assert.doesNotMatch(managerSource, /preferCommentsToggle\.checked\s*=\s*false/);
assert.match(managerSource, /import:\s*t\("sourceImport"\)/);
assert.match(managerSource, /importUsersFromFile/);
assert.match(managerSource, /openSelectedProfiles/);
assert.match(managerSource, /startSequentialUpdate/);
assert.match(managerSource, /xfs:updateProfileStats/);
assert.match(managerSource, /renderSummary/);
assert.match(managerSource, /t\("managerSummary",\s*users\.length,\s*visibleUsers\.length,\s*selected\.size\)/);
assert.match(managerSource, /statusMessage \? `\$\{base\} \$\{statusMessage\}` : base/);
assert.match(managerSource, /clearStatusMessage/);
assert.doesNotMatch(managerSource, /summary\.textContent = statusMessage;/);
assert.doesNotMatch(managerSource, /顺序更新完成/);
assert.doesNotMatch(managerSource, /已更新 \$\{/);
assert.doesNotMatch(managerSource, /未读到 \$\{/);
assert.match(managerSource, /chrome\.tabs\.sendMessage/);
assert.match(managerSource, /chrome\.tabs\.update/);
assert.match(managerSource, /tabsUpdateWithRetry/);
assert.match(managerSource, /isTransientTabEditError/);
assert.match(managerSource, /Tabs cannot be edited right now/);
assert.match(managerSource, /manualStop/);
assert.match(managerSource, /if \(result && result\.manualStop\)/);
assert.match(managerSource, /tabsCreate\(\{\s*url,\s*active:\s*true\s*\}\)/);
assert.match(managerSource, /tabsUpdateWithRetry\(sequentialUpdate\.tabId,\s*\{\s*url\s*\}\)/);
assert.doesNotMatch(managerSource, /chrome\.tabs\.update\(managerTabId/);
assert.match(managerSource, /forceLockListDuringRun/);
assert.match(managerSource, /SEQUENTIAL_STEP_PAUSE_MIN_MS/);
assert.match(managerSource, /selectMissingVisible/);
assert.match(managerSource, /invertVisibleSelection/);
assert.match(managerSource, /hasCompleteStats/);
assert.match(managerSource, /chrome\.tabs\.create\(\{\s*url:\s*profileUrl/);
assert.match(contentSource, /determinePostKind/);
assert.match(contentSource, /xfs:updateProfileStats/);
assert.match(contentSource, /performProfileStatsUpdate/);
assert.match(contentSource, /gentleProfileScroll/);
assert.match(contentSource, /readCurrentProfileStats/);
assert.doesNotMatch(managerSource, /document\.createElement\("details"\)/);
assert.doesNotMatch(managerSource, /cell\(renderUser\(user\),\s*"user-cell"\)/);
assert.doesNotMatch(managerSource, /\$\{posts\.length\} 条/);
assert.doesNotMatch(managerSource, /pageData:\s*"页面数据"/);
assert.doesNotMatch(managerSource, /hover:\s*"悬停卡片"/);
assert.doesNotMatch(managerCss, /\.post-list/);
assert.doesNotMatch(managerCss, /max-height:\s*120px/);
assert.match(managerCss, /\.post-summary[\s\S]*?display:\s*inline-grid/);
assert.match(managerCss, /\.post-summary[\s\S]*?grid-template-columns:\s*max-content minmax\(0,\s*1fr\)/);
assert.doesNotMatch(managerCss, /\.post-summary[\s\S]*?flex-wrap:\s*wrap/);
assert.match(managerCss, /\.icon-button[\s\S]*?width:\s*36px/);
assert.match(managerCss, /\.icon-button\.is-running svg[\s\S]*?animation:\s*xfs-spin/);
assert.match(managerCss, /\.has-tooltip::after[\s\S]*?content:\s*attr\(data-tooltip\)/);
assert.match(managerCss, /\.has-tooltip:hover::after/);
assert.match(managerCss, /transition-delay:\s*0ms/);
assert.match(managerCss, /\.manager-controls[\s\S]*?z-index:\s*20/);
assert.match(managerCss, /\.table-wrap[\s\S]*?z-index:\s*1/);
assert.match(popupCss, /\.has-tooltip::after[\s\S]*?content:\s*attr\(data-tooltip\)/);
assert.match(popupCss, /\.has-tooltip:hover::after/);
assert.match(popupCss, /transition-delay:\s*0ms/);
assert.match(contentCss, /\.xfs-userlist-anchor[\s\S]*?display:\s*flex/);
assert.match(contentCss, /\.xfs-userlist-anchor \.xfs-stats-pill[\s\S]*?margin-left:\s*0/);
assert.match(managerCss, /\.count-column,[\s\S]*?white-space:\s*nowrap/);
assert.match(contentSource, /persistCacheNow\(\);\s*\n\s*updateVisibleCells\(username\);/);
assert.match(popupSource, /clearButton\.addEventListener\("click", clearCache\)/);
assert.match(popupSource, /lockListToggle/);
assert.match(popupSource, /updateOnlyExisting:\s*lockListToggle\.checked/);
assert.match(popupSource, /lockListToggle\.checked = normalized\.updateOnlyExisting/);
assert.match(popupSource, /chrome\.storage\.local\.set\(\{\s*\[STORAGE_KEY\]:\s*\{\}\s*\}\)/);
assert.match(contentSource, /changes\[STORAGE_KEY\]/);
assert.match(contentSource, /clearLocalCache\(\);/);
assert.match(contentSource, /shouldRecordUsername/);
assert.match(contentSource, /state\.settings\.updateOnlyExisting/);
assert.match(contentSource, /if \(!shouldRecordUsername\(profile\.username\)\)/);
assert.match(contentSource, /retryLoadingPills/);
assert.match(contentSource, /xfs-stats-pill\[data-xfs-state="loading"\]/);
assert.match(contentSource, /t\("pillStatsText"/);
assert.match(contentSource, /t\("pillWaitingData"\)/);
assert.doesNotMatch(contentSource, /等待数据|读取中|正在读取头像悬停卡片/);
assert.match(contentSource, /queueHover\(profile,\s*cell,\s*surface/);
assert.match(contentSource, /ensureUserListPillAnchor/);
assert.match(contentSource, /xfs-userlist-anchor/);
assert.match(contentSource, /findHandleRowAfterNameLink/);
assert.doesNotMatch(contentSource, /nameLink\.insertAdjacentElement\("afterend", pill\)/);
assert.match(managerSource, /chrome\.storage\.onChanged\.addListener/);
assert.doesNotMatch(popupHtml, /只更新已有用户/);
assert.match(managerHtml, /data-i18n="managerLockList"/);
assert.match(managerHtml, /id="lock-list-toggle"/);
assert.match(managerHtml, /data-i18n-tooltip="tooltipLockList"/);
assert.match(managerSource, /DISPLAY_SETTINGS_KEY/);
assert.match(managerSource, /LANGUAGE_KEY/);
assert.match(managerSource, /XFSI18n/);
assert.match(managerSource, /lockListToggle/);
assert.match(managerSource, /updateOnlyExisting/);
assert.match(popupSource, /LANGUAGE_KEY/);
assert.match(popupSource, /languageToggle/);
assert.match(popupSource, /updateLanguagePreference/);
assert.match(popupSource, /languageToggle\.checked \? "zh_CN" : "en"/);
assert.match(popupSource, /languageToggle\.checked = language === "zh_CN"/);
assert.match(popupSource, /chrome\.storage\.local\.set\(\{\s*\[LANGUAGE_KEY\]/);
assert.match(contentSource, /LANGUAGE_KEY/);
assert.match(contentSource, /xfs:updateLanguage/);
assert.match(contentSource, /XFSI18n/);

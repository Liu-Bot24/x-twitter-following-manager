(function installXFSI18n(global) {
  "use strict";

  const LANGUAGE_KEY = "xfs:languagePreferenceV1";
  const DEFAULT_LANGUAGE = "en";
  const MESSAGES = {
    en: {
      actionTitle: "X/Twitter Following Manager",
      authorText: "Created by @liuqi",
      extensionDescription: "Instantly show follower counts on X/Twitter pages, manage following lists, and export data locally.",
      extensionName: "X/Twitter Following Manager - Instantly Show Follower Counts & Export Lists",
      followersLabel: "Followers",
      followingLabel: "Following",
      htmlLang: "en",
      languageSwitchTitle: "Switch language",
      languageSwitchZh: "中",
      languageSwitchEn: "EN",
      listSeparator: ", ",
      managerAllSources: "All sources",
      managerClearSelection: "Clear selection",
      managerColumnFollowers: "Followers",
      managerColumnFollowing: "Following",
      managerColumnLastSeen: "Last seen",
      managerColumnLatestPost: "Latest browsed post",
      managerColumnSource: "Source",
      managerColumnUser: "User",
      managerEmptyState: "No users captured yet. Open X, scroll a page, then refresh here.",
      managerExportFormatAria: "Export format",
      managerExportSelected: "Export selected",
      managerImportUsers: "Import from file",
      managerInvertSelection: "Invert selection",
      managerLockList: "Lock account list",
      managerNoImportUsers: "No importable users were found in this file.",
      managerNoPostGeneric: "No browsed post yet",
      managerNoPostImport: "Imported from user file, no browsed post yet",
      managerNoPostUserList: "From user list, no browsed post yet",
      managerOpenLink: "Open",
      managerOpenSelectedProfiles: "Batch open profiles",
      managerPreferComments: "Prefer replies",
      managerRefreshData: "Refresh data",
      managerSearchPlaceholder: "Search name, handle, bio, post",
      managerSelectMissing: "Select missing results",
      managerSelectUserAria: "Select @$1",
      managerSelectUsersFirst: "Select accounts to update first.",
      managerSelectVisible: "Select current results",
      managerSequentialInterrupted: "Sequential update interrupted: $1",
      managerSequentialStop: "Stopping sequential update after the current account finishes.",
      managerSequentialStopTitle: "Stop sequential update",
      managerSequentialUpdateTitle: "Sequentially update selected accounts",
      managerShowComments: "Show reply-list source",
      managerSourceFilterAria: "Source filter",
      managerSummary: "$1 users total, $2 current results, $3 selected.",
      managerSummaryLoading: "Loading local captured data...",
      managerTableAria: "User table",
      managerToggleVisibleAria: "Toggle current results",
      managerUpdatingSequential: "Sequentially updating $1/$2: @$3",
      pillHoverInterruptedTitle: "Hover card reading was interrupted by the page. The extension will keep retrying.",
      pillHoverMissingTitle: "No hover card was read this time. The extension will keep retrying.",
      pillHoverReadingTitle: "Reading avatar hover card.",
      pillLoadingFullTitle: "Getting counts from X page data and avatar hover cards.",
      pillLoadingShortTitle: "Reading counts.",
      pillReading: "Reading",
      pillStatsText: "$1 Following · $2 Followers",
      pillWaitingData: "Waiting",
      popupCacheCleared: "Cache cleared.",
      popupCacheCountLabel: "Cached users",
      popupCapturedStatus: "Captured $1 users, queue $2",
      popupClearCache: "Clear cache",
      popupHint: "Toggles control where counts appear on the current page and after refresh.",
      popupMetricsAria: "Status",
      popupOpenManager: "Open manager",
      popupRescan: "Rescan this page",
      popupScriptNotReady: "The extension script is not loaded in this tab yet. Refresh X and try again.",
      popupSettingsAria: "Display surfaces",
      popupStatusLoading: "Loading status...",
      popupUseOnX: "Use this on x.com or twitter.com pages.",
      popupVisibleCountLabel: "Visible items",
      postKindComment: "Reply",
      postKindImport: "Import",
      postKindOriginal: "Original",
      postKindRetweet: "Repost",
      shortName: "X/Twitter Following Manager",
      sourceComment: "Reply list",
      sourceFeed: "Feed",
      sourceImport: "Import",
      sourcePrefix: "Source: ",
      sourceUserList: "User lists",
      tooltipLockList: "Lock the manager to accounts already captured or imported. While this is on, browsing X only updates existing rows and does not add newly seen accounts to the manager.",
      tooltipPreferComments: "When an account has both posts and replies recorded, show the latest reply first. This only changes the displayed post, not which users appear.",
      tooltipSequentialStop: "Stop after the current account finishes.",
      tooltipSequentialUpdate: "Open one selected profile at a time to refresh follower and following counts. The account list is locked during the run; closing the updater tab stops it.",
      tooltipShowComments: "Show accounts captured only from reply lists. Accounts also seen in the Feed or user lists stay visible when this is off."
    },
    zh_CN: {
      actionTitle: "X/Twitter 关注管理器",
      authorText: "Created by @liuqi",
      extensionDescription: "在 X/Twitter 页面直接显示粉丝数，管理关注名单，并将数据导出到本地。",
      extensionName: "X/Twitter 关注管理器 - 直接显示粉丝数，管理并导出名单",
      followersLabel: "关注者",
      followingLabel: "正在关注",
      htmlLang: "zh-CN",
      languageSwitchTitle: "切换语言",
      languageSwitchZh: "中",
      languageSwitchEn: "EN",
      listSeparator: "、",
      managerAllSources: "全部来源",
      managerClearSelection: "清空选择",
      managerColumnFollowers: "关注者",
      managerColumnFollowing: "正在关注",
      managerColumnLastSeen: "最近看到",
      managerColumnLatestPost: "已浏览的最新推文",
      managerColumnSource: "来源",
      managerColumnUser: "用户",
      managerEmptyState: "还没有捕获到用户。打开 X 页面并滚动后再回来刷新。",
      managerExportFormatAria: "导出格式",
      managerExportSelected: "导出选中",
      managerImportUsers: "从文件导入",
      managerInvertSelection: "反向选择",
      managerLockList: "锁定账号列表",
      managerNoImportUsers: "没有从文件中识别到可导入用户。",
      managerNoPostGeneric: "未浏览到推文",
      managerNoPostImport: "来自用户导入，未浏览到推文",
      managerNoPostUserList: "来自用户列表，未浏览到推文",
      managerOpenLink: "打开",
      managerOpenSelectedProfiles: "批量打开主页",
      managerPreferComments: "评论优先",
      managerRefreshData: "刷新数据",
      managerSearchPlaceholder: "搜索昵称、ID、简介、推文",
      managerSelectMissing: "选中缺失结果",
      managerSelectUserAria: "选择 @$1",
      managerSelectUsersFirst: "请先选择需要更新的账号。",
      managerSelectVisible: "全选当前结果",
      managerSequentialInterrupted: "顺序更新中断：$1",
      managerSequentialStop: "正在停止顺序更新，当前账号处理完后结束。",
      managerSequentialStopTitle: "停止顺序更新",
      managerSequentialUpdateTitle: "顺序更新选中账号数据",
      managerShowComments: "显示评论列表来源",
      managerSourceFilterAria: "来源筛选",
      managerSummary: "共 $1 个用户，当前结果 $2 个，已选 $3 个。",
      managerSummaryLoading: "正在读取本地捕获数据...",
      managerTableAria: "用户表",
      managerToggleVisibleAria: "切换当前结果选择",
      managerUpdatingSequential: "正在顺序更新 $1/$2：@$3",
      pillHoverInterruptedTitle: "悬停卡片读取被页面打断，扩展会继续重试。",
      pillHoverMissingTitle: "这次没有读到悬停卡片，扩展会继续重试。",
      pillHoverReadingTitle: "正在读取头像悬停卡片。",
      pillLoadingFullTitle: "正在通过 X 页面数据和头像悬停卡片获取关注数。",
      pillLoadingShortTitle: "正在读取关注数。",
      pillReading: "读取中",
      pillStatsText: "$1 正在关注 · $2 关注者",
      pillWaitingData: "等待数据",
      popupCacheCleared: "缓存已清除。",
      popupCacheCountLabel: "缓存用户",
      popupCapturedStatus: "已捕获 $1 个用户，队列 $2",
      popupClearCache: "清除缓存",
      popupHint: "开关会控制当前页面和后续刷新后的显示位置。",
      popupMetricsAria: "状态",
      popupOpenManager: "打开用户管理页",
      popupRescan: "重新扫描本页",
      popupScriptNotReady: "当前标签页还没有加载插件脚本，刷新 X 页面后再试。",
      popupSettingsAria: "显示位置",
      popupStatusLoading: "正在读取状态...",
      popupUseOnX: "请在 x.com 或 twitter.com 页面使用。",
      popupVisibleCountLabel: "当前条目",
      postKindComment: "评论",
      postKindImport: "导入",
      postKindOriginal: "原创",
      postKindRetweet: "转推",
      shortName: "X/Twitter 关注管理器",
      sourceComment: "评论列表",
      sourceFeed: "Feed 流",
      sourceImport: "导入",
      sourcePrefix: "来源：",
      sourceUserList: "用户列表",
      tooltipLockList: "锁定当前已捕获或导入的账号列表。开启后，浏览 X 只更新这些账号的数据，不会把新看到的账号加入管理页。",
      tooltipPreferComments: "当同一个账号同时有推文和评论记录时，优先展示最新评论。它只影响已浏览推文这一列，不筛选用户。",
      tooltipSequentialStop: "当前账号处理完后停止顺序更新。",
      tooltipSequentialUpdate: "按顺序打开选中的账号主页，逐个刷新关注数和粉丝数。运行期间会锁定账号列表；关闭更新标签页即可停止。",
      tooltipShowComments: "显示只从评论列表捕获到的账号。若账号也出现在 Feed 流或用户列表里，关闭后仍会保留。"
    }
  };

  function normalizeLanguage(value) {
    const text = String(value || "").replace("-", "_").toLowerCase();
    if (text === "zh" || text === "zh_cn" || text === "zh_hans") {
      return "zh_CN";
    }
    if (text === "en" || text.startsWith("en_")) {
      return "en";
    }
    return "";
  }

  function browserLanguage() {
    if (global.chrome && chrome.i18n && typeof chrome.i18n.getUILanguage === "function") {
      return chrome.i18n.getUILanguage();
    }
    if (global.navigator && navigator.language) {
      return navigator.language;
    }
    return DEFAULT_LANGUAGE;
  }

  function resolveLanguage(preference, browserLocale) {
    return normalizeLanguage(preference) || normalizeLanguage(browserLocale || browserLanguage()) || DEFAULT_LANGUAGE;
  }

  function localeTag(preference, browserLocale) {
    return resolveLanguage(preference, browserLocale) === "zh_CN" ? "zh-CN" : "en";
  }

  function getMessage(key, substitutions, preference, browserLocale) {
    const language = resolveLanguage(preference, browserLocale);
    const dictionary = MESSAGES[language] || MESSAGES[DEFAULT_LANGUAGE];
    let message = dictionary[key] || MESSAGES[DEFAULT_LANGUAGE][key] || key;
    (Array.isArray(substitutions) ? substitutions : []).forEach((value, index) => {
      message = message.replace(new RegExp(`\\$${index + 1}`, "g"), String(value));
    });
    return message;
  }

  function applyStatic(root, preference) {
    const target = root || global.document;
    if (!target) {
      return;
    }
    const language = resolveLanguage(preference);
    const html = target.documentElement || target.ownerDocument && target.ownerDocument.documentElement;
    if (html) {
      html.lang = getMessage("htmlLang", [], language);
    }
    if (target.title !== undefined) {
      target.title = getMessage("shortName", [], language);
    }
    target.querySelectorAll("[data-i18n]").forEach(element => {
      element.textContent = getMessage(element.dataset.i18n, [], language);
    });
    target.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
      element.setAttribute("placeholder", getMessage(element.dataset.i18nPlaceholder, [], language));
    });
    target.querySelectorAll("[data-i18n-aria-label]").forEach(element => {
      element.setAttribute("aria-label", getMessage(element.dataset.i18nAriaLabel, [], language));
    });
    target.querySelectorAll("[data-i18n-title]").forEach(element => {
      element.setAttribute("title", getMessage(element.dataset.i18nTitle, [], language));
    });
    target.querySelectorAll("[data-i18n-tooltip]").forEach(element => {
      element.dataset.tooltip = getMessage(element.dataset.i18nTooltip, [], language);
    });
  }

  global.XFSI18n = {
    LANGUAGE_KEY,
    MESSAGES,
    applyStatic,
    getMessage,
    localeTag,
    normalizeLanguage,
    resolveLanguage
  };
})(globalThis);

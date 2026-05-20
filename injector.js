(function injectXFollowStatsPageHook() {
  "use strict";

  if (window.__xFollowStatsInjectorLoaded) {
    return;
  }
  window.__xFollowStatsInjectorLoaded = true;

  const scriptUrls = [chrome.runtime.getURL("stats-core.js"), chrome.runtime.getURL("page-hook.js")];

  function appendScript(index) {
    if (index >= scriptUrls.length) {
      return;
    }
    const script = document.createElement("script");
    script.src = scriptUrls[index];
    script.async = false;
    script.onload = () => {
      script.remove();
      appendScript(index + 1);
    };
    script.onerror = () => {
      script.remove();
      appendScript(index + 1);
    };
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  if (document.documentElement) {
    appendScript(0);
    return;
  }

  const observer = new MutationObserver(() => {
    if (!document.documentElement) {
      return;
    }
    observer.disconnect();
    appendScript(0);
  });
  observer.observe(document, { childList: true });
})();

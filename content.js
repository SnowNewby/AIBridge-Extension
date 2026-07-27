(() => {
  const ROOT_ID = "ai-bridge-extension-root";

  function mount() {
    if (document.getElementById(ROOT_ID)) return;
    const root = document.createElement("div");
    root.id = ROOT_ID;
    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("chat.html");
    iframe.title = "AI Bridge";
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    root.appendChild(iframe);
    document.documentElement.appendChild(root);
    document.documentElement.classList.add("ai-bridge-active");
  }

  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
})();

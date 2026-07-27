(() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("access_token");
  const error = params.get("error");
  const description = params.get("error_description");

  if (token) {
    chrome.runtime.sendMessage({ type: "YANDEX_OAUTH_CALLBACK", token });
    return;
  }

  if (error) {
    chrome.runtime.sendMessage({
      type: "YANDEX_OAUTH_CALLBACK_ERROR",
      error: description || error
    });
  }
})();

importScripts("config.js");

const CONFIG = globalThis.AIBRIDGE_CONFIG;
const API = "https://cloud-api.yandex.net/v1/disk";
const ROOT = CONFIG.ROOT_PATH;
const REQUESTS = `${ROOT}/requests`;
const RESPONSES = `${ROOT}/responses`;
const ATTACHMENTS = `${ROOT}/attachments`;
const ARCHIVE = `${ROOT}/archive`;
const CONVERSATIONS = `${ROOT}/conversations`;
const UI = `${ROOT}/ui`;
const UI_CHATS = `${UI}/chats.json`;
const SESSIONS = `${ROOT}/sessions`;

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function storageRemove(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

function validateClientId() {
  const clientId = String(CONFIG.YANDEX_CLIENT_ID || "").trim();
  if (!clientId || clientId.includes("PASTE_YOUR")) {
    throw new Error("Вставь Yandex Client ID в config.js расширения");
  }
  return clientId;
}

function getRedirectUri() {
  return "https://oauth.yandex.ru/verification_code";
}

async function loginWithYandex() {
  const clientId = validateClientId();
  const authUrl = new URL("https://oauth.yandex.ru/authorize");
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", getRedirectUri());
  authUrl.searchParams.set("force_confirm", "yes");
  await chrome.tabs.create({ url: authUrl.toString(), active: true });
  return { opened: true };
}

async function logoutYandex() {
  await storageRemove(["yandexOAuthToken", "yandexUser"]);
}

async function getToken() {
  const result = await storageGet(["yandexOAuthToken"]);
  const token = String(result.yandexOAuthToken || "").trim();
  if (!token) throw new Error("Сначала войди через Яндекс");
  return token;
}

async function parseError(response) {
  try {
    const body = await response.json();
    return body.message || body.description || body.error || JSON.stringify(body);
  } catch {
    return await response.text().catch(() => "");
  }
}

async function apiFetch(path, options = {}) {
  const token = await getToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `OAuth ${token}`);
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (!response.ok) {
    const details = await parseError(response);
    throw new Error(`Яндекс.Диск: HTTP ${response.status}${details ? ` — ${details}` : ""}`);
  }
  return response;
}

async function resourceExists(path) {
  const token = await getToken();
  const response = await fetch(`${API}/resources?path=${encodeURIComponent(path)}&fields=path`, {
    headers: { Authorization: `OAuth ${token}` },
    cache: "no-store"
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    const details = await parseError(response);
    throw new Error(`Яндекс.Диск: HTTP ${response.status}${details ? ` — ${details}` : ""}`);
  }
  return true;
}

async function ensureDirectory(path) {
  if (await resourceExists(path)) return;
  const response = await fetch(`${API}/resources?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { Authorization: `OAuth ${await getToken()}` }
  });
  if (!response.ok && response.status !== 409) {
    const details = await parseError(response);
    throw new Error(`Не удалось создать ${path}: HTTP ${response.status}${details ? ` — ${details}` : ""}`);
  }
}

async function ensureStructure() {
  for (const path of [ROOT, REQUESTS, RESPONSES, ATTACHMENTS, ARCHIVE, CONVERSATIONS, UI, SESSIONS]) {
    await ensureDirectory(path);
  }
}

async function getUploadLink(path, overwrite = true) {
  const response = await apiFetch(`/resources/upload?path=${encodeURIComponent(path)}&overwrite=${overwrite}`);
  const data = await response.json();
  if (!data.href) throw new Error("Яндекс.Диск не вернул ссылку для загрузки");
  return data;
}

async function uploadBlob(path, blob, contentType = "application/octet-stream") {
  const { href, method = "PUT" } = await getUploadLink(path, true);
  const response = await fetch(href, {
    method,
    headers: { "Content-Type": contentType },
    body: blob
  });
  if (!response.ok) throw new Error(`Не удалось загрузить ${path}: HTTP ${response.status}`);
}

async function uploadJson(path, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json; charset=utf-8" });
  await uploadBlob(path, blob, blob.type);
}

async function downloadJson(path) {
  const linkResponse = await apiFetch(`/resources/download?path=${encodeURIComponent(path)}`);
  const { href } = await linkResponse.json();
  if (!href) throw new Error("Яндекс.Диск не вернул ссылку для скачивания");
  const response = await fetch(href, { cache: "no-store" });
  if (!response.ok) throw new Error(`Не удалось скачать ${path}: HTTP ${response.status}`);
  return await response.json();
}

async function deleteResource(path) {
  const token = await getToken();
  const response = await fetch(`${API}/resources?path=${encodeURIComponent(path)}&permanently=true`, {
    method: "DELETE",
    headers: { Authorization: `OAuth ${token}` }
  });
  if (![202, 204, 404].includes(response.status) && !response.ok) {
    throw new Error(`Не удалось удалить ${path}: HTTP ${response.status}`);
  }
}

async function moveResource(from, to, overwrite = true) {
  const token = await getToken();
  const response = await fetch(
    `${API}/resources/move?from=${encodeURIComponent(from)}&path=${encodeURIComponent(to)}&overwrite=${overwrite}`,
    { method: "POST", headers: { Authorization: `OAuth ${token}` } }
  );
  if (!response.ok && response.status !== 202) {
    const details = await parseError(response);
    throw new Error(`Не удалось переместить файл: HTTP ${response.status}${details ? ` — ${details}` : ""}`);
  }
}

async function testConnection() {
  validateClientId();
  const response = await apiFetch("?fields=user.display_name,user.login,total_space,used_space");
  const data = await response.json();
  await ensureStructure();
  const user = {
    displayName: data.user?.display_name || data.user?.login || "Пользователь",
    login: data.user?.login || "",
    totalSpace: data.total_space || 0,
    usedSpace: data.used_space || 0
  };
  await storageSet({ yandexUser: user });
  return user;
}


function safeConversationId(value) {
  const safe = String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe || "default";
}

async function loadCloudChats() {
  await ensureStructure();
  if (!(await resourceExists(UI_CHATS))) return null;
  return await downloadJson(UI_CHATS);
}

async function saveCloudChats(snapshot) {
  await ensureStructure();
  await uploadJson(UI_CHATS, snapshot);
  return { saved: true };
}

async function deleteConversation(conversationId) {
  if (!conversationId) return { deleted: false };
  await deleteResource(`${CONVERSATIONS}/${safeConversationId(conversationId)}.json`);
  return { deleted: true };
}

async function uploadAttachments(requestId, attachments = []) {
  if (!attachments.length) return [];
  const requestFolder = `${ATTACHMENTS}/${requestId}`;
  await ensureDirectory(requestFolder);
  const result = [];
  for (const file of attachments) {
    const safeName = String(file.name || "file.bin").replace(/[\\/:*?"<>|]/g, "_");
    const path = `${requestFolder}/${safeName}`;
    const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
    await uploadBlob(path, bytes, file.type || "application/octet-stream");
    result.push({
      name: safeName,
      path,
      type: file.type || "application/octet-stream",
      size: file.size || bytes.byteLength
    });
  }
  return result;
}

async function sendPrompt(payload, attachments) {
  await ensureStructure();
  const uploadedAttachments = await uploadAttachments(payload.id, attachments);
  const request = { ...payload, attachments: uploadedAttachments };
  const requestPath = `${REQUESTS}/${payload.id}.json`;
  await uploadJson(requestPath, request);
  return { requestPath, attachments: uploadedAttachments };
}


async function checkSession(id) {
  const path = `${SESSIONS}/${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}/status.json`;
  if (!(await resourceExists(path))) return { found: false };
  return { found: true, data: await downloadJson(path) };
}

async function sendSessionInput(id, value) {
  await ensureStructure();
  const sessionPath = `${SESSIONS}/${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  await ensureDirectory(sessionPath);
  await uploadJson(`${sessionPath}/input.json`, { value: String(value), createdAt: new Date().toISOString() });
  return { sent: true };
}

async function checkResponse(id) {
  const responsePath = `${RESPONSES}/${id}.json`;
  if (!(await resourceExists(responsePath))) return { found: false };
  const data = await downloadJson(responsePath);
  return { found: true, data, responsePath };
}

async function archiveResponse(path, id) {
  const target = `${ARCHIVE}/${id}.response.json`;
  await moveResource(path, target, true);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_AUTH_STATE": {
        const values = await storageGet(["yandexOAuthToken", "yandexUser"]);
        return {
          ok: true,
          data: {
            authenticated: Boolean(String(values.yandexOAuthToken || "").trim()),
            user: values.yandexUser || null,
            clientIdConfigured: !String(CONFIG.YANDEX_CLIENT_ID || "").includes("PASTE_YOUR"),
            redirectUri: getRedirectUri()
          }
        };
      }
      case "LOGIN_YANDEX":
        return { ok: true, data: await loginWithYandex() };
      case "LOGOUT_YANDEX":
        await logoutYandex();
        return { ok: true };
      case "TEST_CONNECTION":
        return { ok: true, data: await testConnection() };
      case "SEND_PROMPT":
        return { ok: true, data: await sendPrompt(message.payload, message.attachments || []) };
      case "LOAD_CLOUD_CHATS":
        return { ok: true, data: await loadCloudChats() };
      case "SAVE_CLOUD_CHATS":
        return { ok: true, data: await saveCloudChats(message.snapshot) };
      case "DELETE_CONVERSATION":
        return { ok: true, data: await deleteConversation(message.conversationId) };
      case "CHECK_RESPONSE":
        return { ok: true, data: await checkResponse(message.id) };
      case "CHECK_SESSION":
        return { ok: true, data: await checkSession(message.id) };
      case "SEND_SESSION_INPUT":
        return { ok: true, data: await sendSessionInput(message.id, message.value) };
      case "ARCHIVE_RESPONSE":
        await archiveResponse(message.path, message.id);
        return { ok: true };
      case "DELETE_RESPONSE":
        await deleteResource(message.path);
        return { ok: true };
      case "YANDEX_OAUTH_CALLBACK":
        if (!message.token) throw new Error("Яндекс не вернул access_token");
        await storageSet({ yandexOAuthToken: message.token });
        if (sender?.tab?.id) await chrome.tabs.remove(sender.tab.id).catch(() => {});
        return { ok: true };
      case "YANDEX_OAUTH_CALLBACK_ERROR":
        throw new Error(message.error || "Ошибка OAuth Яндекса");
      default:
        throw new Error("Неизвестная команда расширения");
    }
  })()
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

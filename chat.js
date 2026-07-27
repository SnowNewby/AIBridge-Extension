const $ = id => document.getElementById(id);
const messages = $("messages"), promptInput = $("promptInput"), sendButton = $("sendButton");
const CHATS_KEY = "aiBridgeChatsV2", ACTIVE_KEY = "aiBridgeActiveChatV2", LEGACY_KEY = "aiBridgeChatHistoryV1", SETTINGS_KEY = "aiBridgeUiSettingsV1";
const POLL_INTERVAL_MS = 1000, RESPONSE_TIMEOUT_MS = 20 * 60 * 1000, WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const USAGE_KEY = "aiBridgeWeeklyUsageV1", CLOUD_REV_KEY = "aiBridgeCloudRevisionV1";
let usageEvents = [];
let chats = [], activeId = "", selectedFiles = [], sending = false;
let cloudReady = false, cloudSynced = false, cloudSyncing = false, cloudSaveTimer = 0;
const currentChat = () => chats.find(chat => chat.id === activeId);
const storageGet = keys => new Promise(resolve => chrome.storage.local.get(keys, resolve));
const storageSet = value => new Promise(resolve => chrome.storage.local.set(value, resolve));
function runtimeMessage(message) { return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => { const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else if (!response?.ok) reject(new Error(response?.error || "Ошибка расширения")); else resolve(response.data); })); }
function newChat(history = []) { const id = crypto.randomUUID(); return { id, conversationId: `chat-${id}`, mode: "normal", model: "", title: history.length ? "Первый чат" : "Новый чат", messages: history, updatedAt: Date.now() }; }
async function persist() {
  await storageSet({ [CHATS_KEY]: chats, [ACTIVE_KEY]: activeId });
  if (cloudReady) scheduleCloudSave();
}
function scheduleCloudSave() { clearTimeout(cloudSaveTimer); cloudSaveTimer=setTimeout(()=>saveCloud().catch(()=>{}),900); }
async function saveCloud(force=false) {
  if (!cloudReady || (cloudSyncing&&!force)) return;
  const updatedAt=Date.now(), snapshot={version:1,updatedAt,activeChatId:activeId,chats};
  await runtimeMessage({type:"SAVE_CLOUD_CHATS",snapshot});
  await storageSet({[CLOUD_REV_KEY]:updatedAt});
  cloudSynced=true;
}
async function syncFromCloud() {
  if (cloudSynced || cloudSyncing) return;
  cloudSyncing=true;
  try {
    const [remote,local]=await Promise.all([runtimeMessage({type:"LOAD_CLOUD_CHATS"}),storageGet([CLOUD_REV_KEY])]);
    const localRevision=Number(local[CLOUD_REV_KEY])||0;
    if (Array.isArray(remote?.chats) && remote.chats.length && Number(remote.updatedAt)>localRevision) {
      chats=remote.chats.map(chat=>({...chat,mode:chat.mode||"normal",model:chat.model||"",messages:Array.isArray(chat.messages)?chat.messages:[]}));
      activeId=chats.some(chat=>chat.id===remote.activeChatId)?remote.activeChatId:chats[0].id;
      await storageSet({[CHATS_KEY]:chats,[ACTIVE_KEY]:activeId,[CLOUD_REV_KEY]:Number(remote.updatedAt)||Date.now()});
      render();
    }
    cloudReady=true; cloudSynced=true;
    const localUpdated=Math.max(0,...chats.map(chat=>Number(chat.updatedAt)||0));
    if (!remote || localUpdated>Number(remote.updatedAt||0)) await saveCloud(true);
    setStatus("online","Чаты синхронизированы");
  } catch (error) {
    cloudReady=false; cloudSynced=false;
    if (!sending) setStatus("offline",`Синхронизация: ${error.message}`);
  } finally { cloudSyncing=false; }
}
function trimUsage() { const cutoff=Date.now()-WEEK_MS; usageEvents=usageEvents.filter(x=>x.at>=cutoff); }
async function renderUsage() { trimUsage(); const data=await storageGet([SETTINGS_KEY]), limit=Number(data[SETTINGS_KEY]?.weeklyRequestLimit)||0, count=usageEvents.length; $("weeklyUsage").textContent=limit?`За 7 дней: ${count} / ${limit} запросов`:`За 7 дней: ${count} запросов`; $("weeklyUsage").classList.toggle("limit-near",limit>0&&count>=limit); }
async function registerUsage(id, model) { trimUsage(); if(!usageEvents.some(x=>x.id===id)) usageEvents.push({id,model:model||"default",at:Date.now()}); await storageSet({[USAGE_KEY]:usageEvents}); await renderUsage(); }
function setStatus(kind, text) { $("status").className = `status ${kind}`; $("statusText").textContent = text; }
function record(role, text, options = {}) { return { id: options.id || crypto.randomUUID(), role, text: String(text ?? ""), state: options.state || "", interactive: options.interactive || null, error: !!options.error }; }
function appendContent(node, text) {
  const parts = String(text).split(/```([^\n`]*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) { const span = document.createElement("span"); span.className = "message-text"; span.textContent = parts[i]; node.append(span); }
    if (i + 2 >= parts.length) continue;
    const source = parts[i + 2].replace(/\n$/, ""), block = document.createElement("div"), head = document.createElement("div"), label = document.createElement("span"), copy = document.createElement("button"), pre = document.createElement("pre"), code = document.createElement("code");
    block.className = "code-block"; head.className = "code-header"; copy.className = "copy-button"; copy.type = "button"; label.textContent = parts[i + 1].trim() || "Код"; copy.textContent = "Копировать"; code.textContent = source;
    copy.onclick = async () => { try { await navigator.clipboard.writeText(source); copy.textContent = "Скопировано"; setTimeout(() => copy.textContent = "Копировать", 1500); } catch { copy.textContent = "Не удалось"; } };
    pre.append(code); head.append(label, copy); block.append(head, pre); node.append(block);
  }
}

async function submitInteractive(item, value) {
  if (!value) return;
  await runtimeMessage({type:"SEND_SESSION_INPUT",id:item.id,value});
  item.interactive=null; item.state=`Ответ отправлен: ${value}`;
  await storageSet({[CHATS_KEY]:chats});
  renderMessages();
}
function appendInteractive(bubble, item) {
  const data=item.interactive;
  if (!data) return;
  const panel=document.createElement("div"), prompt=document.createElement("div");
  panel.className="interactive-panel"; prompt.className="interactive-prompt"; prompt.textContent=data.prompt||"Codex ожидает ответ"; panel.append(prompt);
  if (Array.isArray(data.choices)&&data.choices.length) {
    const choices=document.createElement("div"); choices.className="interactive-choices";
    data.choices.forEach(choice=>{const button=document.createElement("button");button.type="button";button.className="choice-button";const alias=choice.aliases?.[0]?` / ${choice.aliases[0]}`:"";button.textContent=`${choice.value}${alias} — ${choice.label}`;button.onclick=()=>submitInteractive(item,choice.value).catch(error=>setStatus("offline",error.message));choices.append(button);});
    panel.append(choices);
  } else {
    const row=document.createElement("div"), input=document.createElement("input"), send=document.createElement("button");row.className="interactive-input";input.placeholder="Введите ответ Codex…";send.className="primary";send.textContent="Ответить";const submit=()=>submitInteractive(item,input.value.trim()).catch(error=>setStatus("offline",error.message));send.onclick=submit;input.onkeydown=event=>{if(event.key==="Enter")submit();};row.append(input,send);panel.append(row);setTimeout(()=>input.focus(),0);
  }
  bubble.append(panel);
}
function updateLiveMessage(chatId,messageId,status) {
  const chat=chats.find(x=>x.id===chatId),item=chat?.messages.find(x=>x.id===messageId);if(!item)return;
  const parts=[];if(status.message)parts.push(status.message);if(status.agent)parts.push(status.agent);if(status.terminal)parts.push(`\`\`\`terminal\n${status.terminal}\n\`\`\``);
  item.text=parts.join("\n\n")||"Codex работает…";item.state=status.state||"running";item.interactive=status.interactive||null;
  if(chatId===activeId)renderMessages();storageSet({[CHATS_KEY]:chats});
}
function messageNode(item) { const article = document.createElement("article"), role = document.createElement("div"), bubble = document.createElement("div"); article.className = `message ${item.role}${item.error ? " error" : ""}`; article.dataset.id = item.id; role.className = "role"; role.textContent = item.role === "user" ? "Ты" : "Ассистент"; bubble.className = "bubble"; appendContent(bubble, item.text); if (item.state) { const state = document.createElement("div"); state.className = "message-state"; state.textContent = item.state; bubble.append(state); } appendInteractive(bubble,item); article.append(role, bubble); return article; }
function renderMessages() { messages.innerHTML = ""; const history = currentChat()?.messages || []; if (!history.length) messages.append(messageNode(record("assistant", "Готов. Отправь сообщение — у этого чата будет отдельный контекст."))); else history.forEach(item => messages.append(messageNode(item))); messages.scrollTop = messages.scrollHeight; }
function renderChats() { const list = $("chatList"); list.innerHTML = ""; [...chats].sort((a,b) => b.updatedAt-a.updatedAt).forEach(chat => { const row = document.createElement("div"), select = document.createElement("button"), remove = document.createElement("button"); row.className = `chat-item${chat.id === activeId ? " active" : ""}`; select.className = "chat-select"; select.textContent = chat.title; select.title = chat.title; select.onclick = () => switchChat(chat.id); remove.className = "chat-delete"; remove.textContent = "×"; remove.title = "Удалить чат"; remove.onclick = () => deleteChat(chat.id); row.append(select, remove); list.append(row); }); }
function render() { $("chatTitle").textContent = currentChat()?.title || "Новый чат"; $("modeSelect").value=currentChat()?.mode||"normal"; $("modelSelect").value=currentChat()?.model||""; renderChats(); renderMessages(); }
function switchChat(id) { if (sending || id === activeId) return; activeId = id; selectedFiles = []; renderAttachments(); render(); persist(); $("sidebar").classList.remove("open"); }
async function addChat() { if (sending) return; const chat = newChat(); chats.push(chat); activeId = chat.id; await persist(); render(); $("sidebar").classList.remove("open"); promptInput.focus(); }
async function deleteChat(id) { if (sending) return; const chat = chats.find(x => x.id === id); if (!chat || !confirm(`Удалить чат «${chat.title}» с этого устройства и Яндекс.Диска?`)) return; await runtimeMessage({type:"DELETE_CONVERSATION",conversationId:chat.conversationId}).catch(error=>setStatus("offline",error.message)); chats = chats.filter(x => x.id !== id); if (!chats.length) chats.push(newChat()); if (activeId === id) activeId = chats[0].id; await persist(); render(); }
function addMessage(role, text, options={}) { const chat=currentChat(), item=record(role,text,options); chat.messages.push(item); chat.updatedAt=Date.now(); messages.append(messageNode(item)); messages.scrollTop=messages.scrollHeight; persist(); renderChats(); return item; }
function updateMessage(chatId, messageId, text, state="", error=false) { const chat=chats.find(x=>x.id===chatId), item=chat?.messages.find(x=>x.id===messageId); if(!item)return; Object.assign(item,{text,state,error,interactive:null}); chat.updatedAt=Date.now(); if(chatId===activeId)renderMessages(); persist(); renderChats(); }
async function loadState() { const data=await storageGet([CHATS_KEY,ACTIVE_KEY,LEGACY_KEY,USAGE_KEY]); usageEvents=Array.isArray(data[USAGE_KEY])?data[USAGE_KEY]:[]; if(Array.isArray(data[CHATS_KEY])&&data[CHATS_KEY].length){ chats=data[CHATS_KEY]; activeId=chats.some(x=>x.id===data[ACTIVE_KEY])?data[ACTIVE_KEY]:chats[0].id; } else { const old=Array.isArray(data[LEGACY_KEY])?data[LEGACY_KEY].map(x=>record(x.role,x.text,{error:x.error})):[]; const chat=newChat(old); chats=[chat]; activeId=chat.id; await persist(); } render(); }
async function loadSettings(){const data=await storageGet([SETTINGS_KEY]),settings=data[SETTINGS_KEY]||{}; $("clientNameInput").value=settings.clientName||`client-${crypto.randomUUID().slice(0,8)}`; $("weeklyLimitInput").value=settings.weeklyRequestLimit||0; await renderUsage();}
async function refreshAuth(){const state=await runtimeMessage({type:"GET_AUTH_STATE"}); $("clientIdWarning").classList.toggle("hidden",state.clientIdConfigured); $("authState").textContent=state.authenticated?"Авторизован":"Не авторизован"; $("authState").classList.toggle("ok",state.authenticated); $("userName").textContent=state.user?.displayName||""; $("logoutButton").disabled=!state.authenticated; if(!sending)setStatus(state.authenticated?"online":"offline",state.authenticated?"Яндекс подключён":"Не подключено"); if(state.authenticated&&!cloudSynced&&!cloudSyncing)await syncFromCloud(); return state;}
function formatBytes(n){return n<1024?`${n} Б`:n<1048576?`${(n/1024).toFixed(1)} КБ`:`${(n/1048576).toFixed(1)} МБ`;}
function renderAttachments(){const view=$("attachments"); view.innerHTML=""; selectedFiles.forEach((file,i)=>{const chip=document.createElement("div"),name=document.createElement("span"),remove=document.createElement("button");chip.className="attachment-chip";name.textContent=`${file.name} (${formatBytes(file.size)})`;remove.textContent="×";remove.onclick=()=>{selectedFiles.splice(i,1);renderAttachments();};chip.append(name,remove);view.append(chip);});}
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error("Не удалось прочитать файл"));reader.onload=()=>resolve({name:file.name,type:file.type||"application/octet-stream",size:file.size,base64:String(reader.result||"").split(",")[1]||""});reader.readAsDataURL(file);});}
async function pollResponse(requestId,chatId,messageId){const started=Date.now();while(Date.now()-started<RESPONSE_TIMEOUT_MS){await new Promise(r=>setTimeout(r,POLL_INTERVAL_MS));let hasLive=false;try{const live=await runtimeMessage({type:"CHECK_SESSION",id:requestId});if(live.found){hasLive=true;updateLiveMessage(chatId,messageId,live.data||{});}}catch{}const result=await runtimeMessage({type:"CHECK_RESPONSE",id:requestId});if(!result.found){if(!hasLive)updateMessage(chatId,messageId,"Ожидаю запуск домашнего Worker…",`Последняя проверка: ${new Date().toLocaleTimeString()}`);continue;}const response=result.data||{};if(response.status==="error")throw new Error(response.error||"Worker вернул ошибку");const content=response.content??response.answer??response.text;if(typeof content!=="string")throw new Error("В ответе отсутствует поле content");updateMessage(chatId,messageId,content);await registerUsage(requestId,response.model);await runtimeMessage({type:"ARCHIVE_RESPONSE",path:result.responsePath,id:requestId}).catch(()=>{});setStatus("online","Ответ получен");return;}throw new Error("Ответ не появился за 20 минут");}
async function sendPrompt(){const text=promptInput.value.trim();if((!text&&!selectedFiles.length)||sending)return;trimUsage();const limitData=await storageGet([SETTINGS_KEY]),weeklyLimit=Number(limitData[SETTINGS_KEY]?.weeklyRequestLimit)||0;if(weeklyLimit&&usageEvents.length>=weeklyLimit){alert(`Локальный недельный лимит (${weeklyLimit}) исчерпан.`);return;}const auth=await refreshAuth();if(!auth.authenticated){$("settingsDialog").showModal();$("settingsResult").textContent="Сначала войди через Яндекс";return;}const chat=currentChat(),chatId=chat.id,requestId=crypto.randomUUID(),label=text||`[Файлы: ${selectedFiles.map(x=>x.name).join(", ")}]`;addMessage("user",label);if(chat.title==="Новый чат"){chat.title=label.replace(/\s+/g," ").slice(0,42)||"Чат с файлами";persist();renderChats();$("chatTitle").textContent=chat.title;}const pending=addMessage("assistant","Загружаю запрос на Яндекс.Диск…",{id:requestId,state:`ID: ${requestId}`}),files=selectedFiles;selectedFiles=[];renderAttachments();promptInput.value="";sending=true;sendButton.disabled=true;$("newChatButton").disabled=true;setStatus("waiting","Отправка…");try{const data=await storageGet([SETTINGS_KEY]),attachments=await Promise.all(files.map(fileToBase64));await runtimeMessage({type:"SEND_PROMPT",payload:{version:1,id:requestId,type:"chat",clientId:data[SETTINGS_KEY]?.clientName||"client",conversationId:chat.conversationId,chatTitle:chat.title,agentMode:chat.mode||"normal",model:chat.model||"",createdAt:new Date().toISOString(),prompt:text},attachments});updateMessage(chatId,pending.id,"Запрос доставлен. Ожидаю домашний Worker…",`ID: ${requestId}`);setStatus("waiting","Ожидание ответа");await pollResponse(requestId,chatId,pending.id);}catch(error){updateMessage(chatId,pending.id,error.message,"Ошибка",true);setStatus("offline","Ошибка");}finally{sending=false;sendButton.disabled=false;$("newChatButton").disabled=false;promptInput.focus();}}
$("newChatButton").onclick=addChat;$("modeSelect").onchange=e=>{if(sending){e.target.value=currentChat().mode||"normal";return;}currentChat().mode=e.target.value;currentChat().updatedAt=Date.now();persist();};$("modelSelect").onchange=e=>{if(sending){e.target.value=currentChat().model||"";return;}currentChat().model=e.target.value;currentChat().updatedAt=Date.now();persist();};$("openSidebarButton").onclick=()=>$("sidebar").classList.add("open");$("closeSidebarButton").onclick=()=>$("sidebar").classList.remove("open");
$("settingsButton").onclick=async()=>{await refreshAuth().catch(e=>$("settingsResult").textContent=e.message);$("settingsDialog").showModal();};
$("clearButton").onclick=async()=>{if(sending||!confirm("Очистить историю на этом устройстве, Диске и в контексте Worker?"))return;const oldConversationId=currentChat().conversationId;await runtimeMessage({type:"DELETE_CONVERSATION",conversationId:oldConversationId}).catch(error=>setStatus("offline",error.message));currentChat().messages=[];currentChat().conversationId=`chat-${crypto.randomUUID()}`;currentChat().updatedAt=Date.now();await persist();renderMessages();};
$("loginButton").onclick=async()=>{try{$("settingsResult").textContent="Открываю вход Яндекса…";await runtimeMessage({type:"LOGIN_YANDEX"});}catch(e){$("settingsResult").textContent=e.message;}};
$("logoutButton").onclick=async()=>{cloudReady=false;cloudSynced=false;await runtimeMessage({type:"LOGOUT_YANDEX"});await refreshAuth();$("settingsResult").textContent="Авторизация удалена";};
$("testButton").onclick=async e=>{e.currentTarget.disabled=true;try{const user=await runtimeMessage({type:"TEST_CONNECTION"});$("settingsResult").textContent=`Готово: ${user.displayName}. Папки AI-Bridge созданы.`;await refreshAuth();}catch(error){$("settingsResult").textContent=error.message;}finally{e.currentTarget.disabled=false;}};
$("saveSettingsButton").onclick=async()=>{await storageSet({[SETTINGS_KEY]:{clientName:$("clientNameInput").value.trim()||"client",weeklyRequestLimit:Math.max(0,Number($("weeklyLimitInput").value)||0)}});await renderUsage();$("settingsResult").textContent="Настройки сохранены";};sendButton.onclick=sendPrompt;
$("fileInput").onchange=e=>{selectedFiles.push(...e.target.files);e.target.value="";renderAttachments();};promptInput.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendPrompt();}};promptInput.oninput=()=>{promptInput.style.height="auto";promptInput.style.height=`${Math.min(promptInput.scrollHeight,170)}px`;};
(async()=>{await Promise.all([loadState(),loadSettings()]);await refreshAuth().catch(e=>setStatus("offline",e.message));setInterval(()=>refreshAuth().catch(()=>{}),3000);})();

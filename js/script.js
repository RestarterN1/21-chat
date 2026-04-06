// ---------- НОВАЯ СИСТЕМА ПОЛЬЗОВАТЕЛЕЙ И РЕАЛЬНЫХ СООБЩЕНИЙ ----------
let currentUser = null;
let messagesDB = {};
let currentChannelId = "general";
let searchQuery = "";
let unreadCounts = {};
let lastViewedTime = {};
let realtimeInterval = null;
let storageEventHandler = null; // для предотвращения дублирования

const STORAGE_USERS = "it_messenger_users";
const STORAGE_SESSION = "it_messenger_session";
const STORAGE_MESSAGES_KEY = "it_messenger_pro_messages";

const CHANNELS = [
    { id: "general", name: "general", topic: "💬 Общие дискуссии", icon: "#" },
    { id: "random", name: "random", topic: "🎲 Случайные мысли", icon: "~" },
    { id: "tech", name: "tech", topic: "⚙️ Архитектура и код", icon: "🖥️" },
    { id: "agile", name: "agile", topic: "🔄 Scrum / Канбан", icon: "📊" }
];
const TEAM_MEMBERS = ["Анна PM", "Илья Backend", "Марина Frontend", "Денис DevOps", "Ольга QA"];

// helpers
function generateId() { return Date.now() + '-' + Math.random().toString(36).substr(2, 8); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
function getInitials(name) { 
    let parts = name.trim().split(' '); 
    if(parts.length>=2) return (parts[0][0]+parts[parts.length-1][0]).toUpperCase(); 
    return name.slice(0,2).toUpperCase(); 
}

// безопасный URL
function safeUrl(url) {
    if (!url) return '#';
    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('#') || url.startsWith('?')) return url;
    try {
        const parsed = new URL(url, window.location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
        return '#';
    } catch(e) { return '#'; }
}
function escapeHtml(str) { 
    return str.replace(/[&<>]/g, m => m==='&'?'&amp;':m==='<'?'&lt;':'&gt;'); 
}

// Markdown парсер с поддержкой кириллицы в упоминаниях
function parseMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-body);padding:2px 6px;border-radius:6px;">$1</code>');
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, rawUrl) => 
        `<a href="${safeUrl(rawUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-blue);">${linkText}</a>`
    );
    // Поддержка русских букв в упоминаниях
    html = html.replace(/@([\wа-яё]+)/gi, '<span style="background:var(--accent-green);padding:0 4px;border-radius:12px;">@$1</span>');
    return html;
}

// ---------- РАБОТА С СООБЩЕНИЯМИ ----------
function persistMessages() { localStorage.setItem(STORAGE_MESSAGES_KEY, JSON.stringify(messagesDB)); }

function loadMessages() {
    try {
        let raw = localStorage.getItem(STORAGE_MESSAGES_KEY);
        if(raw) messagesDB = JSON.parse(raw);
        else initDefaultMessages();
    } catch(e) {
        console.error("Ошибка парсинга сообщений", e);
        initDefaultMessages();
    }
    for(let ch of CHANNELS) if(!messagesDB[ch.id]) messagesDB[ch.id]=[];
    for(let ch of CHANNELS) {
        if(!lastViewedTime[ch.id]) lastViewedTime[ch.id] = Date.now();
        if(unreadCounts[ch.id] === undefined) unreadCounts[ch.id] = 0;
    }
}

function initDefaultMessages() {
    let now = Date.now();
    let db = {};
    for(let ch of CHANNELS) {
        db[ch.id] = [];
        if(ch.id === "general") db[ch.id].push({ id:generateId(), author:"Система", authorAvatar:"СИ", text:"Добро пожаловать в корпоративный чат! Используйте **жирный**, *курсив*, `код`, [ссылки](https://rabota.sber.ru)", timestamp:now-3600000, edited:false, userId:"system" });
        else db[ch.id].push({ id:generateId(), author:"Бот", authorAvatar:"🤖", text:`Канал #${ch.name} готов к работе`, timestamp:now-1800000, edited:false, userId:"system" });
    }
    messagesDB = db;
    persistMessages();
}

function addMessageToChannel(channelId, msgObj) {
    if(!messagesDB[channelId]) messagesDB[channelId] = [];
    messagesDB[channelId].push(msgObj);
    persistMessages();
    // Обновление непрочитанных
    if(msgObj.userId !== currentUser?.id) {
        if(channelId === currentChannelId) {
            let lastView = lastViewedTime[channelId] || 0;
            if(msgObj.timestamp > lastView) unreadCounts[channelId] = (unreadCounts[channelId] || 0) + 1;
        } else {
            unreadCounts[channelId] = (unreadCounts[channelId] || 0) + 1;
        }
        renderSidebar();
    }
    if(currentChannelId === channelId) {
        renderMessages();
        scrollToBottom();
    }
}

function sendOwnMessage(text, imageBase64=null) {
    if(!text.trim() && !imageBase64) return;
    let newMsg = {
        id: generateId(),
        author: currentUser.name,
        authorAvatar: getInitials(currentUser.name),
        text: text.trim() || "",
        image: imageBase64,
        timestamp: Date.now(),
        edited: false,
        userId: currentUser.id
    };
    addMessageToChannel(currentChannelId, newMsg);
    document.getElementById("messageInput").value = "";
    if(unreadCounts[currentChannelId] > 0) resetUnreadCount(currentChannelId);
}

function updateMessage(channelId, msgId, newText, newImage=null) {
    let msg = messagesDB[channelId].find(m => m.id === msgId);
    if(msg && msg.userId === currentUser.id) {
        msg.text = newText; 
        if(newImage !== null) msg.image = newImage; 
        msg.edited = true; 
        msg.timestamp = Date.now(); 
        persistMessages(); 
        if(currentChannelId===channelId) renderMessages(); 
    }
}

function deleteMessage(channelId, msgId) {
    let msg = messagesDB[channelId].find(m => m.id === msgId);
    if(msg && msg.userId === currentUser.id) {
        messagesDB[channelId] = messagesDB[channelId].filter(m => m.id !== msgId);
        persistMessages(); 
        if(currentChannelId===channelId) renderMessages();
    }
}

function resetUnreadCount(channelId) {
    unreadCounts[channelId] = 0;
    lastViewedTime[channelId] = Date.now();
    renderSidebar();
}

// Обновление имени автора во всех сообщениях пользователя
function updateAuthorNameInAllMessages(newName) {
    const oldName = currentUser.name;
    const newInitials = getInitials(newName);
    for (let channelId in messagesDB) {
        messagesDB[channelId].forEach(msg => {
            if (msg.userId === currentUser.id) {
                msg.author = newName;
                msg.authorAvatar = newInitials;
            }
        });
    }
    persistMessages();
    if (currentChannelId) renderMessages();
}

// ---------- ОТРИСОВКА UI ----------
function renderMessages() {
    let messages = messagesDB[currentChannelId] || [];
    if(searchQuery.trim()) {
        let q = searchQuery.trim().toLowerCase();
        messages = messages.filter(m => m.text.toLowerCase().includes(q) || m.author.toLowerCase().includes(q));
    }
    messages.sort((a,b) => a.timestamp - b.timestamp);
    let container = document.getElementById("messagesContainer");
    if(!messages.length) { 
        container.innerHTML = `<div style="text-align:center;padding:30px;">🔍 Сообщений не найдено</div>`; 
        return; 
    }
    container.innerHTML = messages.map(msg => {
        // Безопасная вставка изображения (проверяем, что это data:image)
        let imgHtml = '';
        if (msg.image && typeof msg.image === 'string' && msg.image.startsWith('data:image/')) {
            imgHtml = `<img src="${msg.image}" class="uploaded-img" alt="image">`;
        }
        return `
            <div class="message-card" data-msg-id="${msg.id}">
                <div class="message-avatar">${escapeHtml(msg.authorAvatar || getInitials(msg.author))}</div>
                <div class="message-content">
                    <div class="message-meta"><span class="message-author">${escapeHtml(msg.author)}</span><span class="message-time">${formatTime(msg.timestamp)}${msg.edited ? ' (ред.)' : ''}</span></div>
                    <div class="message-text">${imgHtml}${parseMarkdown(msg.text)}</div>
                </div>
                <div class="message-actions">
                    ${msg.userId === currentUser.id ? `<button class="action-btn edit-msg" data-id="${msg.id}">✏️</button><button class="action-btn del-msg" data-id="${msg.id}">🗑️</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
    
    document.querySelectorAll('.edit-msg').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation(); 
        let id = btn.dataset.id; 
        let oldMsg = messagesDB[currentChannelId].find(m=>m.id===id);
        if(oldMsg && oldMsg.userId === currentUser.id) {
            let newText = prompt("Редактировать:", oldMsg.text); 
            if(newText !== null) updateMessage(currentChannelId, id, newText, oldMsg.image);
        }
    }));
    document.querySelectorAll('.del-msg').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation(); 
        if(confirm("Удалить?")) deleteMessage(currentChannelId, btn.dataset.id);
    }));
}

function scrollToBottom() { 
    let c = document.getElementById("messagesContainer"); 
    if(c) c.scrollTop = c.scrollHeight; 
}

function renderSidebar() {
    let container = document.getElementById("channelsList");
    if(!container) return;
    container.innerHTML = `<div class="channel-category">Текстовые каналы</div>` + CHANNELS.map(ch => {
        let unread = unreadCounts[ch.id] || 0;
        let badge = unread > 0 ? `<span class="unread-badge">${unread>99?'99+':unread}</span>` : '';
        return `<div class="channel-item" data-channel-id="${ch.id}"><div class="channel-left"><div class="channel-icon">${ch.icon}</div><div class="channel-name">${ch.name}</div></div>${badge}</div>`;
    }).join('');
    // Удаляем старые обработчики, чтобы не дублировать
    document.querySelectorAll('.channel-item').forEach(el => {
        el.removeEventListener('click', window._channelClickHandler);
        const handler = () => switchToChannel(el.dataset.channelId);
        el.addEventListener('click', handler);
        el._channelClickHandler = handler; // сохраняем для возможного удаления
    });
    let active = document.querySelector(`.channel-item[data-channel-id="${currentChannelId}"]`);
    if(active) active.classList.add('active');
}

function switchToChannel(channelId) {
    currentChannelId = channelId;
    resetUnreadCount(channelId);
    let ch = CHANNELS.find(c=>c.id===channelId);
    document.getElementById("currentChannelName").innerHTML = `#${ch.name}`;
    document.getElementById("channelTopic").innerText = ch.topic;
    renderMessages();
    scrollToBottom();
}

// ---------- АУТЕНТИФИКАЦИЯ ----------
function initAuthSystem() {
    let users = {};
    try {
        users = JSON.parse(localStorage.getItem(STORAGE_USERS) || '{}');
    } catch(e) { users = {}; }
    let session = localStorage.getItem(STORAGE_SESSION);
    if(session && users[session]) {
        currentUser = users[session];
        startMessengerApp();
    } else {
        showAuthModal();
    }
}

function showAuthModal() {
    let appDiv = document.getElementById("app");
    appDiv.innerHTML = `
        <div class="auth-overlay" id="authModal">
            <div class="auth-card">
                <h2>IT Connect</h2>
                <p>Войдите или создайте аккаунт</p>
                <div id="authForm">
                    <input type="text" id="authName" class="auth-input" placeholder="Ваше имя (например, Алексей)" autocomplete="off">
                    <div id="authError" class="error-msg"></div>
                    <button id="loginBtn" class="auth-btn">Войти</button>
                    <div class="switch-auth">Нет аккаунта? <span id="switchToReg">Зарегистрироваться</span></div>
                </div>
            </div>
        </div>
    `;
    let isLoginMode = true;
    const authName = document.getElementById("authName");
    const authError = document.getElementById("authError");
    const loginBtn = document.getElementById("loginBtn");
    const switchBtn = document.getElementById("switchToReg");

    function handleAuth() {
        let name = authName.value.trim();
        if(!name) { authError.innerText = "Введите имя"; return; }
        let users = {};
        try {
            users = JSON.parse(localStorage.getItem(STORAGE_USERS) || '{}');
        } catch(e) { users = {}; }
        if(isLoginMode) {
            let found = Object.values(users).find(u => u.name.toLowerCase() === name.toLowerCase());
            if(found) {
                currentUser = found;
                localStorage.setItem(STORAGE_SESSION, found.id);
                startMessengerApp();
            } else {
                authError.innerText = "Пользователь не найден. Зарегистрируйтесь.";
            }
        } else {
            if(Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase())) {
                authError.innerText = "Имя уже занято";
                return;
            }
            let newId = generateId();
            let newUser = { id: newId, name: name, avatar: getInitials(name) };
            users[newId] = newUser;
            localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
            localStorage.setItem(STORAGE_SESSION, newId);
            currentUser = newUser;
            startMessengerApp();
        }
    }
    loginBtn.onclick = handleAuth;
    switchBtn.onclick = () => {
        isLoginMode = !isLoginMode;
        loginBtn.innerText = isLoginMode ? "Войти" : "Зарегистрироваться";
        switchBtn.innerText = isLoginMode ? "Зарегистрироваться" : "Войти";
        document.querySelector(".switch-auth span").innerText = isLoginMode ? "Зарегистрироваться" : "Войти";
        authError.innerText = "";
    };
    authName.addEventListener("keypress", (e) => { if(e.key === "Enter") handleAuth(); });
}

function logout() {
    localStorage.removeItem(STORAGE_SESSION);
    if (realtimeInterval) clearInterval(realtimeInterval);
    if (storageEventHandler) {
        window.removeEventListener("storage", storageEventHandler);
        storageEventHandler = null;
    }
    currentUser = null;
    document.getElementById("app").innerHTML = "";
    showAuthModal();
}

// ---------- ЗАПУСК ОСНОВНОГО ПРИЛОЖЕНИЯ ----------
function startMessengerApp() {
    loadMessages();
    for(let ch of CHANNELS) { unreadCounts[ch.id] = 0; lastViewedTime[ch.id] = Date.now(); }
    renderMainUI();
    attachEventListeners();
    
    if(realtimeInterval) clearInterval(realtimeInterval);
    realtimeInterval = setInterval(() => {
        let randomMember = TEAM_MEMBERS[Math.floor(Math.random() * TEAM_MEMBERS.length)];
        let phrases = ["Обсудим новый релиз", "Проверьте код в ревью", "Кто возьмёт задачу?", "Документация обновлена"];
        let text = phrases[Math.floor(Math.random() * phrases.length)];
        let mockMsg = {
            id: generateId(), author: randomMember, authorAvatar: getInitials(randomMember),
            text: text, timestamp: Date.now(), edited: false, userId: "bot_"+randomMember
        };
        addMessageToChannel(currentChannelId, mockMsg);
    }, 30000);
    
    // Удаляем предыдущий обработчик storage, если был
    if (storageEventHandler) {
        window.removeEventListener("storage", storageEventHandler);
    }
    storageEventHandler = (e) => {
        if(e.key === STORAGE_MESSAGES_KEY) {
            try {
                let newData = JSON.parse(e.newValue);
                if(newData) messagesDB = newData;
                if(currentChannelId) renderMessages();
                renderSidebar();
            } catch(err) { console.warn("Ошибка синхронизации сообщений", err); }
        }
    };
    window.addEventListener("storage", storageEventHandler);
}

function renderMainUI() {
    let appDiv = document.getElementById("app");
    appDiv.innerHTML = `
        <div class="messenger">
            <aside class="channels-panel">
                <div class="server-header">
                    <h2>⚡ IT-CHAT <span>agile</span></h2>
                    <button class="logout-btn" id="logoutBtn">🚪 Выйти</button>
                </div>
                <div class="channels-list" id="channelsList"></div>
                <div class="user-mini">
                    <div class="user-mini-avatar" id="miniAvatar">${getInitials(currentUser.name)}</div>
                    <div class="user-mini-info">
                        <div class="user-mini-name" id="miniUsername">${escapeHtml(currentUser.name)}</div>
                        <button class="edit-name-btn" id="editNameMini">✎ сменить имя</button>
                    </div>
                </div>
            </aside>
            <main class="chat-area">
                <div class="chat-header">
                    <div class="channel-title"><h3 id="currentChannelName">#general</h3><span class="channel-topic" id="channelTopic"></span></div>
                    <div class="user-profile"><div class="user-avatar" id="userAvatar">${getInitials(currentUser.name)}</div><span class="user-name" id="globalUsername">${escapeHtml(currentUser.name)}</span></div>
                </div>
                <div class="search-bar"><input type="text" id="searchInput" class="search-input" placeholder="🔍 Поиск по сообщениям..."></div>
                <div class="messages-container" id="messagesContainer"></div>
                <div class="input-area">
                    <div class="message-input-wrapper">
                        <input type="text" id="messageInput" placeholder="Напишите сообщение... (Markdown, @упоминания)" autocomplete="off">
                        <select id="emojiSelect" class="emoji-select">
                            <option value="">😊 Смайлик</option>
                            <option value="😀">😀</option><option value="😂">😂</option>
                            <option value="👍">👍</option><option value="❤️">❤️</option><option value="🚀">🚀</option>
                            <option value="🔥">🔥</option><option value="✨">✨</option><option value="🎉">🎉</option>
                        </select>
                        <label class="file-label" for="imageUpload">📷 Изображение</label>
                        <input type="file" id="imageUpload" accept="image/*" style="display:none">
                        <button class="send-btn" id="sendMessageBtn">➤ Отправить</button>
                    </div>
                </div>
            </main>
        </div>
    `;
    renderSidebar();
    switchToChannel("general");
    document.getElementById("logoutBtn").addEventListener("click", logout);
    document.getElementById("editNameMini").addEventListener("click", () => {
        let newName = prompt("Новое имя:", currentUser.name);
        if(newName && newName.trim() && newName.trim() !== currentUser.name) {
            let newNameTrim = newName.trim();
            let users = {};
            try {
                users = JSON.parse(localStorage.getItem(STORAGE_USERS) || '{}');
            } catch(e) { users = {}; }
            if(users[currentUser.id]) {
                // Проверяем, не занято ли имя другим пользователем
                let nameTaken = Object.values(users).some(u => u.id !== currentUser.id && u.name.toLowerCase() === newNameTrim.toLowerCase());
                if(nameTaken) {
                    alert("Это имя уже занято другим пользователем.");
                    return;
                }
                users[currentUser.id].name = newNameTrim;
                localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
                // Обновляем имя в сообщениях
                updateAuthorNameInAllMessages(newNameTrim);
                currentUser.name = newNameTrim;
                localStorage.setItem(STORAGE_SESSION, currentUser.id);
                document.getElementById("miniUsername").innerText = currentUser.name;
                document.getElementById("globalUsername").innerText = currentUser.name;
                let init = getInitials(currentUser.name);
                document.getElementById("userAvatar").innerText = init;
                document.getElementById("miniAvatar").innerText = init;
            }
        }
    });
}

function attachEventListeners() {
    const sendBtn = document.getElementById("sendMessageBtn");
    const msgInput = document.getElementById("messageInput");
    const imageUpload = document.getElementById("imageUpload");
    const searchInput = document.getElementById("searchInput");
    const emojiSelect = document.getElementById("emojiSelect");

    if (sendBtn) sendBtn.addEventListener("click", () => { let val = msgInput.value; if(val.trim()) sendOwnMessage(val); });
    if (msgInput) msgInput.addEventListener("keypress", (e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); let val = msgInput.value; if(val.trim()) sendOwnMessage(val); } });
    if (imageUpload) imageUpload.addEventListener("change", function(e) {
        let file = e.target.files[0];
        if(file && file.type.startsWith('image/')) {
            let reader = new FileReader();
            reader.onload = (ev) => sendOwnMessage("", ev.target.result);
            reader.readAsDataURL(file);
        }
        this.value = '';
    });
    if (searchInput) searchInput.addEventListener("input", (e) => { searchQuery = e.target.value; renderMessages(); });
    if (emojiSelect) {
        emojiSelect.addEventListener("change", () => {
            if(emojiSelect.value) {
                msgInput.value += emojiSelect.value;
                msgInput.focus();
                emojiSelect.value = ""; // сбрасываем на пустой, чтобы можно было выбрать тот же смайлик снова
            }
        });
    }
}

// запуск
initAuthSystem();
// ---------- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ----------
let currentUser = null;
let currentChannelId = "general";
let socket = null;
let messagesCache = {};     // { channelId: [messages] }
let unreadCounts = { general:0, random:0, tech:0, agile:0 };
let lastViewedTime = { general: Date.now(), random: Date.now(), tech: Date.now(), agile: Date.now() };

const API_BASE = 'http://localhost:5500/api';
const CHANNELS = [
    { id: "general", name: "general", topic: "💬 Общие дискуссии", icon: "#" },
    { id: "random", name: "random", topic: "🎲 Случайные мысли", icon: "~" },
    { id: "tech", name: "tech", topic: "⚙️ Архитектура и код", icon: "🖥️" },
    { id: "agile", name: "agile", topic: "🔄 Scrum / Канбан", icon: "📊" }
];

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------
function getInitials(name) {
    let parts = name.trim().split(' ');
    if(parts.length>=2) return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
    return name.slice(0,2).toUpperCase();
}

function escapeHtml(str) {
    return str.replace(/[&<>]/g, m => m==='&'?'&amp;':m==='<'?'&lt;':'&gt;');
}

function safeUrl(url) {
    if (!url || url.startsWith('data:')) return url;
    try { new URL(url); return url; } catch(e) { return '#'; }
}

function parseMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-body);padding:2px 6px;border-radius:6px;">$1</code>');
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, rawUrl) => `<a href="${safeUrl(rawUrl)}" target="_blank" style="color:var(--accent-blue);">${linkText}</a>`);
    html = html.replace(/@([\wа-яё]+)/gi, '<span style="background:var(--accent-green);padding:0 4px;border-radius:12px;">@$1</span>');
    return html;
}

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

// ---------- АВТОРИЗАЦИЯ (через бэкенд) ----------
async function register(email, username, password) {
    const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, username, password })
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Ошибка регистрации');
    }
    return res.json();
}

async function login(email, password) {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Ошибка входа');
    }
    return res.json();
}

function saveSession(token, user) {
    localStorage.setItem('it_token', token);
    localStorage.setItem('it_user', JSON.stringify(user));
    currentUser = user;
}

function clearSession() {
    localStorage.removeItem('it_token');
    localStorage.removeItem('it_user');
    currentUser = null;
    if (socket) socket.disconnect();
}

function getStoredSession() {
    const token = localStorage.getItem('it_token');
    const user = JSON.parse(localStorage.getItem('it_user') || 'null');
    if (token && user) return { token, user };
    return null;
}

// ---------- РАБОТА С СООБЩЕНИЯМИ (HTTP + SOCKET) ----------
async function fetchMessages(channelId) {
    const token = localStorage.getItem('it_token');
    const res = await fetch(`${API_BASE}/messages/${channelId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Не удалось загрузить сообщения');
    const msgs = await res.json();
    messagesCache[channelId] = msgs;
    return msgs;
}

async function sendMessageViaHttp(channelId, text, imageBase64) {
    const token = localStorage.getItem('it_token');
    const res = await fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ channelId, text, image: imageBase64 })
    });
    if (!res.ok) throw new Error('Не удалось отправить');
    const msg = await res.json();
    // Сокет уже разошлёт всем, но добавим в кэш локально
    if (!messagesCache[channelId]) messagesCache[channelId] = [];
    messagesCache[channelId].push(msg);
    if (channelId === currentChannelId) renderMessages();
    return msg;
}

// Socket.IO инициализация
function initSocket() {
    const token = localStorage.getItem('it_token');
    socket = io('http://localhost:5000', {
        auth: { token }
    });

    socket.on('connect', () => {
        console.log('Socket connected');
        socket.emit('join_channel', currentChannelId);
    });

    socket.on('new_message', (msg) => {
        const channel = msg.channelId;
        if (!messagesCache[channel]) messagesCache[channel] = [];
        messagesCache[channel].push(msg);
        if (channel === currentChannelId) {
            renderMessages();
            scrollToBottom();
        } else {
            // увеличиваем счётчик непрочитанных
            if (msg.authorId !== currentUser?.id) {
                unreadCounts[channel] = (unreadCounts[channel] || 0) + 1;
                renderSidebar();
            }
        }
    });

    socket.on('message_updated', (updatedMsg) => {
        const channel = updatedMsg.channelId;
        if (messagesCache[channel]) {
            const idx = messagesCache[channel].findIndex(m => m._id === updatedMsg._id);
            if (idx !== -1) messagesCache[channel][idx] = updatedMsg;
            if (channel === currentChannelId) renderMessages();
        }
    });

    socket.on('message_deleted', (msgId) => {
        for (let ch in messagesCache) {
            const idx = messagesCache[ch].findIndex(m => m._id === msgId);
            if (idx !== -1) {
                messagesCache[ch].splice(idx, 1);
                if (ch === currentChannelId) renderMessages();
                break;
            }
        }
    });

    socket.on('user_status', ({ userId, online }) => {
        // можно отображать статус в UI (опционально)
    });
}

// ---------- ОТРИСОВКА UI ----------
function renderMessages() {
    let messages = messagesCache[currentChannelId] || [];
    messages.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
    const container = document.getElementById("messagesContainer");
    if (!messages.length) {
        container.innerHTML = `<div style="text-align:center;padding:30px;">💬 Сообщений пока нет</div>`;
        return;
    }
    container.innerHTML = messages.map(msg => {
        let imgHtml = '';
        if (msg.image && msg.image.startsWith('data:image/')) {
            imgHtml = `<img src="${msg.image}" class="uploaded-img" alt="image">`;
        }
        return `
            <div class="message-card" data-msg-id="${msg._id}">
                <div class="message-avatar">${escapeHtml(msg.authorAvatar || getInitials(msg.authorName))}</div>
                <div class="message-content">
                    <div class="message-meta">
                        <span class="message-author">${escapeHtml(msg.authorName)}</span>
                        <span class="message-time">${formatTime(msg.timestamp)}${msg.edited ? ' (ред.)' : ''}</span>
                    </div>
                    <div class="message-text">${imgHtml}${parseMarkdown(msg.text)}</div>
                </div>
                <div class="message-actions">
                    ${msg.authorId === currentUser?.id ? `<button class="action-btn edit-msg" data-id="${msg._id}">✏️</button><button class="action-btn del-msg" data-id="${msg._id}">🗑️</button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    // Обработчики редактирования/удаления
    document.querySelectorAll('.edit-msg').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const oldMsg = messagesCache[currentChannelId].find(m => m._id === id);
            if (oldMsg && oldMsg.authorId === currentUser.id) {
                const newText = prompt("Редактировать:", oldMsg.text);
                if (newText !== null) {
                    socket.emit('edit_message', { messageId: id, text: newText, image: oldMsg.image });
                }
            }
        };
    });
    document.querySelectorAll('.del-msg').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (confirm("Удалить?")) socket.emit('delete_message', { messageId: btn.dataset.id });
        };
    });
}

function renderSidebar() {
    const container = document.getElementById("channelsList");
    if (!container) return;
    container.innerHTML = `<div class="channel-category">Текстовые каналы</div>` +
        CHANNELS.map(ch => {
            const unread = unreadCounts[ch.id] || 0;
            const badge = unread > 0 ? `<span class="unread-badge">${unread>99?'99+':unread}</span>` : '';
            return `<div class="channel-item" data-channel-id="${ch.id}">
                        <div class="channel-left">
                            <div class="channel-icon">${ch.icon}</div>
                            <div class="channel-name">${ch.name}</div>
                        </div>${badge}
                    </div>`;
        }).join('');
    document.querySelectorAll('.channel-item').forEach(el => {
        el.addEventListener('click', () => switchToChannel(el.dataset.channelId));
    });
    const active = document.querySelector(`.channel-item[data-channel-id="${currentChannelId}"]`);
    if (active) active.classList.add('active');
}

function switchToChannel(channelId) {
    currentChannelId = channelId;
    unreadCounts[channelId] = 0;
    lastViewedTime[channelId] = Date.now();
    renderSidebar();
    const ch = CHANNELS.find(c => c.id === channelId);
    document.getElementById("currentChannelName").innerHTML = `#${ch.name}`;
    document.getElementById("channelTopic").innerText = ch.topic;
    // загружаем сообщения из кэша или с сервера
    if (messagesCache[channelId]) {
        renderMessages();
    } else {
        fetchMessages(channelId).then(() => renderMessages());
    }
    if (socket) socket.emit('join_channel', channelId);
    scrollToBottom();
}

function scrollToBottom() {
    const c = document.getElementById("messagesContainer");
    if (c) c.scrollTop = c.scrollHeight;
}

// Отправка сообщения
async function sendOwnMessage(text, imageBase64 = null) {
    if (!text.trim() && !imageBase64) return;
    await sendMessageViaHttp(currentChannelId, text, imageBase64);
    document.getElementById("messageInput").value = "";
    if (unreadCounts[currentChannelId] > 0) unreadCounts[currentChannelId] = 0;
}

// ---------- UI АВТОРИЗАЦИИ (модальное окно) ----------
function showAuthModal() {
    const appDiv = document.getElementById("app");
    appDiv.innerHTML = `
        <div class="auth-overlay" id="authModal">
            <div class="auth-card">
                <h2>IT Connect</h2>
                <p>Вход / Регистрация</p>
                <div id="authForm">
                    <input type="email" id="authEmail" class="auth-input" placeholder="Email" autocomplete="off">
                    <input type="text" id="authUsername" class="auth-input" placeholder="Имя пользователя" autocomplete="off" style="display:none">
                    <input type="password" id="authPassword" class="auth-input" placeholder="Пароль">
                    <div id="authError" class="error-msg"></div>
                    <button id="loginBtn" class="auth-btn">Войти</button>
                    <div class="switch-auth">Нет аккаунта? <span id="switchToReg">Зарегистрироваться</span></div>
                </div>
            </div>
        </div>
    `;

    let isLogin = true;
    const emailInput = document.getElementById("authEmail");
    const usernameInput = document.getElementById("authUsername");
    const passwordInput = document.getElementById("authPassword");
    const errorDiv = document.getElementById("authError");
    const loginBtn = document.getElementById("loginBtn");
    const switchSpan = document.getElementById("switchToReg");

    const toggleMode = () => {
        isLogin = !isLogin;
        loginBtn.innerText = isLogin ? "Войти" : "Зарегистрироваться";
        switchSpan.innerText = isLogin ? "Зарегистрироваться" : "Войти";
        usernameInput.style.display = isLogin ? "none" : "block";
        errorDiv.innerText = "";
    };
    switchSpan.onclick = toggleMode;

    const handleSubmit = async () => {
        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();
        if (!email || !password) {
            errorDiv.innerText = "Заполните email и пароль";
            return;
        }
        try {
            let result;
            if (isLogin) {
                result = await login(email, password);
            } else {
                const username = usernameInput.value.trim();
                if (!username) {
                    errorDiv.innerText = "Введите имя пользователя";
                    return;
                }
                result = await register(email, username, password);
            }
            saveSession(result.token, result.user);
            startMessengerApp();
        } catch (err) {
            errorDiv.innerText = err.message;
        }
    };
    loginBtn.onclick = handleSubmit;
    passwordInput.addEventListener("keypress", (e) => { if(e.key === "Enter") handleSubmit(); });
}

// ---------- ЗАПУСК МЕССЕНДЖЕРА ПОСЛЕ ВХОДА ----------
async function startMessengerApp() {
    await fetchMessages(currentChannelId);
    initSocket();
    renderMainUI();
}

function renderMainUI() {
    const appDiv = document.getElementById("app");
    appDiv.innerHTML = `
        <div class="messenger">
            <aside class="channels-panel">
                <div class="server-header">
                    <h2>⚡ IT-CHAT</h2>
                    <button class="logout-btn" id="logoutBtn">🚪 Выйти</button>
                </div>
                <div class="channels-list" id="channelsList"></div>
                <div class="user-mini">
                    <div class="user-mini-avatar" id="miniAvatar">${getInitials(currentUser.username)}</div>
                    <div class="user-mini-info">
                        <div class="user-mini-name">${escapeHtml(currentUser.username)}</div>
                        <button class="edit-name-btn" id="editNameMini">✎ сменить имя</button>
                    </div>
                </div>
            </aside>
            <main class="chat-area">
                <div class="chat-header">
                    <div class="channel-title"><h3 id="currentChannelName">#general</h3><span class="channel-topic" id="channelTopic"></span></div>
                    <div class="user-profile"><div class="user-avatar">${getInitials(currentUser.username)}</div><span class="user-name">${escapeHtml(currentUser.username)}</span></div>
                </div>
                <div class="search-bar"><input type="text" id="searchInput" class="search-input" placeholder="🔍 Поиск по сообщениям..."></div>
                <div class="messages-container" id="messagesContainer"></div>
                <div class="input-area">
                    <div class="message-input-wrapper">
                        <input type="text" id="messageInput" placeholder="Напишите сообщение... (Markdown, @упоминания)">
                        <select id="emojiSelect" class="emoji-select">
                            <option value="">😊 Смайлик</option>
                            <option value="😀">😀</option><option value="😂">😂</option>
                            <option value="👍">👍</option><option value="❤️">❤️</option>
                            <option value="🚀">🚀</option><option value="🔥">🔥</option>
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

    // Обработчики событий
    document.getElementById("logoutBtn").addEventListener("click", () => {
        clearSession();
        showAuthModal();
    });
    document.getElementById("editNameMini").addEventListener("click", async () => {
        alert("Смена имени временно недоступна через бэкенд (можно реализовать отдельно)");
    });
    const sendBtn = document.getElementById("sendMessageBtn");
    const msgInput = document.getElementById("messageInput");
    const imageUpload = document.getElementById("imageUpload");
    const searchInput = document.getElementById("searchInput");
    const emojiSelect = document.getElementById("emojiSelect");

    sendBtn.onclick = () => { if (msgInput.value.trim()) sendOwnMessage(msgInput.value); };
    msgInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (msgInput.value.trim()) sendOwnMessage(msgInput.value);
        }
    });
    imageUpload.onchange = (e) => {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (ev) => sendOwnMessage("", ev.target.result);
            reader.readAsDataURL(file);
        }
        imageUpload.value = '';
    };
    searchInput.oninput = (e) => {
        const q = e.target.value.toLowerCase();
        if (!q) renderMessages();
        else {
            const filtered = messagesCache[currentChannelId].filter(m => m.text.toLowerCase().includes(q) || m.authorName.toLowerCase().includes(q));
            const container = document.getElementById("messagesContainer");
            container.innerHTML = filtered.map(msg => `...`).join(''); // упрощённо, можно переиспользовать renderMessages
            // для простоты оставим как есть – можно дописать
        }
    };
    emojiSelect.onchange = () => {
        if (emojiSelect.value) {
            msgInput.value += emojiSelect.value;
            msgInput.focus();
            emojiSelect.value = "";
        }
    };
}

// ---------- СТАРТ ----------
const session = getStoredSession();
if (session) {
    currentUser = session.user;
    startMessengerApp();
} else {
    showAuthModal();
}
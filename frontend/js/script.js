// ---------- ИНИЦИАЛИЗАЦИЯ FIREBASE ----------
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, updateProfile } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, updateDoc, deleteDoc, doc, where, getDocs } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// TODO: замените на свои данные из консоли Firebase
const firebaseConfig = {
  apiKey: "AIzaSyDlzdPcaQPDfUZ9wMFFzq29fkAETUgb23g",
  authDomain: "chat-beedc.firebaseapp.com",
  projectId: "chat-beedc",
  storageBucket: "chat-beedc.firebasestorage.app",
  messagingSenderId: "1052354530399",
  appId: "1:1052354530399:web:8edcc5d26487437bfbdfea"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ----------
let currentUser = null;
let currentChannelId = "general";
let unreadCounts = { general:0, random:0, tech:0, agile:0 };
let lastViewedTime = { general: Date.now(), random: Date.now(), tech: Date.now(), agile: Date.now() };

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

// ---------- РАБОТА С FIRESTORE (сообщения) ----------
// Подписка на сообщения канала в реальном времени
let unsubscribeMessages = null;

function subscribeToChannel(channelId) {
    if (unsubscribeMessages) unsubscribeMessages();
    const q = query(collection(db, "messages"), where("channelId", "==", channelId), orderBy("timestamp", "asc"));
    unsubscribeMessages = onSnapshot(q, (snapshot) => {
        const messages = [];
        snapshot.forEach(doc => {
            messages.push({ id: doc.id, ...doc.data() });
        });
        // Обновляем кэш и рендерим
        window.messagesCache = messages;
        if (currentChannelId === channelId) renderMessages();
        updateUnreadCounts(messages);
    });
}

function updateUnreadCounts(messages) {
    if (!currentUser) return;
    const lastView = lastViewedTime[currentChannelId] || 0;
    const newUnread = messages.filter(m => m.authorId !== currentUser.uid && m.timestamp?.toDate?.()?.getTime() > lastView).length;
    if (currentChannelId === currentChannelId) unreadCounts[currentChannelId] = newUnread;
    renderSidebar();
}

async function sendMessage(text, imageBase64 = null) {
    if (!text.trim() && !imageBase64) return;
    await addDoc(collection(db, "messages"), {
        channelId: currentChannelId,
        authorId: currentUser.uid,
        authorName: currentUser.displayName || currentUser.email.split('@')[0],
        authorAvatar: getInitials(currentUser.displayName || currentUser.email),
        text: text.trim(),
        image: imageBase64,
        timestamp: new Date(),
        edited: false
    });
    document.getElementById("messageInput").value = "";
}

async function editMessage(msgId, newText, newImage) {
    await updateDoc(doc(db, "messages", msgId), {
        text: newText,
        image: newImage,
        edited: true,
        editedAt: new Date()
    });
}

async function deleteMessage(msgId) {
    await deleteDoc(doc(db, "messages", msgId));
}

// ---------- АУТЕНТИФИКАЦИЯ ----------
function showAuthModal() {
    const appDiv = document.getElementById("app");
    appDiv.innerHTML = `
        <div class="auth-overlay" id="authModal">
            <div class="auth-card">
                <h2>IT Connect</h2>
                <p>Вход / Регистрация</p>
                <div id="authForm">
                    <input type="email" id="authEmail" class="auth-input" placeholder="Email">
                    <input type="text" id="authUsername" class="auth-input" placeholder="Имя пользователя" style="display:none">
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
            if (isLogin) {
                await signInWithEmailAndPassword(auth, email, password);
            } else {
                const username = usernameInput.value.trim();
                if (!username) {
                    errorDiv.innerText = "Введите имя пользователя";
                    return;
                }
                const userCred = await createUserWithEmailAndPassword(auth, email, password);
                await updateProfile(userCred.user, { displayName: username });
            }
        } catch (err) {
            errorDiv.innerText = err.message;
        }
    };
    loginBtn.onclick = handleSubmit;
    passwordInput.addEventListener("keypress", (e) => { if(e.key === "Enter") handleSubmit(); });
}

// ---------- ОСНОВНОЙ ИНТЕРФЕЙС ----------
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
                    <div class="user-mini-avatar" id="miniAvatar">${getInitials(currentUser.displayName || currentUser.email)}</div>
                    <div class="user-mini-info">
                        <div class="user-mini-name">${escapeHtml(currentUser.displayName || currentUser.email)}</div>
                        <button class="edit-name-btn" id="editNameMini">✎ сменить имя</button>
                    </div>
                </div>
            </aside>
            <main class="chat-area">
                <div class="chat-header">
                    <div class="channel-title"><h3 id="currentChannelName">#general</h3><span class="channel-topic" id="channelTopic"></span></div>
                    <div class="user-profile"><div class="user-avatar">${getInitials(currentUser.displayName || currentUser.email)}</div><span class="user-name">${escapeHtml(currentUser.displayName || currentUser.email)}</span></div>
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
                            <option value="🚀">🚀</option>
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

    document.getElementById("logoutBtn").addEventListener("click", () => {
        auth.signOut();
        window.location.reload();
    });

    document.getElementById("editNameMini").addEventListener("click", async () => {
        const newName = prompt("Новое имя:", currentUser.displayName);
        if (newName && newName.trim()) {
            await updateProfile(currentUser, { displayName: newName.trim() });
            // Обновляем все сообщения пользователя (Firestore update)
            const q = query(collection(db, "messages"), where("authorId", "==", currentUser.uid));
            const snapshot = await getDocs(q);
            snapshot.forEach(async (docSnap) => {
                await updateDoc(doc(db, "messages", docSnap.id), {
                    authorName: newName.trim(),
                    authorAvatar: getInitials(newName.trim())
                });
            });
            currentUser = auth.currentUser;
            document.getElementById("miniAvatar").innerText = getInitials(currentUser.displayName);
            document.getElementById("miniUsername").innerText = currentUser.displayName;
            document.querySelector(".user-name").innerText = currentUser.displayName;
            document.getElementById("userAvatar").innerText = getInitials(currentUser.displayName);
        }
    });

    const sendBtn = document.getElementById("sendMessageBtn");
    const msgInput = document.getElementById("messageInput");
    const imageUpload = document.getElementById("imageUpload");
    const searchInput = document.getElementById("searchInput");
    const emojiSelect = document.getElementById("emojiSelect");

    sendBtn.onclick = () => { if (msgInput.value.trim()) sendMessage(msgInput.value); };
    msgInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (msgInput.value.trim()) sendMessage(msgInput.value);
        }
    });
    imageUpload.onchange = (e) => {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (ev) => sendMessage("", ev.target.result);
            reader.readAsDataURL(file);
        }
        imageUpload.value = '';
    };
    searchInput.oninput = (e) => {
        const q = e.target.value.toLowerCase();
        if (!q) renderMessages();
        else {
            const filtered = (window.messagesCache || []).filter(m => m.text.toLowerCase().includes(q) || m.authorName.toLowerCase().includes(q));
            const container = document.getElementById("messagesContainer");
            if (filtered.length === 0) container.innerHTML = '<div style="text-align:center;padding:30px;">🔍 Ничего не найдено</div>';
            else container.innerHTML = filtered.map(msg => renderMessageHtml(msg)).join('');
            attachMessageActions();
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

function renderMessageHtml(msg) {
    let imgHtml = '';
    if (msg.image && msg.image.startsWith('data:image/')) {
        imgHtml = `<img src="${msg.image}" class="uploaded-img" alt="image">`;
    }
    return `
        <div class="message-card" data-msg-id="${msg.id}">
            <div class="message-avatar">${escapeHtml(msg.authorAvatar || getInitials(msg.authorName))}</div>
            <div class="message-content">
                <div class="message-meta">
                    <span class="message-author">${escapeHtml(msg.authorName)}</span>
                    <span class="message-time">${formatTime(msg.timestamp?.toDate?.()?.getTime() || Date.now())}${msg.edited ? ' (ред.)' : ''}</span>
                </div>
                <div class="message-text">${imgHtml}${parseMarkdown(msg.text)}</div>
            </div>
            <div class="message-actions">
                ${msg.authorId === currentUser?.uid ? `<button class="action-btn edit-msg" data-id="${msg.id}">✏️</button><button class="action-btn del-msg" data-id="${msg.id}">🗑️</button>` : ''}
            </div>
        </div>
    `;
}

function renderMessages() {
    const messages = window.messagesCache || [];
    messages.sort((a,b) => (a.timestamp?.toDate?.()?.getTime() || 0) - (b.timestamp?.toDate?.()?.getTime() || 0));
    const container = document.getElementById("messagesContainer");
    if (!messages.length) {
        container.innerHTML = `<div style="text-align:center;padding:30px;">💬 Сообщений пока нет</div>`;
        return;
    }
    container.innerHTML = messages.map(renderMessageHtml).join('');
    attachMessageActions();
    scrollToBottom();
}

function attachMessageActions() {
    document.querySelectorAll('.edit-msg').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const oldMsg = (window.messagesCache || []).find(m => m.id === id);
            if (oldMsg && oldMsg.authorId === currentUser.uid) {
                const newText = prompt("Редактировать:", oldMsg.text);
                if (newText !== null) editMessage(id, newText, oldMsg.image);
            }
        };
    });
    document.querySelectorAll('.del-msg').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (confirm("Удалить?")) deleteMessage(btn.dataset.id);
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
    subscribeToChannel(channelId);
    scrollToBottom();
}

function scrollToBottom() {
    const c = document.getElementById("messagesContainer");
    if (c) c.scrollTop = c.scrollHeight;
}

// ---------- СТАРТ ПРИЛОЖЕНИЯ ----------
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        renderMainUI();
    } else {
        currentUser = null;
        showAuthModal();
    }
});

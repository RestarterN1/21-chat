// ---------- FIREBASE ИНИЦИАЛИЗАЦИЯ ----------
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, updateProfile } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, updateDoc, deleteDoc, doc, where, getDocs, setDoc, arrayUnion, arrayRemove, Timestamp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

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

// ---------- ПЕРЕМЕННЫЕ ----------
let currentUser = null;
let currentChannelId = "general";
let unreadCounts = { general:0, random:0, tech:0, agile:0 };
let lastViewedTime = { general: Date.now(), random: Date.now(), tech: Date.now(), agile: Date.now() };
let onlineUsers = new Map(); // uid -> displayName, avatar
let unsubscribeMessages = null;
let unsubscribeOnline = null;
let currentMessagesCache = [];

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
    if (!str) return '';
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
    html = html.replace(/`(.*?)`/g, '<code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:6px;">$1</code>');
    html = html.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, rawUrl) => `<a href="${safeUrl(rawUrl)}" target="_blank" style="color:var(--accent-blue);">${linkText}</a>`);
    html = html.replace(/@([\wа-яё]+)/gi, '<span style="background:var(--accent-green);padding:0 4px;border-radius:12px;">@$1</span>');
    return html;
}

function formatTime(ts) {
    if (!ts) return '';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

// ---------- ОНЛАЙН СТАТУС ----------
async function setUserOnline(user) {
    if (!user) return;
    const userRef = doc(db, "users", user.uid);
    await setDoc(userRef, {
        displayName: user.displayName || user.email.split('@')[0],
        avatar: getInitials(user.displayName || user.email),
        lastSeen: Timestamp.now(),
        online: true
    }, { merge: true });
    // Обновляем каждые 30 секунд
    const interval = setInterval(() => {
        if (currentUser) {
            updateDoc(userRef, { lastSeen: Timestamp.now() });
        } else {
            clearInterval(interval);
        }
    }, 30000);
}

function listenOnlineUsers() {
    if (unsubscribeOnline) unsubscribeOnline();
    const q = query(collection(db, "users"), orderBy("displayName"));
    unsubscribeOnline = onSnapshot(q, (snapshot) => {
        onlineUsers.clear();
        snapshot.forEach(docSnap => {
            const data = docSnap.data();
            const isOnline = data.online && (Date.now() - data.lastSeen?.toDate?.()?.getTime() < 60000);
            onlineUsers.set(docSnap.id, { ...data, online: isOnline });
        });
        renderOnlineList();
    });
}

function renderOnlineList() {
    const container = document.getElementById("onlineList");
    if (!container) return;
    const onlineList = Array.from(onlineUsers.values()).filter(u => u.online);
    container.innerHTML = onlineList.map(u => `
        <div class="online-user">
            <div class="online-avatar">${escapeHtml(u.avatar || getInitials(u.displayName))}</div>
            <span>${escapeHtml(u.displayName)}</span>
            <span class="online-status"></span>
        </div>
    `).join('');
    if (onlineList.length === 0) container.innerHTML = '<div style="padding:8px; font-size:0.8rem;">Нет активных</div>';
}

// ---------- РЕАКЦИИ ----------
async function toggleReaction(messageId, emoji) {
    const reactionRef = doc(db, "reactions", `${messageId}_${currentUser.uid}_${emoji}`);
    const reactionDoc = await getDocs(query(collection(db, "reactions"), where("messageId", "==", messageId), where("userId", "==", currentUser.uid), where("emoji", "==", emoji)));
    if (!reactionDoc.empty) {
        await deleteDoc(reactionDoc.docs[0].ref);
    } else {
        await setDoc(doc(db, "reactions", `${messageId}_${currentUser.uid}_${emoji}`), {
            messageId,
            userId: currentUser.uid,
            emoji,
            timestamp: Timestamp.now()
        });
    }
}

async function getReactionsForMessage(messageId) {
    const q = query(collection(db, "reactions"), where("messageId", "==", messageId));
    const snap = await getDocs(q);
    const counts = new Map();
    snap.forEach(doc => {
        const emoji = doc.data().emoji;
        counts.set(emoji, (counts.get(emoji) || 0) + 1);
    });
    return counts;
}

// ---------- СООБЩЕНИЯ ----------
function subscribeToChannel(channelId) {
    if (unsubscribeMessages) unsubscribeMessages();
    const q = query(collection(db, "messages"), where("channelId", "==", channelId), orderBy("timestamp", "asc"));
    unsubscribeMessages = onSnapshot(q, async (snapshot) => {
        const messages = [];
        for (const docSnap of snapshot.docs) {
            const msg = { id: docSnap.id, ...docSnap.data() };
            // подгружаем реакции
            msg.reactions = await getReactionsForMessage(msg.id);
            messages.push(msg);
        }
        currentMessagesCache = messages;
        if (currentChannelId === channelId) renderMessages();
        updateUnreadCounts(messages);
    });
}

function updateUnreadCounts(messages) {
    if (!currentUser) return;
    const lastView = lastViewedTime[currentChannelId] || 0;
    const newUnread = messages.filter(m => m.authorId !== currentUser.uid && m.timestamp?.toDate?.()?.getTime() > lastView).length;
    unreadCounts[currentChannelId] = newUnread;
    renderSidebar();
}

async function sendMessage(text, imageBase64 = null) {
    if (!text.trim() && !imageBase64) return;
    if (!currentUser) { console.error("Не авторизован"); return; }
    try {
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
    } catch (err) {
        console.error("Ошибка отправки:", err);
        alert("Не удалось отправить: " + err.message);
    }
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
                <h2>⚡ IT Connect</h2>
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
                // Сохраняем в коллекцию users
                await setDoc(doc(db, "users", userCred.user.uid), {
                    displayName: username,
                    avatar: getInitials(username),
                    lastSeen: Timestamp.now(),
                    online: true
                });
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
                <div class="online-users-section">
                    <div class="online-header">🟢 В сети · <span id="onlineCount">0</span></div>
                    <div class="online-list" id="onlineList"></div>
                </div>
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
                    <div class="user-profile" id="userProfileBtn">
                        <div class="user-avatar">${getInitials(currentUser.displayName || currentUser.email)}</div>
                        <span class="user-name">${escapeHtml(currentUser.displayName || currentUser.email)}</span>
                    </div>
                </div>
                <div class="search-bar"><input type="text" id="searchInput" class="search-input" placeholder="🔍 Поиск по сообщениям..."></div>
                <div class="messages-container" id="messagesContainer"></div>
                <div class="input-area">
                    <div class="message-input-wrapper">
                        <input type="text" id="messageInput" placeholder="Напишите сообщение... (Markdown, @упоминания)">
                        <button class="emoji-picker-btn" id="emojiPickerBtn">😊</button>
                        <label class="file-label" for="imageUpload">📷</label>
                        <input type="file" id="imageUpload" accept="image/*" style="display:none">
                        <button class="send-btn" id="sendMessageBtn">➤</button>
                    </div>
                </div>
            </main>
        </div>
    `;

    renderSidebar();
    switchToChannel("general");
    listenOnlineUsers();
    setUserOnline(currentUser);

    // Логаут
    document.getElementById("logoutBtn").addEventListener("click", () => {
        auth.signOut();
        window.location.reload();
    });

    // Редактирование имени
    document.getElementById("editNameMini").addEventListener("click", async () => {
        const newName = prompt("Новое имя:", currentUser.displayName);
        if (newName && newName.trim()) {
            await updateProfile(currentUser, { displayName: newName.trim() });
            // Обновляем все сообщения пользователя
            const q = query(collection(db, "messages"), where("authorId", "==", currentUser.uid));
            const snapshot = await getDocs(q);
            snapshot.forEach(async (docSnap) => {
                await updateDoc(doc(db, "messages", docSnap.id), {
                    authorName: newName.trim(),
                    authorAvatar: getInitials(newName.trim())
                });
            });
            // Обновляем в users
            await setDoc(doc(db, "users", currentUser.uid), { displayName: newName.trim(), avatar: getInitials(newName.trim()) }, { merge: true });
            currentUser = auth.currentUser;
            document.getElementById("miniAvatar").innerText = getInitials(currentUser.displayName);
            document.querySelector(".user-mini-name").innerText = currentUser.displayName;
            document.querySelector(".user-name").innerText = currentUser.displayName;
            document.querySelector(".user-avatar").innerText = getInitials(currentUser.displayName);
        }
    });

    // Отправка сообщений
    const sendBtn = document.getElementById("sendMessageBtn");
    const msgInput = document.getElementById("messageInput");
    const imageUpload = document.getElementById("imageUpload");
    const searchInput = document.getElementById("searchInput");
    const emojiPickerBtn = document.getElementById("emojiPickerBtn");

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
            const filtered = currentMessagesCache.filter(m => m.text.toLowerCase().includes(q) || m.authorName.toLowerCase().includes(q));
            const container = document.getElementById("messagesContainer");
            if (filtered.length === 0) container.innerHTML = '<div style="text-align:center;padding:30px;">🔍 Ничего не найдено</div>';
            else container.innerHTML = filtered.map(msg => renderMessageHtml(msg)).join('');
            attachMessageActions();
        }
    };

    // Простой эмодзи-пикер
    emojiPickerBtn.onclick = () => {
        const emojis = ['😀','😂','👍','❤️','🚀','😢','🎉','🔥'];
        const picker = document.createElement('div');
        picker.className = 'mention-suggest';
        picker.style.position = 'absolute';
        picker.style.bottom = '70px';
        picker.style.left = '20px';
        picker.innerHTML = emojis.map(e => `<div style="font-size:1.5rem;padding:5px 10px;">${e}</div>`).join('');
        document.body.appendChild(picker);
        picker.addEventListener('click', (e) => {
            if (e.target.tagName === 'DIV') {
                msgInput.value += e.target.innerText;
                picker.remove();
            }
        });
        setTimeout(() => picker.remove(), 5000);
    };

    // Профиль (модалка)
    document.getElementById("userProfileBtn").addEventListener("click", () => {
        alert(`Профиль: ${currentUser.displayName}\nEmail: ${currentUser.email}`);
    });
}

function renderMessageHtml(msg) {
    let imgHtml = '';
    if (msg.image && msg.image.startsWith('data:image/')) {
        imgHtml = `<img src="${msg.image}" class="uploaded-img" alt="image" onclick="showImageModal('${msg.image}')">`;
    }
    const reactionsHtml = Array.from(msg.reactions?.entries() || []).map(([emoji, count]) => `
        <div class="reaction" data-msg-id="${msg.id}" data-emoji="${emoji}">
            <span class="reaction-emoji">${emoji}</span>
            <span class="reaction-count">${count}</span>
        </div>
    `).join('');
    return `
        <div class="message-card" data-msg-id="${msg.id}">
            <div class="message-avatar">${escapeHtml(msg.authorAvatar || getInitials(msg.authorName))}</div>
            <div class="message-content">
                <div class="message-meta">
                    <span class="message-author">${escapeHtml(msg.authorName)}</span>
                    <span class="message-time">${formatTime(msg.timestamp)}${msg.edited ? ' (ред.)' : ''}</span>
                </div>
                <div class="message-text">${imgHtml}${parseMarkdown(msg.text)}</div>
                ${reactionsHtml ? `<div class="reactions">${reactionsHtml}</div>` : ''}
            </div>
            <div class="message-actions">
                ${msg.authorId === currentUser?.uid ? `<button class="action-btn edit-msg" data-id="${msg.id}">✏️</button><button class="action-btn del-msg" data-id="${msg.id}">🗑️</button>` : ''}
                <button class="action-btn react-msg" data-id="${msg.id}">➕</button>
            </div>
        </div>
    `;
}

function renderMessages() {
    const messages = currentMessagesCache;
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
            const oldMsg = currentMessagesCache.find(m => m.id === id);
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
    document.querySelectorAll('.react-msg').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const msgId = btn.dataset.id;
            const emoji = prompt("Введите эмодзи (например 👍, ❤️):", "👍");
            if (emoji) await toggleReaction(msgId, emoji);
        };
    });
    document.querySelectorAll('.reaction').forEach(react => {
        react.onclick = async (e) => {
            e.stopPropagation();
            const msgId = react.dataset.msgId;
            const emoji = react.dataset.emoji;
            await toggleReaction(msgId, emoji);
        };
    });
    document.querySelectorAll('.uploaded-img').forEach(img => {
        img.onclick = () => showImageModal(img.src);
    });
}

function showImageModal(src) {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.innerHTML = `<img src="${src}" alt="Preview"><div style="position:absolute;top:20px;right:30px;color:white;font-size:30px;cursor:pointer;">✖</div>`;
    document.body.appendChild(modal);
    modal.onclick = () => modal.remove();
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

// Глобальная функция для модалки изображения
window.showImageModal = showImageModal;

// ---------- СТАРТ ----------
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        await setUserOnline(user);
        renderMainUI();
    } else {
        currentUser = null;
        showAuthModal();
    }
});

// ---------- КОНФИГУРАЦИЯ ----------
    const STORAGE_MESSAGES_KEY = "it_messenger_pro_messages";
    const STORAGE_USERNAME_KEY = "it_messenger_username";
    const DEFAULT_USERNAME = "IT-специалист";
    const CHANNELS = [
        { id: "general", name: "general", topic: "💬 Общие вопросы", icon: "#" },
        { id: "random", name: "random", topic: "🎲 Случайные обсуждения", icon: "~" },
        { id: "frontend", name: "frontend", topic: "⚛️ React, UI, дизайн", icon: "🖥️" },
        { id: "backend", name: "backend", topic: "🐍 Python / Node / API", icon: "⚙️" },
        { id: "devops", name: "devops", topic: "☁️ CI/CD, Docker", icon: "🔧" }
    ];
    const TEAM_MEMBERS = ["Анна (PM)", "Илья Backend", "Марина Frontend", "Денис DevOps", "Ольга QA", "Кирилл Data", "IT-специалист"];

    let messagesDB = {};
    let currentChannelId = "general";
    let currentUsername = DEFAULT_USERNAME;
    let realtimeInterval = null;
    let searchQuery = "";
    
    // Непрочитанные сообщения: объект { channelId: count }
    let unreadCounts = {};
    // Флаг, чтобы не считать свои сообщения как непрочитанные
    let lastViewedTime = {}; // для каждого канала время последнего просмотра

    // Helper functions
    function generateId() { return Date.now() + '-' + Math.random().toString(36).substr(2, 8); }
    function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
    function getInitials(name) { let parts = name.trim().split(' '); if(parts.length>=2) return (parts[0][0]+parts[parts.length-1][0]).toUpperCase(); return name.slice(0,2).toUpperCase(); }

    // Markdown парсер
    function parseMarkdown(text) {
        let html = escapeHtml(text);
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/`(.*?)`/g, '<code style="background:var(--bg-body);padding:2px 6px;border-radius:6px;">$1</code>');
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" style="color:var(--accent-blue);">$1</a>');
        html = html.replace(/@(\w+)/g, '<span style="background:var(--accent-green);padding:0 4px;border-radius:12px;">@$1</span>');
        return html;
    }
    function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){ if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }

    // localStorage
    function persistMessages() { localStorage.setItem(STORAGE_MESSAGES_KEY, JSON.stringify(messagesDB)); }
    function loadMessages() {
        let raw = localStorage.getItem(STORAGE_MESSAGES_KEY);
        if(raw) { messagesDB = JSON.parse(raw); }
        else { initDefaultMessages(); }
        for(let ch of CHANNELS) if(!messagesDB[ch.id]) messagesDB[ch.id]=[];
        // инициализация lastViewedTime
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
            if(ch.id === "general") db[ch.id].push({ id:generateId(), author:"Система", authorAvatar:"СИ", text:"Привет! Используйте **жирный**, *курсив*, `код`, [ссылки](https://example.com). Загружайте изображения.", timestamp:now-3600000, edited:false });
            else db[ch.id].push({ id:generateId(), author:"Бот", authorAvatar:"🤖", text:`Добро пожаловать в #${ch.name}`, timestamp:now-1800000, edited:false });
        }
        messagesDB = db;
        persistMessages();
    }
    
    // Обновление счетчика непрочитанных
    function updateUnreadCountsForNewMessage(channelId, msgAuthor) {
        if(channelId === currentChannelId && msgAuthor !== currentUsername) {
            // Если канал активен и сообщение не от текущего пользователя, увеличиваем счётчик только если сообщение новее lastViewed
            let lastView = lastViewedTime[channelId] || 0;
            let msgTime = Date.now();
            if(msgTime > lastView) {
                unreadCounts[channelId] = (unreadCounts[channelId] || 0) + 1;
            }
        } else if(channelId !== currentChannelId && msgAuthor !== currentUsername) {
            unreadCounts[channelId] = (unreadCounts[channelId] || 0) + 1;
        }
        renderSidebar(); // обновляем бейджи
    }
    
    // Сброс непрочитанных при переходе в канал
    function resetUnreadCount(channelId) {
        unreadCounts[channelId] = 0;
        lastViewedTime[channelId] = Date.now();
        renderSidebar();
    }
    
    function addMessage(channelId, msgObj) {
        messagesDB[channelId].push(msgObj);
        persistMessages();
        // обновляем непрочитанные, если сообщение не от текущего пользователя (в активном канале или фоне)
        if(msgObj.author !== currentUsername) {
            updateUnreadCountsForNewMessage(channelId, msgObj.author);
        }
        if(currentChannelId === channelId) {
            renderMessages();
            scrollToBottom();
        }
    }
    
    function updateMessage(channelId, msgId, newText, newImage=null) {
        let msg = messagesDB[channelId].find(m => m.id === msgId);
        if(msg) { msg.text = newText; if(newImage!==null) msg.image = newImage; msg.edited = true; msg.timestamp = Date.now(); persistMessages(); if(currentChannelId===channelId) renderMessages(); }
    }
    function deleteMessage(channelId, msgId) {
        messagesDB[channelId] = messagesDB[channelId].filter(m => m.id !== msgId);
        persistMessages();
        if(currentChannelId===channelId) renderMessages();
    }

    // Отправка сообщения
    function sendOwnMessage(text, imageBase64=null) {
        if(!text.trim() && !imageBase64) return;
        let newMsg = {
            id: generateId(),
            author: currentUsername,
            authorAvatar: getInitials(currentUsername),
            text: text.trim() || "",
            image: imageBase64,
            timestamp: Date.now(),
            edited: false
        };
        addMessage(currentChannelId, newMsg);
        document.getElementById("messageInput").value = "";
        // после отправки своего сообщения сбрасываем непрочитанные для текущего канала, т.к. мы активны
        if(unreadCounts[currentChannelId] > 0) resetUnreadCount(currentChannelId);
    }

    // Обработка изображения
    document.getElementById("imageUpload").addEventListener("change", function(e) {
        let file = e.target.files[0];
        if(file && file.type.startsWith('image/')) {
            let reader = new FileReader();
            reader.onload = function(ev) { sendOwnMessage("", ev.target.result); };
            reader.readAsDataURL(file);
        }
        this.value = '';
    });

    // Поиск и рендер сообщений
    function renderMessages() {
        let messages = messagesDB[currentChannelId] || [];
        if(searchQuery.trim()) {
            let q = searchQuery.trim().toLowerCase();
            messages = messages.filter(m => m.text.toLowerCase().includes(q) || m.author.toLowerCase().includes(q));
        }
        messages.sort((a,b) => a.timestamp - b.timestamp);
        let container = document.getElementById("messagesContainer");
        if(!messages.length) { container.innerHTML = `<div style="text-align:center;padding:30px;">🔍 Ничего не найдено</div>`; return; }
        container.innerHTML = messages.map(msg => `
            <div class="message-card" data-msg-id="${msg.id}">
                <div class="message-avatar">${escapeHtml(msg.authorAvatar || getInitials(msg.author))}</div>
                <div class="message-content">
                    <div class="message-meta"><span class="message-author">${escapeHtml(msg.author)}</span><span class="message-time">${formatTime(msg.timestamp)}${msg.edited ? ' (ред.)' : ''}</span></div>
                    <div class="message-text">${msg.image ? `<img src="${msg.image}" class="uploaded-img" alt="image">` : ''}${parseMarkdown(msg.text)}</div>
                </div>
                <div class="message-actions">
                    ${msg.author === currentUsername ? `<button class="action-btn edit-msg" data-id="${msg.id}">✏️</button><button class="action-btn del-msg" data-id="${msg.id}">🗑️</button>` : ''}
                </div>
            </div>
        `).join('');
        // обработчики редактирования/удаления
        document.querySelectorAll('.edit-msg').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); let id = btn.dataset.id; let oldMsg = messagesDB[currentChannelId].find(m=>m.id===id); let newText = prompt("Редактировать сообщение:", oldMsg.text); if(newText !== null) updateMessage(currentChannelId, id, newText, oldMsg.image); });
        });
        document.querySelectorAll('.del-msg').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); if(confirm("Удалить сообщение?")) deleteMessage(currentChannelId, btn.dataset.id); });
        });
    }
    
    function scrollToBottom() {
        let container = document.getElementById("messagesContainer");
        container.scrollTop = container.scrollHeight;
    }

    // Упоминания (при вводе @)
    function setupMentionDetection() {
        let input = document.getElementById("messageInput");
        let suggestDiv = null;
        function hideSuggest() { if(suggestDiv) { suggestDiv.remove(); suggestDiv = null; } }
        input.addEventListener("input", function(e) {
            let val = input.value;
            let cursorPos = input.selectionStart;
            let lastAtIndex = val.lastIndexOf('@', cursorPos-1);
            if(lastAtIndex !== -1 && (lastAtIndex === 0 || val[lastAtIndex-1] === ' ' || val[lastAtIndex-1] === '\n')) {
                let query = val.slice(lastAtIndex+1, cursorPos);
                let matches = TEAM_MEMBERS.filter(m => m.toLowerCase().startsWith(query.toLowerCase()));
                if(matches.length) {
                    if(suggestDiv) suggestDiv.remove();
                    suggestDiv = document.createElement('div');
                    suggestDiv.className = 'mention-suggest';
                    matches.forEach(user => {
                        let item = document.createElement('div');
                        item.textContent = user;
                        item.onclick = () => {
                            let before = val.slice(0, lastAtIndex);
                            let after = val.slice(cursorPos);
                            input.value = before + user + ' ' + after;
                            input.focus();
                            hideSuggest();
                        };
                        suggestDiv.appendChild(item);
                    });
                    let rect = input.getBoundingClientRect();
                    suggestDiv.style.position = 'absolute';
                    suggestDiv.style.bottom = '60px';
                    suggestDiv.style.left = rect.left + 'px';
                    document.body.appendChild(suggestDiv);
                    return;
                }
            }
            hideSuggest();
        });
        document.addEventListener("click", (e) => { if(suggestDiv && !suggestDiv.contains(e.target)) hideSuggest(); });
    }

    // Выпадающий список эмодзи
    function initEmojiSelect() {
        let select = document.getElementById("emojiSelect");
        let input = document.getElementById("messageInput");
        select.addEventListener("change", () => {
            if(select.value) {
                input.value += select.value;
                input.focus();
                select.value = "";
            }
        });
    }

    // Тёмная тема
    function initTheme() {
        let isDark = localStorage.getItem("darkTheme") === "true";
        if(isDark) document.body.classList.add('dark');
        document.getElementById("themeToggle").addEventListener("click", () => {
            document.body.classList.toggle('dark');
            localStorage.setItem("darkTheme", document.body.classList.contains('dark'));
        });
    }

    // Имитация реального времени
    function triggerRealtimeMessage() {
        let randomMember = TEAM_MEMBERS[Math.floor(Math.random() * TEAM_MEMBERS.length)];
        let phrases = ["Обсудим новый релиз", "Проверьте код в ревью", "Кто возьмёт задачу?", "Документация обновлена", "Нашел баг, фикс скоро", "Деплой в 16:00"];
        let text = phrases[Math.floor(Math.random() * phrases.length)];
        let mockMsg = {
            id: generateId(), author: randomMember, authorAvatar: getInitials(randomMember), text: text, timestamp: Date.now(), edited: false
        };
        addMessage(currentChannelId, mockMsg);
    }

    // Переключение канала
    function switchToChannel(channelId) {
        // сброс непрочитанных для предыдущего канала не нужен, но для нового сбрасываем
        currentChannelId = channelId;
        resetUnreadCount(channelId);
        let ch = CHANNELS.find(c=>c.id===channelId);
        document.getElementById("currentChannelName").innerHTML = `#${ch.name}`;
        document.getElementById("channelTopic").innerText = ch.topic;
        document.querySelectorAll('.channel-item').forEach(el => { if(el.dataset.channelId === channelId) el.classList.add('active'); else el.classList.remove('active'); });
        renderMessages();
        scrollToBottom();
    }

    function renderSidebar() {
        let container = document.getElementById("channelsList");
        container.innerHTML = `<div class="channel-category">Текстовые каналы</div>` + 
            CHANNELS.map(ch => {
                let unread = unreadCounts[ch.id] || 0;
                let badgeHtml = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
                return `<div class="channel-item" data-channel-id="${ch.id}">
                            <div class="channel-left">
                                <div class="channel-icon">${ch.icon}</div>
                                <div class="channel-name">${ch.name}</div>
                            </div>
                            ${badgeHtml}
                        </div>`;
            }).join('');
        document.querySelectorAll('.channel-item').forEach(el => el.addEventListener('click', ()=> switchToChannel(el.dataset.channelId)));
        if(document.querySelector(`.channel-item[data-channel-id="${currentChannelId}"]`)) 
            document.querySelector(`.channel-item[data-channel-id="${currentChannelId}"]`).classList.add('active');
    }

    function setUsername(newName) {
        if(!newName.trim()) return;
        currentUsername = newName.trim();
        localStorage.setItem(STORAGE_USERNAME_KEY, currentUsername);
        let init = getInitials(currentUsername);
        document.getElementById("userAvatar").innerText = init;
        document.getElementById("globalUsername").innerText = currentUsername;
        document.getElementById("miniAvatar").innerText = init;
        document.getElementById("miniUsername").innerText = currentUsername;
    }
    function promptEditUsername() { let newName = prompt("Имя:", currentUsername); if(newName) setUsername(newName); }

    function loadUsername() { let stored = localStorage.getItem(STORAGE_USERNAME_KEY); currentUsername = stored ? stored : DEFAULT_USERNAME; setUsername(currentUsername); }

    // Поиск
    document.getElementById("searchInput").addEventListener("input", (e) => { searchQuery = e.target.value; renderMessages(); });

    // Инициализация
    function init() {
        loadMessages();
        loadUsername();
        renderSidebar();
        switchToChannel("general");
        document.getElementById("sendMessageBtn").addEventListener("click", () => { let val = document.getElementById("messageInput").value; if(val.trim()) sendOwnMessage(val); });
        document.getElementById("messageInput").addEventListener("keypress", (e) => { if(e.key === "Enter" && !e.shiftKey) { e.preventDefault(); let val = document.getElementById("messageInput").value; if(val.trim()) sendOwnMessage(val); } });
        document.getElementById("editNameGlobal").addEventListener("click", promptEditUsername);
        document.getElementById("editNameMini").addEventListener("click", promptEditUsername);
        setupMentionDetection();
        initEmojiSelect();
        initTheme();
        if(realtimeInterval) clearInterval(realtimeInterval);
        realtimeInterval = setInterval(() => { triggerRealtimeMessage(); }, 25000);
        document.getElementById("messageInput").focus();
    }
    window.addEventListener("DOMContentLoaded", init);
    window.addEventListener("beforeunload", () => { if(realtimeInterval) clearInterval(realtimeInterval); });

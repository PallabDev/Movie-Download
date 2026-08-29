/**
 * CineGrab AI Studio - Minimalist Client Application
 * Clean Tabler Icons & Minimalist Dark Aesthetics
 */

// Global State
const state = {
    user: window.__APP_USER__ || { id: 1, name: 'User', email: 'user@example.com', role: 'user' },
    currentView: 'chat',
    sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    chatHistory: [],
    sendingChat: false,
    activeDownloads: new Map(),
    searchResultSession: null,
    ws: null,
};

// SVG Constants
const ICONS = {
    ai: `<svg class="tabler-icon" viewBox="0 0 24 24" style="width:16px;height:16px;stroke:#fff;"><path d="M6 4m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z"/><path d="M12 2v2"/><path d="M9 12v9"/><path d="M15 12v9"/><path d="M5 16l4 -2"/><path d="M15 14l4 2"/><path d="M9 8h.01"/><path d="M15 8h.01"/></svg>`,
    download: `<svg class="tabler-icon" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>`,
    success: `<svg class="tabler-icon text-emerald" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M5 12l5 5l10 -10"/></svg>`,
    error: `<svg class="tabler-icon text-rose" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>`,
    movie: `<svg class="tabler-icon text-blue" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>`,
    bot: `<svg class="tabler-icon text-blue" viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4"/></svg>`,
};

// ==========================================================================
// TOAST NOTIFICATIONS
// ==========================================================================
function showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const iconHtml = type === 'success' ? ICONS.success : type === 'error' ? ICONS.error : ICONS.ai;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        ${iconHtml}
        <div>${escapeHtml(message)}</div>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.2s ease';
        setTimeout(() => toast.remove(), 200);
    }, 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ==========================================================================
// NAVIGATION CONTROLLER
// ==========================================================================
function switchView(viewName) {
    state.currentView = viewName;

    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });

    document.querySelectorAll('.view-container').forEach(container => {
        container.classList.toggle('active', container.id === `view-${viewName}`);
    });

    const titleEl = document.getElementById('headerViewTitle');
    if (titleEl) {
        const titles = {
            chat: 'AI Copilot Assistant',
            studio: 'Search & Discover',
            downloads: 'Download Station',
            jellyfin: 'Jellyfin Media Hub',
            bot: 'Telegram Bot',
            admin: 'User Management'
        };
        titleEl.textContent = titles[viewName] || 'Dashboard';
    }

    if (viewName === 'downloads') loadDownloadHistory();
    if (viewName === 'jellyfin') loadJellyfinStats();
    if (viewName === 'admin') loadAdminUsers();
    if (viewName === 'bot') checkBotStatus();

    document.getElementById('appSidebar')?.classList.remove('open');
}

function toggleSidebar() {
    document.getElementById('appSidebar')?.classList.toggle('open');
}

function toggleUserMenu() {
    document.getElementById('userPopover')?.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
    const popover = document.getElementById('userPopover');
    const userCard = document.getElementById('userCardTrigger');
    if (popover && userCard && !userCard.contains(e.target) && !popover.contains(e.target)) {
        popover.classList.add('hidden');
    }
});

// ==========================================================================
// WEBSOCKET & DOWNLOAD PROGRESS
// ==========================================================================
function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    try {
        state.ws = new WebSocket(wsUrl);

        state.ws.onopen = () => {
            state.ws.send(JSON.stringify({
                type: 'auth',
                userId: state.user.id,
                role: state.user.role
            }));
        };

        state.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWebSocketMessage(msg);
            } catch (err) {
                console.error('[WS] Parse error:', err);
            }
        };

        state.ws.onclose = () => {
            setTimeout(initWebSocket, 3000);
        };
    } catch (e) {
        console.error('[WS] Setup failed:', e);
    }
}

function handleWebSocketMessage(msg) {
    if (msg.type === 'new_download') {
        state.activeDownloads.set(msg.jobId, {
            jobId: msg.jobId,
            title: msg.title,
            percent: 0,
            speed: 'Connecting...',
            eta: 'Calculating...',
            downloaded: '0 MB',
            total: 'Unknown',
            status: 'downloading'
        });
        showToast(`Started download: ${msg.title}`, 'info');
        renderActiveDownloads();
        addOrUpdateChatProgress(msg.jobId, msg.title, 0, 'downloading', 'Starting...');
        updateDownloadBadge();
    } else if (msg.type === 'download_progress') {
        const existing = state.activeDownloads.get(msg.jobId) || { jobId: msg.jobId, title: msg.title };
        const updated = {
            ...existing,
            percent: msg.percent || 0,
            speed: msg.speed || '0 MB/s',
            eta: msg.eta || '',
            downloaded: msg.downloaded || '0 MB',
            total: msg.total || '0 MB',
            status: 'downloading'
        };
        state.activeDownloads.set(msg.jobId, updated);
        renderActiveDownloads();
        addOrUpdateChatProgress(msg.jobId, msg.title, msg.percent, 'downloading', `${msg.speed} · ETA ${msg.eta}`);
    } else if (msg.type === 'download_complete') {
        const item = state.activeDownloads.get(msg.jobId);
        if (item) {
            item.status = msg.success ? 'completed' : 'failed';
            item.percent = msg.success ? 100 : item.percent;
            item.error = msg.error;
        }
        showToast(msg.success ? `Downloaded: ${msg.title}` : `Download failed: ${msg.title}`, msg.success ? 'success' : 'error');
        renderActiveDownloads();
        completeChatProgress(msg.jobId, msg.title, msg.success, msg.error);
        loadDownloadHistory();
        setTimeout(() => {
            state.activeDownloads.delete(msg.jobId);
            renderActiveDownloads();
            updateDownloadBadge();
        }, 6000);
    }
}

function updateDownloadBadge() {
    const badge = document.getElementById('activeDownloadsBadge');
    if (badge) {
        const count = state.activeDownloads.size;
        badge.textContent = count;
        badge.classList.toggle('pulse', count > 0);
        badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
}

function renderActiveDownloads() {
    const container = document.getElementById('liveDownloadsGrid');
    const emptyState = document.getElementById('noActiveDownloadsMsg');
    if (!container) return;

    const list = Array.from(state.activeDownloads.values());
    if (list.length === 0) {
        container.innerHTML = '';
        if (emptyState) emptyState.style.display = 'block';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';

    container.innerHTML = list.map(dl => {
        const circ = 125.6;
        const offset = circ * (1 - (dl.percent || 0) / 100);
        const isComplete = dl.status === 'completed';
        const isFailed = dl.status === 'failed';
        const ringClass = isComplete ? 'completed' : isFailed ? 'failed' : '';

        return `
            <div class="live-progress-card" id="lpc-${dl.jobId}">
                <div class="lpc-header">
                    <div class="lpc-ring-wrap">
                        <svg viewBox="0 0 44 44">
                            <circle class="lpc-ring-bg" cx="22" cy="22" r="20"></circle>
                            <circle class="lpc-ring-fill ${ringClass}" cx="22" cy="22" r="20" style="stroke-dashoffset: ${offset}"></circle>
                        </svg>
                        <div class="lpc-percent-text">${isComplete ? '✓' : isFailed ? '✕' : (dl.percent || 0) + '%'}</div>
                    </div>
                    <div class="lpc-info">
                        <div class="lpc-title" title="${escapeHtml(dl.title)}">${escapeHtml(dl.title)}</div>
                        <div class="lpc-status-tag">
                            <span class="status-dot ${isComplete ? 'online' : isFailed ? 'offline' : 'connecting'}"></span>
                            ${isComplete ? 'Completed' : isFailed ? 'Failed' : 'Downloading'}
                        </div>
                    </div>
                </div>
                <div class="lpc-linear-progress">
                    <div class="lpc-linear-bar" style="width: ${dl.percent || 0}%;"></div>
                </div>
                <div class="lpc-stats-row">
                    <span>${dl.downloaded || '0 MB'} / ${dl.total || '0 MB'}</span>
                    <span class="tabular-nums">${dl.speed || ''} ${dl.eta ? '· ETA ' + dl.eta : ''}</span>
                </div>
            </div>
        `;
    }).join('');
}

// ==========================================================================
// AI COPILOT CHAT CONTROLLER
// ==========================================================================
function addChatMessage(content, sender = 'assistant', meta = {}) {
    const chatBox = document.getElementById('chatMessagesBox');
    if (!chatBox) return null;

    const isAtBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;

    const row = document.createElement('div');
    row.className = `message-row ${sender}`;

    const avatarHtml = sender === 'user'
        ? `<span style="font-weight:700;font-size:11px;">${(state.user.name || 'U').charAt(0).toUpperCase()}</span>`
        : ICONS.ai;

    let formattedHtml = '';

    if (sender === 'user') {
        formattedHtml = `<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
    } else {
        try {
            formattedHtml = typeof marked !== 'undefined' ? marked.parse(content) : `<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
        } catch {
            formattedHtml = `<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
        }
    }

    let actionButtonsHtml = '';
    if (meta.actions && Array.isArray(meta.actions) && meta.actions.length > 0) {
        actionButtonsHtml = `
            <div class="chat-action-grid">
                ${meta.actions.map(act => `
                    <button class="chat-action-btn ${act.recommended ? 'recommended' : ''}" onclick="handleChatAction('${escapeHtml(act.action)}', '${escapeHtml(act.param)}')">
                        ${escapeHtml(act.label)}
                    </button>
                `).join('')}
            </div>
        `;
    }

    row.innerHTML = `
        <div class="msg-avatar">${avatarHtml}</div>
        <div class="msg-bubble">
            ${meta.workflowChip ? `<div class="workflow-chip ${meta.workflowChip.type}">${meta.workflowChip.label}</div>` : ''}
            ${formattedHtml}
            ${actionButtonsHtml}
        </div>
    `;

    chatBox.appendChild(row);
    if (isAtBottom) chatBox.scrollTop = chatBox.scrollHeight;
    return row;
}

function showTypingIndicator() {
    removeTypingIndicator();
    const chatBox = document.getElementById('chatMessagesBox');
    if (!chatBox) return;

    const row = document.createElement('div');
    row.id = 'chatTypingIndicator';
    row.className = 'message-row assistant';
    row.innerHTML = `
        <div class="msg-avatar">${ICONS.ai}</div>
        <div class="msg-bubble typing-bubble">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">Searching...</span>
        </div>
    `;
    chatBox.appendChild(row);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function removeTypingIndicator() {
    document.getElementById('chatTypingIndicator')?.remove();
}

function addOrUpdateChatProgress(jobId, title, percent, status, speedInfo) {
    const chatBox = document.getElementById('chatMessagesBox');
    if (!chatBox) return;

    let el = document.getElementById(`chat-prog-${jobId}`);
    const isAtBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;

    if (!el) {
        el = document.createElement('div');
        el.id = `chat-prog-${jobId}`;
        el.className = 'message-row assistant';
        chatBox.appendChild(el);
    }

    el.innerHTML = `
        <div class="msg-avatar">
            ${ICONS.download}
        </div>
        <div class="msg-bubble" style="width: 100%; max-width: 400px;">
            <div style="font-weight: 600; font-size: 12.5px; color: #fff; margin-bottom: 6px;">${escapeHtml(title)}</div>
            <div style="display: flex; align-items: center; gap: 10px;">
                <div class="lpc-linear-progress" style="flex: 1;">
                    <div class="lpc-linear-bar" style="width: ${percent || 0}%;"></div>
                </div>
                <span class="tabular-nums" style="font-size: 11px; font-weight: 600; color: var(--accent-blue);">${percent || 0}%</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; display: flex; justify-content: space-between;">
                <span>${status === 'completed' ? 'Finished' : 'Downloading'}</span>
                <span>${escapeHtml(speedInfo || '')}</span>
            </div>
        </div>
    `;

    if (isAtBottom) chatBox.scrollTop = chatBox.scrollHeight;
}

function completeChatProgress(jobId, title, success, error) {
    const el = document.getElementById(`chat-prog-${jobId}`);
    if (!el) return;
    el.innerHTML = `
        <div class="msg-avatar">${success ? ICONS.success : ICONS.error}</div>
        <div class="msg-bubble">
            <div style="font-weight: 600; font-size: 12.5px; color: ${success ? 'var(--accent-emerald)' : 'var(--accent-rose)'};">
                ${success ? 'Download Complete' : 'Download Failed'}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${escapeHtml(title)}</div>
            ${error ? `<div style="font-size: 11px; color: var(--accent-rose); margin-top: 2px;">${escapeHtml(error)}</div>` : ''}
        </div>
    `;
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text || state.sendingChat) return;

    state.sendingChat = true;
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('btnSendChat').disabled = true;

    addChatMessage(text, 'user');
    state.chatHistory.push({ role: 'user', content: text });
    showTypingIndicator();

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                message: text,
                history: state.chatHistory.slice(-15),
                sessionId: state.sessionId
            })
        });

        const data = await response.json();
        removeTypingIndicator();

        if (data.sessionId) state.sessionId = data.sessionId;

        if (data.error) {
            addChatMessage(data.error, 'assistant');
        } else {
            addChatMessage(data.reply, 'assistant');
            state.chatHistory.push({ role: 'assistant', content: data.reply });
            saveChatSession(text, data.reply);
        }
    } catch (err) {
        removeTypingIndicator();
        addChatMessage(`Connection error: ${err.message}`, 'assistant');
    } finally {
        state.sendingChat = false;
        document.getElementById('btnSendChat').disabled = false;
        input.focus();
    }
}

function handleQuickPrompt(promptText) {
    const input = document.getElementById('chatInput');
    if (!input) return;
    input.value = promptText;
    sendChatMessage();
}

function handleChatAction(action, param) {
    if (action === 'quick_prompt') {
        handleQuickPrompt(param);
    } else if (action === 'view_studio') {
        switchView('studio');
        document.getElementById('studioSearchInput').value = param;
        performStudioSearch();
    }
}

function startNewChat() {
    state.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    state.chatHistory = [];
    const chatBox = document.getElementById('chatMessagesBox');
    if (chatBox) {
        chatBox.innerHTML = `
            <div class="chat-welcome-card">
                <div class="welcome-icon-box">
                    ${ICONS.ai}
                </div>
                <h2>Media Search & Downloader</h2>
                <p>Find movies, full TV series seasons, episodes, or inspect Jellyfin libraries.</p>
                <div class="quick-prompts-grid">
                    <button class="quick-prompt-btn" onclick="handleQuickPrompt('Search Inception 2010 movie')">
                        ${ICONS.movie}
                        <div>
                            <strong>Inception (2010)</strong>
                            <div class="text-muted" style="font-size: 11px;">Search movie releases</div>
                        </div>
                    </button>
                    <button class="quick-prompt-btn" onclick="handleQuickPrompt('Check bot connection status')">
                        ${ICONS.bot}
                        <div>
                            <strong>Telegram Bot Status</strong>
                            <div class="text-muted" style="font-size: 11px;">View link & 2FA state</div>
                        </div>
                    </button>
                </div>
            </div>
        `;
    }
    document.getElementById('chatInput')?.focus();
}

function saveChatSession(prompt, reply) {
    try {
        const key = `cinegrab_recents_${state.user.id}`;
        let list = JSON.parse(localStorage.getItem(key) || '[]');
        list.unshift({ prompt, reply: reply.slice(0, 60), time: Date.now() });
        if (list.length > 20) list = list.slice(0, 20);
        localStorage.setItem(key, JSON.stringify(list));
        loadChatSessions();
    } catch {}
}

function loadChatSessions() {
    const listEl = document.getElementById('chatSessionsList');
    if (!listEl) return;
    try {
        const key = `cinegrab_recents_${state.user.id}`;
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        if (list.length === 0) {
            listEl.innerHTML = '<div style="font-size: 11.5px; color: var(--text-muted); padding: 4px 8px;">No chats yet</div>';
            return;
        }
        listEl.innerHTML = list.map((item, idx) => `
            <div class="session-item" onclick="loadChatSessionPrompt(${idx})">
                <svg class="tabler-icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>
                <span>${escapeHtml(item.prompt)}</span>
            </div>
        `).join('');
    } catch {}
}

function loadChatSessionPrompt(index) {
    try {
        const key = `cinegrab_recents_${state.user.id}`;
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        if (list[index]) {
            const input = document.getElementById('chatInput');
            if (input) {
                input.value = list[index].prompt;
                input.focus();
            }
        }
    } catch {}
}

// ==========================================================================
// SEARCH & DISCOVER STUDIO
// ==========================================================================
let studioSearchType = 'movie';

function setStudioType(type) {
    studioSearchType = type;
    document.getElementById('studioTypeMovie')?.classList.toggle('active', type === 'movie');
    document.getElementById('studioTypeSeries')?.classList.toggle('active', type === 'series');
    const yearInput = document.getElementById('studioYearInput');
    if (yearInput) {
        yearInput.placeholder = type === 'movie' ? 'Year (e.g. 2024)' : 'Optional Year';
    }
}

async function performStudioSearch() {
    const queryInput = document.getElementById('studioSearchInput');
    const yearInput = document.getElementById('studioYearInput');
    const btn = document.getElementById('btnStudioSearch');
    const resultsArea = document.getElementById('studioResultsArea');
    if (!queryInput || !resultsArea) return;

    const title = queryInput.value.trim();
    const year = yearInput ? yearInput.value.trim() : '';
    if (!title) {
        showToast('Please enter a title', 'error');
        return;
    }

    btn.disabled = true;
    resultsArea.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-secondary);">
            <div class="typing-dot" style="display: inline-block; width: 6px; height: 6px; margin: 0 3px;"></div>
            <div class="typing-dot" style="display: inline-block; width: 6px; height: 6px; margin: 0 3px;"></div>
            <div class="typing-dot" style="display: inline-block; width: 6px; height: 6px; margin: 0 3px;"></div>
            <div style="margin-top: 10px; font-size: 12.5px;">Searching releases...</div>
        </div>
    `;

    try {
        const response = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ title, type: studioSearchType, year })
        });

        const data = await response.json();
        if (data.error) {
            resultsArea.innerHTML = `<div class="auth-error-alert" style="display: block;">${escapeHtml(data.error)}</div>`;
            return;
        }

        if (data.status === 'skipped') {
            resultsArea.innerHTML = `
                <div class="media-result-card" style="border-color: var(--accent-emerald);">
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <svg class="tabler-icon text-emerald" style="width:22px;height:22px;" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                        <div>
                            <div class="card-title">${escapeHtml(data.message)}</div>
                            <div class="chip jellyfin" style="margin-top: 4px;">Already in Jellyfin Library</div>
                        </div>
                    </div>
                </div>
            `;
            return;
        }

        if (data.status === 'no_results' || !data.results || data.results.length === 0) {
            resultsArea.innerHTML = `
                <div style="text-align: center; padding: 30px; color: var(--text-muted);">
                    <div style="font-size: 13px; font-weight: 600; color: #fff;">No results found</div>
                    <div style="font-size: 12px; margin-top: 2px;">Try adjusting the title or query.</div>
                </div>
            `;
            return;
        }

        state.searchResultSession = data.searchId;

        if (studioSearchType === 'movie') {
            renderMovieStudioResults(data, resultsArea);
        } else {
            renderSeriesStudioResults(data, resultsArea);
        }
    } catch (err) {
        resultsArea.innerHTML = `<div class="auth-error-alert" style="display: block;">Search error: ${escapeHtml(err.message)}</div>`;
    } finally {
        btn.disabled = false;
    }
}

function renderMovieStudioResults(data, container) {
    container.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
            <h3 style="font-size: 15px;">Releases for "${escapeHtml(data.title)}"</h3>
            <span class="chip best">${data.results.length} found</span>
        </div>
        <div class="results-grid">
            ${data.results.map((res, idx) => {
                const isBest = idx === data.bestIdx;
                const sizeLabel = res.sizeMB > 1024 ? (res.sizeMB / 1024).toFixed(1) + ' GB' : res.sizeMB.toFixed(0) + ' MB';
                let quality = '720p';
                if (res.text.includes('1080p')) quality = '1080p';
                else if (res.text.includes('2160p') || res.text.includes('4K')) quality = '4K';
                else if (res.text.includes('480p')) quality = '480p';

                return `
                    <div class="media-result-card ${isBest ? 'best-pick' : ''}">
                        <div class="card-title">${escapeHtml(res.text)}</div>
                        <div class="card-badge-row">
                            <span class="chip quality">${quality}</span>
                            <span class="chip size">${sizeLabel}</span>
                            ${isBest ? `<span class="chip best">Recommended</span>` : ''}
                        </div>
                        ${isBest && data.bestReason ? `<div class="card-reason">${escapeHtml(data.bestReason)}</div>` : ''}
                        <button class="btn-primary-action" style="width: 100%; padding: 7px 12px; font-size: 12px;" onclick="triggerStudioMovieDownload('${escapeHtml(res.text)}')">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                            Download
                        </button>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderSeriesStudioResults(data, container) {
    const seasons = data.uniqueSeasons || [1];
    const episodes = data.seriesEpisodes || [];

    container.innerHTML = `
        <div class="series-studio-container">
            <div>
                <h3 style="font-size: 15px;">${escapeHtml(data.title)}</h3>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                    ${seasons.length} Season(s) · ${episodes.length} Episodes
                </div>
            </div>
            
            <div class="seasons-tab-bar" id="seasonsTabBar">
                ${seasons.map((s, idx) => `
                    <button class="season-tab ${idx === 0 ? 'active' : ''}" onclick="switchStudioSeasonTab(${s})">
                        Season ${s}
                    </button>
                `).join('')}
            </div>

            <div id="seasonContentArea"></div>
        </div>
    `;

    switchStudioSeasonTab(seasons[0], episodes);
}

function switchStudioSeasonTab(seasonNum, allEps = null) {
    document.querySelectorAll('.season-tab').forEach(tab => {
        tab.classList.toggle('active', tab.textContent.trim() === `Season ${seasonNum}`);
    });

    const contentArea = document.getElementById('seasonContentArea');
    if (!contentArea) return;

    const seasonEps = (allEps || []).filter(e => e.season === seasonNum);
    const totalSizeMB = seasonEps.reduce((sum, e) => sum + (e.sizeMB || 0), 0);
    const totalSizeLabel = totalSizeMB > 1024 ? (totalSizeMB / 1024).toFixed(1) + ' GB' : totalSizeMB.toFixed(0) + ' MB';

    contentArea.innerHTML = `
        <div class="season-bulk-banner">
            <div>
                <strong style="font-size: 13px; color: #fff;">Season ${seasonNum}</strong>
                <div style="font-size: 11.5px; color: var(--text-secondary);">
                    ${seasonEps.length} Episodes (${totalSizeLabel})
                </div>
            </div>
            <button class="btn-primary-action" style="padding: 6px 12px; font-size: 12px;" onclick="triggerStudioBulkSeasonDownload(${seasonNum})">
                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                Download Season ${seasonNum}
            </button>
        </div>

        <div class="episodes-list-grid" style="margin-top: 12px;">
            ${seasonEps.map(ep => `
                <div class="episode-item-card">
                    <div>
                        <div class="ep-num">${escapeHtml(ep.label)}</div>
                        <div class="ep-size">${(ep.sizeMB || 0).toFixed(0)} MB</div>
                    </div>
                    <button class="btn-header" style="padding: 4px 8px; font-size: 11px;" onclick="triggerStudioEpisodeDownload('${escapeHtml(ep.text)}')">
                        Download
                    </button>
                </div>
            `).join('')}
        </div>
    `;
}

async function triggerStudioMovieDownload(buttonText) {
    if (!state.searchResultSession) {
        showToast('Session expired. Search again.', 'error');
        return;
    }
    try {
        const res = await fetch('/api/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ searchId: state.searchResultSession, buttonText })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Download started', 'success');
            switchView('downloads');
        } else {
            showToast(data.error || 'Failed to start download', 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function triggerStudioEpisodeDownload(buttonText) {
    await triggerStudioMovieDownload(buttonText);
}

async function triggerStudioBulkSeasonDownload(season) {
    if (!state.searchResultSession) {
        showToast('Session expired. Search again.', 'error');
        return;
    }
    try {
        const res = await fetch('/api/select-all-episodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ searchId: state.searchResultSession, season })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Queued Season ${season}`, 'success');
            switchView('downloads');
        } else {
            showToast(data.error || 'Bulk download failed', 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ==========================================================================
// DOWNLOAD STATION & HISTORY
// ==========================================================================
async function loadDownloadHistory(page = 1) {
    const tableBody = document.getElementById('downloadHistoryTableBody');
    const searchFilter = document.getElementById('historySearchFilter')?.value || '';
    if (!tableBody) return;

    try {
        const res = await fetch(`/api/downloads?page=${page}&limit=15&search=${encodeURIComponent(searchFilter)}`, {
            credentials: 'include'
        });
        const data = await res.json();
        fetchQueueStats();

        if (!data.downloads || data.downloads.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">No records found</td></tr>`;
            return;
        }

        tableBody.innerHTML = data.downloads.map(item => `
            <tr>
                <td style="font-weight: 600; color: #fff;">${escapeHtml(item.title)}</td>
                <td><span class="chip ${item.type === 'movie' ? 'quality' : 'best'}">${escapeHtml(item.type)}</span></td>
                <td>${escapeHtml(item.fileSize || 'N/A')}</td>
                <td>
                    <span class="status-badge ${item.status}">
                        <span class="status-dot ${item.status === 'completed' ? 'online' : item.status === 'failed' ? 'offline' : 'connecting'}"></span>
                        ${escapeHtml(item.status)}
                    </span>
                </td>
                <td style="color: var(--text-secondary); font-size: 11.5px;">${new Date(item.createdAt).toLocaleDateString()} ${new Date(item.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
            </tr>
        `).join('');
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--accent-rose);">Failed to load</td></tr>`;
    }
}

async function fetchQueueStats() {
    try {
        const res = await fetch('/api/queue', { credentials: 'include' });
        const data = await res.json();
        if (data.stats) {
            document.getElementById('metricActiveCount').textContent = data.stats.active || 0;
            document.getElementById('metricWaitingCount').textContent = data.stats.waiting || 0;
            document.getElementById('metricCompletedCount').textContent = data.stats.completed || 0;
            document.getElementById('metricFailedCount').textContent = data.stats.failed || 0;
        }
    } catch {}
}

// ==========================================================================
// JELLYFIN MEDIA HUB
// ==========================================================================
async function loadJellyfinStats() {
    try {
        const res = await fetch('/api/jellyfin/stats', { credentials: 'include' });
        const data = await res.json();
        document.getElementById('jfMoviesCount').textContent = data.movies ?? '--';
        document.getElementById('jfSeriesCount').textContent = data.series ?? '--';
        document.getElementById('jfTotalCount').textContent = ((data.movies || 0) + (data.series || 0)) || '--';
    } catch {}
}

async function checkJellyfinItem() {
    const input = document.getElementById('jfCheckInput');
    const resultBox = document.getElementById('jfCheckResultBox');
    if (!input || !resultBox) return;

    const title = input.value.trim();
    if (!title) return;

    resultBox.style.display = 'block';
    resultBox.innerHTML = '<span class="text-muted">Checking library...</span>';

    try {
        const res = await fetch(`/api/jellyfin/check?title=${encodeURIComponent(title)}`, { credentials: 'include' });
        const data = await res.json();
        if (data.exists) {
            resultBox.innerHTML = `
                <div style="color: var(--accent-emerald); font-weight: 600; display: flex; align-items: center; gap: 6px;">
                    <svg class="tabler-icon text-emerald" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                    "${escapeHtml(title)}" is in your Jellyfin Library.
                </div>
            `;
        } else {
            resultBox.innerHTML = `
                <div style="color: var(--text-secondary); display: flex; align-items: center; gap: 6px;">
                    <svg class="tabler-icon text-blue" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12.01" y2="8"/><polyline points="11 12 12 12 12 16 13 16"/></svg>
                    "${escapeHtml(title)}" is not in Jellyfin.
                </div>
            `;
        }
    } catch (err) {
        resultBox.innerHTML = `<span style="color: var(--accent-rose);">Error: ${escapeHtml(err.message)}</span>`;
    }
}

// ==========================================================================
// TELEGRAM BOT & 2FA
// ==========================================================================
async function checkBotStatus() {
    try {
        const res = await fetch('/api/bot/status', { credentials: 'include' });
        const data = await res.json();

        const dot = document.getElementById('headerBotDot');
        const label = document.getElementById('headerBotStatusText');
        const wizardArea = document.getElementById('botAuthWizardArea');

        if (data.connected) {
            if (dot) dot.className = 'status-dot online';
            if (label) { label.textContent = 'Connected'; label.style.color = 'var(--accent-emerald)'; }
            if (wizardArea) wizardArea.style.display = 'none';
        } else if (data.auth && data.auth.step && data.auth.step !== 'idle' && data.auth.step !== 'done') {
            if (dot) dot.className = 'status-dot connecting';
            if (label) { label.textContent = `Auth: ${data.auth.step}`; label.style.color = 'var(--accent-amber)'; }
            renderBotAuthStep(data.auth);
        } else if (data.connecting) {
            if (dot) dot.className = 'status-dot connecting';
            if (label) { label.textContent = 'Connecting...'; label.style.color = 'var(--accent-amber)'; }
        } else {
            if (dot) dot.className = 'status-dot offline';
            if (label) { label.textContent = 'Disconnected'; label.style.color = 'var(--accent-rose)'; }
        }
    } catch {}
}

function renderBotAuthStep(auth) {
    const wizardArea = document.getElementById('botAuthWizardArea');
    if (!wizardArea) return;

    wizardArea.style.display = 'block';
    const step = auth.step;

    if (step === 'need_phone') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card">
                <h3>Phone Number</h3>
                <p style="font-size: 12px; color: var(--text-secondary);">Enter international format (+1234567890)</p>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <input type="text" id="botPhoneInput" class="form-input" placeholder="+1234567890" style="flex: 1;">
                    <button class="btn-primary-action" onclick="submitBotPhone()">Next</button>
                </div>
            </div>
        `;
    } else if (step === 'need_code') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card">
                <h3>Telegram Code</h3>
                <p style="font-size: 12px; color: var(--text-secondary);">Enter the code from your Telegram app</p>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <input type="text" id="botCodeInput" class="form-input" placeholder="12345" style="flex: 1;">
                    <button class="btn-primary-action" onclick="submitBotCode()">Verify</button>
                </div>
            </div>
        `;
    } else if (step === 'need_password') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card">
                <h3>2FA Password</h3>
                <p style="font-size: 12px; color: var(--text-secondary);">Enter your Telegram 2FA cloud password</p>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <input type="password" id="botPasswordInput" class="form-input" placeholder="Password" style="flex: 1;">
                    <button class="btn-primary-action" onclick="submitBotPassword()">Sign In</button>
                </div>
            </div>
        `;
    }
}

async function startBotReconnect() {
    showToast('Starting reconnect...', 'info');
    try {
        const res = await fetch('/api/bot/reconnect', { method: 'POST', credentials: 'include' });
        const data = await res.json();
        if (data.success && data.message === 'Already connected') {
            showToast('Bot already connected', 'success');
        } else {
            checkBotStatus();
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitBotPhone() {
    const input = document.getElementById('botPhoneInput');
    if (!input || !input.value.trim()) return;
    try {
        await fetch('/api/bot/auth/phone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ phone: input.value.trim() })
        });
        checkBotStatus();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitBotCode() {
    const input = document.getElementById('botCodeInput');
    if (!input || !input.value.trim()) return;
    try {
        await fetch('/api/bot/auth/code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ code: input.value.trim() })
        });
        checkBotStatus();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitBotPassword() {
    const input = document.getElementById('botPasswordInput');
    if (!input || !input.value.trim()) return;
    try {
        await fetch('/api/bot/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ password: input.value.trim() })
        });
        checkBotStatus();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ==========================================================================
// ADMIN USER MANAGEMENT
// ==========================================================================
async function loadAdminUsers() {
    const tableBody = document.getElementById('adminUsersTableBody');
    if (!tableBody) return;

    try {
        const res = await fetch('/api/admin/users', { credentials: 'include' });
        const data = await res.json();
        if (!data.users || data.users.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted);">No users found</td></tr>`;
            return;
        }

        tableBody.innerHTML = data.users.map(u => `
            <tr>
                <td style="font-weight: 600; color: #fff;">${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.email)}</td>
                <td><span class="chip ${u.role === 'admin' ? 'best' : 'quality'}">${escapeHtml(u.role)}</span></td>
                <td style="color: var(--text-secondary); font-size: 11.5px;">${new Date(u.createdAt).toLocaleDateString()}</td>
                <td>
                    ${u.id !== state.user.id ? `
                        <button class="btn-header" style="color: var(--accent-rose); padding: 3px 6px;" onclick="deleteAdminUser(${u.id})">
                            Delete
                        </button>
                    ` : '<span style="font-size: 11px; color: var(--text-muted);">Self</span>'}
                </td>
            </tr>
        `).join('');
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--accent-rose);">Failed to load</td></tr>`;
    }
}

async function addAdminUser() {
    const name = document.getElementById('adminNewName')?.value.trim();
    const email = document.getElementById('adminNewEmail')?.value.trim();
    const password = document.getElementById('adminNewPass')?.value.trim();
    const role = document.getElementById('adminNewRole')?.value || 'user';

    if (!name || !email || !password) {
        showToast('Please fill all fields', 'error');
        return;
    }

    try {
        const res = await fetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name, email, password, role })
        });
        const data = await res.json();
        if (data.success) {
            showToast('User created', 'success');
            document.getElementById('adminNewName').value = '';
            document.getElementById('adminNewEmail').value = '';
            document.getElementById('adminNewPass').value = '';
            loadAdminUsers();
        } else {
            showToast(data.error || 'Failed to add user', 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function deleteAdminUser(id) {
    if (!confirm('Delete this user?')) return;
    try {
        const res = await fetch(`/api/admin/users/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const data = await res.json();
        if (data.success) {
            showToast('User deleted', 'success');
            loadAdminUsers();
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ==========================================================================
// AUTH & LOGOUT
// ==========================================================================
async function logoutUser() {
    try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        location.href = '/login';
    } catch {
        location.href = '/login';
    }
}

// ==========================================================================
// INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
        });

        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    const studioInput = document.getElementById('studioSearchInput');
    if (studioInput) {
        studioInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') performStudioSearch();
        });
    }

    loadChatSessions();
    checkBotStatus();
    setInterval(checkBotStatus, 20000);
    initWebSocket();
});

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

function getLanguageTag(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (/\b(hindi|hin|hindi-dubbed|dubbed\s*in\s*hindi|hindi\s*dub|hindi\s*clean|clean\s*hindi|org\s*hindi|hindi\s*org|dd5\.1\s*hindi|hq\s*hindi)\b/i.test(lower) ||
        /\[(?:hin|hindi)[-+_\s/][^\]]+\]/i.test(lower) ||
        /\[[^\]]+[-+_\s/](?:hin|hindi)\]/i.test(lower) ||
        /\b(hin-eng|eng-hin|hin-tam|tam-hin|hin-tel|tel-hin|hin-kan|kan-hin)\b/i.test(lower)) {
        return { type: 'lang-hindi', label: '🇮🇳 HINDI' };
    }
    if (/\b(bengali|bangla|ben|beng)\b/i.test(lower) || /\[(?:ben|bengali|bangla)[-+_\s/][^\]]+\]/i.test(lower) || /\b(ben-eng|eng-ben|hin-ben|ben-hin)\b/i.test(lower)) {
        return { type: 'lang-bengali', label: '🇧🇩 BENGALI' };
    }
    if (/\b(dual|dual-audio|dual\s*audio|multi|multi-audio|multi\s*audio|tri-audio)\b/i.test(lower) || /\[(?:dual|multi)[^\]]*\]/i.test(lower)) {
        return { type: 'lang-dual', label: '🌐 DUAL AUDIO' };
    }
    if (/\b(malayalam|malay|mal)\b/i.test(lower)) return { type: 'lang-other', label: 'MALAYALAM' };
    if (/\b(telugu|tel)\b/i.test(lower)) return { type: 'lang-other', label: 'TELUGU' };
    if (/\b(tamil|tam)\b/i.test(lower)) return { type: 'lang-other', label: 'TAMIL' };
    if (/\b(kannada|kan)\b/i.test(lower)) return { type: 'lang-other', label: 'KANNADA' };
    if (/\b(punjabi|panjabi)\b/i.test(lower)) return { type: 'lang-other', label: 'PUNJABI' };
    if (/\b(marathi|mar)\b/i.test(lower)) return { type: 'lang-other', label: 'MARATHI' };
    if (/\b(korean|kor)\b/i.test(lower)) return { type: 'lang-other', label: 'KOREAN' };
    if (/\b(japanese|jap)\b/i.test(lower)) return { type: 'lang-other', label: 'JAPANESE' };
    if (/\b(chinese|chi)\b/i.test(lower)) return { type: 'lang-other', label: 'CHINESE' };
    if (/\b(spanish|spa)\b/i.test(lower)) return { type: 'lang-other', label: 'SPANISH' };
    if (/\b(french|fre)\b/i.test(lower)) return { type: 'lang-other', label: 'FRENCH' };
    if (/\b(russian|rus)\b/i.test(lower)) return { type: 'lang-other', label: 'RUSSIAN' };
    if (/\b(english|eng)\b/i.test(lower)) return { type: 'lang-eng', label: 'ENGLISH' };
    return null;
}

// ==========================================================================
// BEAUTIFUL MODAL & CONFIRMATION DIALOGS
// ==========================================================================
function showConfirmModal({
    title = 'Confirm Action',
    message = 'Are you sure you want to proceed?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    type = 'danger'
} = {}) {
    return new Promise((resolve) => {
        const existing = document.getElementById('appConfirmModal');
        if (existing) existing.remove();

        const iconSvg = type === 'danger'
            ? `<svg class="tabler-icon" style="width:22px;height:22px;" viewBox="0 0 24 24"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>`
            : type === 'warning'
            ? `<svg class="tabler-icon" style="width:22px;height:22px;" viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M5 19h14a2 2 0 0 0 1.84 -2.75l-7.1 -12.25a2 2 0 0 0 -3.5 0l-7.1 12.25a2 2 0 0 0 1.75 2.75"/></svg>`
            : `<svg class="tabler-icon" style="width:22px;height:22px;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12.01" y2="8"/><polyline points="11 12 12 12 12 16 13 16"/></svg>`;

        const backdrop = document.createElement('div');
        backdrop.id = 'appConfirmModal';
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML = `
            <div class="modal-card" role="dialog" aria-modal="true">
                <div class="modal-icon-badge ${type}">
                    ${iconSvg}
                </div>
                <div class="modal-title">${escapeHtml(title)}</div>
                <div class="modal-message">${escapeHtml(message)}</div>
                <div class="modal-actions">
                    ${cancelText ? `<button type="button" class="btn-modal-cancel" id="btnModalCancel">${escapeHtml(cancelText)}</button>` : ''}
                    <button type="button" class="btn-modal-confirm ${type === 'danger' ? 'danger' : 'primary'}" id="btnModalConfirm">${escapeHtml(confirmText)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        requestAnimationFrame(() => {
            backdrop.classList.add('active');
            document.getElementById('btnModalConfirm')?.focus();
        });

        const cleanup = (result) => {
            backdrop.classList.remove('active');
            window.removeEventListener('keydown', handleKey);
            setTimeout(() => backdrop.remove(), 200);
            resolve(result);
        };

        const handleKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                cleanup(false);
            }
        };
        window.addEventListener('keydown', handleKey);

        document.getElementById('btnModalCancel')?.addEventListener('click', () => cleanup(false));
        document.getElementById('btnModalConfirm')?.addEventListener('click', () => cleanup(true));
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) cleanup(false);
        });
    });
}

function showAlertModal({
    title = 'Notice',
    message = '',
    confirmText = 'Got It',
    type = 'info'
} = {}) {
    return showConfirmModal({
        title,
        message,
        confirmText,
        cancelText: '',
        type
    });
}

// ==========================================================================
// ==========================================================================
// NAVIGATION & ROUTING CONTROLLER
// ==========================================================================
const VIEW_ROUTES = {
    chat: '/',
    releases: '/releases',
    downloads: '/download',
    requested: '/request',
    jellyfin: '/jellyfin',
    bot: '/telegram',
    admin: '/user',
    studio: '/studio'
};

const VIEW_TITLES = {
    chat: 'AI Copilot Assistant',
    releases: 'New OTT Releases (Bollywood & South Indian)',
    downloads: 'Download Station',
    requested: 'Requested Media Hub',
    jellyfin: 'Jellyfin Media Hub',
    bot: 'Telegram Bot',
    admin: 'User Management',
    studio: 'Search & Discover Studio'
};

function getViewForPath(pathname) {
    const p = (pathname || window.location.pathname || '/').toLowerCase();
    if (p.startsWith('/releases') || p.startsWith('/new-releases') || p.startsWith('/ott')) return 'releases';
    if (p.startsWith('/download') || p.startsWith('/downlaod')) return 'downloads';
    if (p.startsWith('/request')) return 'requested';
    if (p.startsWith('/jellyfin')) return 'jellyfin';
    if (p.startsWith('/telegram') || p.startsWith('/bot')) return 'bot';
    if (p.startsWith('/user') || p.startsWith('/users') || p.startsWith('/admin')) return 'admin';
    if (p.startsWith('/studio') || p.startsWith('/search')) return 'studio';
    return 'chat';
}

function switchView(viewName, updateHistory = true) {
    state.currentView = viewName;

    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.view === viewName);
    });

    document.querySelectorAll('.view-container').forEach(container => {
        container.classList.toggle('active', container.id === `view-${viewName}`);
    });

    const titleEl = document.getElementById('headerViewTitle');
    if (titleEl) {
        titleEl.textContent = VIEW_TITLES[viewName] || 'Dashboard';
    }
    document.title = `CineGrab - ${VIEW_TITLES[viewName] || 'Studio'}`;

    if (updateHistory) {
        const targetPath = VIEW_ROUTES[viewName] || '/';
        if (window.location.pathname !== targetPath) {
            history.pushState({ view: viewName }, '', targetPath);
        }
    }

    if (viewName === 'releases') {
        syncReleasesStateFromUrl();
        loadNewReleases(releasesState.page, false);
    }
    if (viewName === 'downloads') loadDownloadHistory();
    if (viewName === 'requested') loadRequestedMedia();
    if (viewName === 'jellyfin') {
        loadJellyfinStats();
        loadJellyfinLibrary();
    }
    if (viewName === 'admin') loadAdminUsers();
    if (viewName === 'bot') checkBotStatus();

    document.getElementById('appSidebar')?.classList.remove('open');
}

function navigateRoute(e, viewName) {
    if (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.preventDefault) e.preventDefault();
    }
    switchView(viewName, true);
}

window.addEventListener('popstate', (e) => {
    const view = (e.state && e.state.view) || getViewForPath(window.location.pathname);
    switchView(view, false);
});

function toggleSidebar() {
    document.getElementById('appSidebar')?.classList.toggle('open');
}

function closeSidebar() {
    document.getElementById('appSidebar')?.classList.remove('open');
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
        addChatDownloadInitiated(msg.jobId, msg.title);
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
    } else if (msg.type === 'download_complete') {
        const item = state.activeDownloads.get(msg.jobId);
        if (item) {
            item.status = msg.success ? 'completed' : 'failed';
            item.percent = msg.success ? 100 : item.percent;
            item.error = msg.error;
        }
        showToast(msg.success ? `Downloaded: ${msg.title}` : `Download failed: ${msg.title}`, msg.success ? 'success' : 'error');
        renderActiveDownloads();
        completeChatDownload(msg.jobId, msg.title, msg.success, msg.error);
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

    // If card count changed or layout mismatch, do full template render
    const existingCards = container.querySelectorAll('.live-progress-card');
    const needsFullRender = existingCards.length !== list.length || 
        Array.from(existingCards).some((c, i) => c.id !== `lpc-${list[i]?.jobId}`);

    if (needsFullRender) {
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
                                <span class="lpc-status-label">${isComplete ? 'Completed' : isFailed ? 'Failed' : (dl.status === 'connecting' ? 'Preparing...' : 'Downloading')}</span>
                            </div>
                        </div>
                    </div>
                    <div class="lpc-linear-progress">
                        <div class="lpc-linear-bar" style="width: ${dl.percent || 0}%;"></div>
                    </div>
                    <div class="lpc-stats-row">
                        <span class="lpc-size-label">${dl.downloaded || '0 MB'} / ${dl.total || '0 MB'}</span>
                        <span class="tabular-nums lpc-speed-label">${dl.speed || ''} ${dl.eta ? '· ETA ' + dl.eta : ''}</span>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        // Butter-smooth direct DOM mutation for 60fps real-time updates
        list.forEach(dl => {
            const card = document.getElementById(`lpc-${dl.jobId}`);
            if (!card) return;
            const circ = 125.6;
            const offset = circ * (1 - (dl.percent || 0) / 100);
            const isComplete = dl.status === 'completed';
            const isFailed = dl.status === 'failed';

            const fill = card.querySelector('.lpc-ring-fill');
            if (fill) {
                fill.className = `lpc-ring-fill ${isComplete ? 'completed' : isFailed ? 'failed' : ''}`;
                fill.style.strokeDashoffset = offset;
            }

            const pctText = card.querySelector('.lpc-percent-text');
            if (pctText) pctText.textContent = isComplete ? '✓' : isFailed ? '✕' : (dl.percent || 0) + '%';

            const bar = card.querySelector('.lpc-linear-bar');
            if (bar) bar.style.width = `${dl.percent || 0}%`;

            const statusDot = card.querySelector('.status-dot');
            if (statusDot) statusDot.className = `status-dot ${isComplete ? 'online' : isFailed ? 'offline' : 'connecting'}`;

            const statusLabel = card.querySelector('.lpc-status-label');
            if (statusLabel) statusLabel.textContent = isComplete ? 'Completed' : isFailed ? 'Failed' : (dl.status === 'connecting' ? 'Preparing...' : 'Downloading');

            const sizeLabel = card.querySelector('.lpc-size-label');
            if (sizeLabel) sizeLabel.textContent = `${dl.downloaded || '0 MB'} / ${dl.total || '0 MB'}`;

            const speedLabel = card.querySelector('.lpc-speed-label');
            if (speedLabel) speedLabel.textContent = `${dl.speed || ''} ${dl.eta ? '· ETA ' + dl.eta : ''}`;
        });
    }
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
    const safeContent = (content || '').trim();

    if (!safeContent) {
        formattedHtml = `<p style="color: var(--text-muted); font-style: italic;">⚠️ No response received. Please try again or check your bot connection.</p>`;
    } else if (sender === 'user') {
        formattedHtml = `<p>${escapeHtml(safeContent).replace(/\n/g, '<br>')}</p>`;
    } else {
        try {
            formattedHtml = typeof marked !== 'undefined' ? marked.parse(safeContent) : `<p>${escapeHtml(safeContent).replace(/\n/g, '<br>')}</p>`;
        } catch {
            formattedHtml = `<p>${escapeHtml(safeContent).replace(/\n/g, '<br>')}</p>`;
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

    let searchResultsHtml = '';
    if (meta.searchResults && Array.isArray(meta.searchResults.results) && meta.searchResults.results.length > 0) {
        const results = meta.searchResults.results;
        const total = meta.searchResults.totalResults || results.length;
        const movieTitle = meta.searchResults.title || '';
        const movieYear = meta.searchResults.year || '';
        const bestIdx = meta.searchResults.bestIdx;

        searchResultsHtml = `
            <div class="chat-search-results-panel">
                <div class="chat-search-header">
                    <span>🎬 <strong>${escapeHtml(movieTitle)}</strong> ${movieYear ? `(${escapeHtml(movieYear)})` : ''} · <strong>${total} Available Releases</strong></span>
                    <span class="chat-search-hint">Click any release below to download:</span>
                </div>
                <div class="chat-search-list">
                    ${results.map(r => {
                        const isRecommended = r.isBest || r.index === bestIdx;
                        const sizeStr = r.sizeMB >= 1024 ? `${(r.sizeMB / 1024).toFixed(2)} GB` : `${r.sizeMB} MB`;
                        const res = (r.text.match(/\\b(480p|720p|1080p|2160p|4k|400p)\\b/i) || [])[1] || 'HD';
                        const codec = (r.text.match(/\\b(hevc|x265|h265|x264|h264|avc)\\b/i) || [])[1] || '';
                        const langTag = getLanguageTag(r.text);

                        return `
                            <div class="chat-release-card ${isRecommended ? 'recommended' : ''}" onclick="handleQuickPrompt('download ${r.index}')">
                                <div class="chat-release-left">
                                    <span class="chat-release-index">#${r.index}</span>
                                    <div class="chat-release-meta">
                                        <div class="chat-release-title" title="${escapeHtml(r.text)}">${escapeHtml(r.text)}</div>
                                        <div class="chat-release-tags">
                                            ${langTag ? `<span class="badge ${langTag.type}">${langTag.label}</span>` : ''}
                                            <span class="badge res">${escapeHtml(res.toUpperCase())}</span>
                                            <span class="badge size">${sizeStr}</span>
                                            ${codec ? `<span class="badge codec">${escapeHtml(codec.toUpperCase())}</span>` : ''}
                                            ${isRecommended ? `<span class="badge rec">⭐ Recommended</span>` : ''}
                                            <span class="badge page">Page ${r.page || 1}</span>
                                        </div>
                                    </div>
                                </div>
                                <button class="btn-download-release ${isRecommended ? 'primary' : ''}" onclick="event.stopPropagation(); handleQuickPrompt('download ${r.index}')">
                                    <svg class="tabler-icon" style="width:15px;height:15px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                    Download #${r.index}
                                </button>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    row.innerHTML = `
        <div class="msg-avatar">${avatarHtml}</div>
        <div class="msg-bubble">
            ${meta.workflowChip ? `<div class="workflow-chip ${meta.workflowChip.type}">${meta.workflowChip.label}</div>` : ''}
            ${formattedHtml}
            ${searchResultsHtml}
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

function addChatDownloadInitiated(jobId, title) {
    const chatBox = document.getElementById('chatMessagesBox');
    if (!chatBox) return;

    let el = document.getElementById(`chat-dl-${jobId}`);
    const isAtBottom = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 80;

    if (!el) {
        el = document.createElement('div');
        el.id = `chat-dl-${jobId}`;
        el.className = 'message-row assistant';
        chatBox.appendChild(el);
    }

    el.innerHTML = `
        <div class="msg-avatar">${ICONS.download}</div>
        <div class="msg-bubble chat-dl-bubble" style="max-width: 480px; width: 100%;">
            <div style="font-weight: 600; font-size: 13px; color: #fff; margin-bottom: 3px;">
                🚀 Download Queued: ${escapeHtml(title)}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">
                File is downloading in the background. Check live speed, progress, and logs in the Download Station.
            </div>
            <a href="/download" class="btn-chat-station-link" onclick="navigateRoute(event, 'downloads')">
                <svg class="tabler-icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                <span>Go to Download Station ➔</span>
            </a>
        </div>
    `;

    if (isAtBottom) chatBox.scrollTop = chatBox.scrollHeight;
}

function completeChatDownload(jobId, title, success, error) {
    const el = document.getElementById(`chat-dl-${jobId}`);
    if (!el) return;
    el.innerHTML = `
        <div class="msg-avatar">${success ? ICONS.success : ICONS.error}</div>
        <div class="msg-bubble chat-dl-bubble" style="max-width: 480px; width: 100%;">
            <div style="font-weight: 600; font-size: 13px; color: ${success ? 'var(--accent-emerald)' : 'var(--accent-rose)'}; margin-bottom: 3px;">
                ${success ? '✅ Download Finished & Ready' : '❌ Download Failed'}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 10px;">${escapeHtml(title)}</div>
            ${error ? `<div style="font-size: 11.5px; color: var(--accent-rose); margin-bottom: 10px;">${escapeHtml(error)}</div>` : ''}
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <a href="/download" class="btn-chat-station-link" onclick="navigateRoute(event, 'downloads')">
                    <svg class="tabler-icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                    <span>View Download Station</span>
                </a>
                ${success ? `
                <a href="/jellyfin" class="btn-chat-station-link" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.4);" onclick="navigateRoute(event, 'jellyfin')">
                    <svg class="tabler-icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                    <span>Jellyfin Library</span>
                </a>` : ''}
            </div>
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

        if (!response.ok || data.error) {
            const errText = data.error || `Server error (${response.status})`;
            addChatMessage(`⚠️ ${errText}`, 'assistant');
        } else {
            const replyText = data.reply || 'Done processing your request!';
            let searchResults = null;
            if (data.toolCalls && Array.isArray(data.toolCalls)) {
                const sCall = data.toolCalls.find(tc => tc.tool === 'search_movie' && tc.result?.data?.results?.length > 0);
                if (sCall) {
                    searchResults = sCall.result.data;
                }
            }

            addChatMessage(replyText, 'assistant', { searchResults });
            state.chatHistory.push({ role: 'assistant', content: replyText });
            saveChatSession(text, replyText);
        }
    } catch (err) {
        removeTypingIndicator();
        addChatMessage(`⚠️ Connection error: ${err.message}. Please check your bot connection and try again.`, 'assistant');
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
                    ${ICONS.movie}
                </div>
                <h2>Search Movies to add on movie.pallabdev.in</h2>
                <p>Type any movie title to check releases and download directly to your streaming server.</p>
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

function setStudioType(type = 'movie') {
    studioSearchType = 'movie';
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
        showToast('Please enter a movie title', 'error');
        return;
    }

    btn.disabled = true;
    resultsArea.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-secondary);">
            <div class="typing-dot" style="display: inline-block; width: 6px; height: 6px; margin: 0 3px;"></div>
            <div class="typing-dot" style="display: inline-block; width: 6px; height: 6px; margin: 0 3px;"></div>
            <div class="typing-dot" style="display: inline-block; width: 6px; height: 6px; margin: 0 3px;"></div>
            <div style="margin-top: 10px; font-size: 12.5px;">Searching movie releases...</div>
        </div>
    `;

    try {
        const response = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ title, type: 'movie', year })
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
                            <div class="chip jellyfin" style="margin-top: 4px;">Already in Jellyfin Movie Library</div>
                        </div>
                    </div>
                </div>
            `;
            return;
        }

        if (data.status === 'no_results' || !data.results || data.results.length === 0) {
            resultsArea.innerHTML = `
                <div style="text-align: center; padding: 30px; color: var(--text-muted);">
                    <div style="font-size: 13px; font-weight: 600; color: #fff;">No movie releases found</div>
                    <div style="font-size: 12px; margin-top: 2px;">Try adjusting the title or query.</div>
                </div>
            `;
            return;
        }

        state.searchResultSession = data.searchId;
        renderMovieStudioResults(data, resultsArea);
    } catch (err) {
        resultsArea.innerHTML = `<div class="auth-error-alert" style="display: block;">Search error: ${escapeHtml(err.message)}</div>`;
    } finally {
        btn.disabled = false;
    }
}

function renderMovieStudioResults(data, container) {
    const results = data.results || [];
    const total = results.length;
    const movieTitle = data.title || '';
    const movieYear = data.year || '';
    const bestIdx = data.bestIdx;

    container.innerHTML = `
        <div class="chat-search-results-panel studio-panel-wrap">
            <div class="chat-search-header">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
                    <span>🎬 <strong>${escapeHtml(movieTitle)}</strong> ${movieYear ? `(${escapeHtml(movieYear)})` : ''} · <strong>${total} Available Releases</strong></span>
                    <span class="chip best">${total} Found</span>
                </div>
                <span class="chat-search-hint">Click any release below to download directly to your streaming server:</span>
            </div>
            <div class="chat-search-list">
                ${results.map((r, i) => {
                    const optIndex = r.index || (i + 1);
                    const isRecommended = r.isBest || optIndex === (bestIdx + 1) || optIndex === bestIdx || (i === bestIdx);
                    const sizeStr = r.sizeMB >= 1024 ? `${(r.sizeMB / 1024).toFixed(2)} GB` : `${Number(r.sizeMB).toFixed(0)} MB`;
                    const res = (r.text.match(/\\b(480p|720p|1080p|2160p|4k|400p)\\b/i) || [])[1] || 'HD';
                    const codec = (r.text.match(/\\b(hevc|x265|h265|x264|h264|avc)\\b/i) || [])[1] || '';
                    const langTag = getLanguageTag(r.text);

                    return `
                        <div class="chat-release-card ${isRecommended ? 'recommended' : ''}" onclick="triggerStudioMovieDownload('${escapeHtml(r.text).replace(/'/g, "\\'")}')">
                            <div class="chat-release-left">
                                <span class="chat-release-index">#${optIndex}</span>
                                <div class="chat-release-meta">
                                    <div class="chat-release-title" title="${escapeHtml(r.text)}">${escapeHtml(r.text)}</div>
                                    <div class="chat-release-tags">
                                        ${langTag ? `<span class="badge ${langTag.type}">${langTag.label}</span>` : ''}
                                        <span class="badge res">${escapeHtml(res.toUpperCase())}</span>
                                        <span class="badge size">${sizeStr}</span>
                                        ${codec ? `<span class="badge codec">${escapeHtml(codec.toUpperCase())}</span>` : ''}
                                        ${isRecommended ? `<span class="badge rec">⭐ Recommended</span>` : ''}
                                        <span class="badge page">Page ${r.page || 1}</span>
                                    </div>
                                </div>
                            </div>
                            <button class="btn-download-release ${isRecommended ? 'primary' : ''}" onclick="event.stopPropagation(); triggerStudioMovieDownload('${escapeHtml(r.text).replace(/'/g, "\\'")}')">
                                <svg class="tabler-icon" style="width:15px;height:15px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                Download #${optIndex}
                            </button>
                        </div>
                    `;
                }).join('')}
            </div>
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
            if (data.warning) {
                showToast(data.warning, 'warning', 6000);
            } else {
                showToast('Download started', 'success');
            }
            switchView('downloads');
        } else {
            showToast(data.error || 'Failed to start download', 'error', 6000);
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
// DOWNLOAD STATION & CONTROLS
// ==========================================================================
async function loadDownloadHistory(page = 1) {
    const tableBody = document.getElementById('downloadHistoryTableBody');
    if (!tableBody) return;

    try {
        const res = await fetch(`/api/downloads?page=${page}&limit=20`, {
            credentials: 'include'
        });
        const data = await res.json();
        fetchQueueStats();

        if (!data.downloads || data.downloads.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align:center; padding: 48px 20px;">
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;">
                            <div style="width: 52px; height: 52px; border-radius: 50%; background: var(--bg-surface-elevated); border: 1px solid var(--border-medium); display: flex; align-items: center; justify-content: center; color: var(--accent-cyan);">
                                <svg class="tabler-icon" style="width:26px;height:26px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                            </div>
                            <div>
                                <div style="font-size: 15px; font-weight: 600; color: #fff;">No Download History</div>
                                <div style="font-size: 12.5px; color: var(--text-secondary); max-width: 380px; margin: 4px auto 14px; line-height: 1.5;">
                                    You have not started any downloads yet. Ask Copilot to find a movie or TV season pack.
                                </div>
                                <button class="btn-primary-action" onclick="switchView('chat')" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; font-size: 12.5px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>
                                    Search with Copilot
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        tableBody.innerHTML = data.downloads.map(item => {
            const isDownloading = item.status === 'downloading' || item.status === 'clicking';
            const isPaused = item.status === 'paused';
            const isFailed = item.status === 'failed';
            const isCompleted = item.status === 'completed';

            let actionButtons = '';
            if (isDownloading) {
                actionButtons = `
                    <button class="btn-header" style="color: var(--accent-amber); padding: 3px 7px;" onclick="pauseDownload('${item.requestId}')" title="Pause Download">
                        Pause
                    </button>
                    <button class="btn-header" style="color: var(--accent-rose); padding: 3px 7px;" onclick="cancelDownload('${item.requestId}')" title="Cancel & Delete">
                        Cancel
                    </button>
                `;
            } else if (isPaused) {
                actionButtons = `
                    <button class="btn-header" style="color: var(--accent-emerald); padding: 3px 7px;" onclick="resumeDownload('${item.requestId}')" title="Resume Download">
                        Resume
                    </button>
                    <button class="btn-header" style="color: var(--accent-rose); padding: 3px 7px;" onclick="cancelDownload('${item.requestId}')" title="Cancel & Delete">
                        Delete
                    </button>
                `;
            } else if (isFailed) {
                actionButtons = `
                    <button class="btn-header" style="color: var(--accent-blue); padding: 3px 7px;" onclick="retryDownload('${item.requestId}')" title="Retry Download">
                        Retry
                    </button>
                    <button class="btn-header" style="color: var(--accent-rose); padding: 3px 7px;" onclick="cancelDownload('${item.requestId}')" title="Delete">
                        Delete
                    </button>
                `;
            } else {
                actionButtons = `
                    <button class="btn-header" style="color: var(--text-muted); padding: 3px 7px;" onclick="cancelDownload('${item.requestId}')" title="Remove Entry">
                        Delete
                    </button>
                `;
            }

            return `
                <tr>
                    <td style="font-weight: 600; color: #fff;">${escapeHtml(item.title)}</td>
                    <td><span class="chip ${item.type === 'movie' ? 'quality' : 'best'}">${escapeHtml(item.type)}</span></td>
                    <td>${escapeHtml(item.fileSize || 'N/A')}</td>
                    <td>
                        <span class="status-badge ${item.status}">
                            <span class="status-dot ${isCompleted ? 'online' : isFailed ? 'offline' : isPaused ? 'paused' : 'connecting'}"></span>
                            ${escapeHtml(item.status)}
                        </span>
                    </td>
                    <td style="color: var(--text-secondary); font-size: 11.5px;">${new Date(item.createdAt).toLocaleDateString()} ${new Date(item.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
                    <td style="text-align: right; white-space: nowrap;">
                        <div style="display: inline-flex; gap: 4px;">${actionButtons}</div>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--accent-rose);">Failed to load</td></tr>`;
    }
}

async function pauseDownload(requestId) {
    try {
        const res = await fetch(`/api/downloads/${requestId}/pause`, { method: 'POST', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Download paused', 'info');
            loadDownloadHistory();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function resumeDownload(requestId) {
    try {
        const res = await fetch(`/api/downloads/${requestId}/resume`, { method: 'POST', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Download resumed', 'success');
            loadDownloadHistory();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function retryDownload(requestId) {
    try {
        const res = await fetch(`/api/downloads/${requestId}/retry`, { method: 'POST', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Download retry queued', 'info');
            loadDownloadHistory();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function cancelDownload(requestId) {
    const confirmed = await showConfirmModal({
        title: 'Remove Download Entry',
        message: 'Are you sure you want to remove this download entry from the list?',
        confirmText: 'Remove Entry',
        type: 'danger'
    });
    if (!confirmed) return;
    try {
        const res = await fetch(`/api/downloads/${requestId}`, { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Download removed', 'info');
            loadDownloadHistory();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function clearFailedDownloads() {
    const confirmed = await showConfirmModal({
        title: 'Clear Failed Downloads',
        message: 'Are you sure you want to remove all failed download records?',
        confirmText: 'Clear Failed',
        type: 'warning'
    });
    if (!confirmed) return;
    try {
        const res = await fetch('/api/downloads/clear/failed', { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Cleared failed downloads', 'info');
            loadDownloadHistory();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function clearAllDownloads() {
    const confirmed = await showConfirmModal({
        title: 'Clear Download History',
        message: 'This will remove all completed, failed, and cancelled downloads from your history. Active downloads will not be affected.',
        confirmText: 'Clear All',
        type: 'danger'
    });
    if (!confirmed) return;
    try {
        const res = await fetch('/api/downloads/clear/all', { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Cleared download history', 'info');
            loadDownloadHistory();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ==========================================================================
// REQUESTED MEDIA LIST
// ==========================================================================
async function loadRequestedMedia() {
    const tableBody = document.getElementById('requestedMediaTableBody');
    if (!tableBody) return;

    try {
        const res = await fetch('/api/requested-media', { credentials: 'include' });
        const data = await res.json();
        const items = data.items || [];

        if (items.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align:center; padding: 48px 20px;">
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;">
                            <div style="width: 52px; height: 52px; border-radius: 50%; background: var(--bg-surface-elevated); border: 1px solid var(--border-medium); display: flex; align-items: center; justify-content: center; color: var(--accent-blue);">
                                <svg class="tabler-icon" style="width:26px;height:26px;" viewBox="0 0 24 24"><path d="M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12z"/><path d="M19 16h-12a2 2 0 0 0 -2 2"/><path d="M9 8h6"/></svg>
                            </div>
                            <div>
                                <div style="font-size: 15px; font-weight: 600; color: #fff;">No Requested Media Yet</div>
                                <div style="font-size: 12.5px; color: var(--text-secondary); max-width: 380px; margin: 4px auto 14px; line-height: 1.5;">
                                    Search or ask AI Copilot for any movie or TV show, and your requests will automatically be tracked here.
                                </div>
                                <button class="btn-primary-action" onclick="switchView('chat')" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; font-size: 12.5px;">
                                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>
                                    Go to AI Copilot
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        tableBody.innerHTML = items.map(item => `
            <tr>
                <td style="font-weight: 600; color: #fff;">${escapeHtml(item.title)}</td>
                <td><span class="chip ${item.type === 'movie' ? 'quality' : 'best'}">${escapeHtml(item.type)}</span></td>
                <td>${escapeHtml(item.year || 'N/A')}</td>
                <td>
                    <span class="status-badge ${item.status}">
                        <span class="status-dot online"></span>
                        ${escapeHtml(item.status)}
                    </span>
                </td>
                <td style="color: var(--text-secondary); font-size: 11.5px;">${new Date(item.createdAt).toLocaleDateString()} ${new Date(item.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</td>
                <td style="text-align: right;">
                    <button class="btn-header" style="color: var(--accent-rose); padding: 3px 8px;" onclick="deleteRequestedMedia(${item.id})">
                        Delete
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--accent-rose);">Failed to load</td></tr>`;
    }
}

async function deleteRequestedMedia(id) {
    const confirmed = await showConfirmModal({
        title: 'Remove Request',
        message: 'Are you sure you want to remove this media request?',
        confirmText: 'Remove',
        type: 'danger'
    });
    if (!confirmed) return;
    try {
        const res = await fetch(`/api/requested-media/${id}`, { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Entry removed', 'info');
            loadRequestedMedia();
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function clearAllRequestedMedia() {
    const confirmed = await showConfirmModal({
        title: 'Clear Requested Media',
        message: 'Are you sure you want to clear all tracked requested movies and series?',
        confirmText: 'Clear Requests',
        type: 'danger'
    });
    if (!confirmed) return;
    try {
        const res = await fetch('/api/requested-media/clear', { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.success) {
            showToast('Cleared all requested media', 'info');
            loadRequestedMedia();
        }
    } catch (e) {
        showToast(e.message, 'error');
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
        const moviesEl = document.getElementById('jfMoviesCount');
        if (moviesEl) moviesEl.textContent = data.movies ?? '--';
    } catch {}
}

async function loadJellyfinLibrary(force = false) {
    const grid = document.getElementById('jfMoviesGrid');
    if (!grid) return;

    if (force) {
        grid.innerHTML = `
            <div style="text-align: center; color: var(--text-muted); padding: 40px; width: 100%; grid-column: 1 / -1;">
                <div class="spinner" style="margin: 0 auto 12px; width: 28px; height: 28px; border: 2px solid var(--border-medium); border-top-color: var(--accent-cyan); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                Refreshing Jellyfin Movie Library...
            </div>
        `;
    }

    try {
        const res = await fetch('/api/jellyfin/movies', { credentials: 'include' });
        const data = await res.json();
        const movies = data.items || [];

        if (movies.length === 0) {
            grid.innerHTML = `
                <div style="text-align: center; color: var(--text-muted); padding: 48px 20px; width: 100%; grid-column: 1 / -1;">
                    <div style="width: 52px; height: 52px; border-radius: 50%; background: var(--bg-surface-elevated); border: 1px solid var(--border-medium); display: flex; align-items: center; justify-content: center; color: var(--accent-cyan); margin: 0 auto 12px;">
                        <svg class="tabler-icon" style="width:26px;height:26px;" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                    </div>
                    <div style="font-size: 15px; font-weight: 600; color: #fff;">No Movies Found</div>
                    <div style="font-size: 12.5px; color: var(--text-secondary); margin-top: 4px;">Your Jellyfin server reports 0 movies or is still indexing.</div>
                </div>
            `;
            return;
        }

        grid.innerHTML = movies.map(movie => {
            const year = movie.ProductionYear || movie.Year || (movie.PremiereDate ? new Date(movie.PremiereDate).getFullYear() : '');
            const rating = movie.CommunityRating ? Number(movie.CommunityRating).toFixed(1) : null;
            const posterUrl = `/api/jellyfin/image/${movie.Id}`;

            return `
                <div class="jf-movie-card" title="${escapeHtml(movie.Name)}${year ? ` (${year})` : ''}">
                    <div class="jf-movie-poster-wrap">
                        <img class="jf-movie-poster" 
                             src="${posterUrl}" 
                             alt="${escapeHtml(movie.Name)}" 
                             loading="lazy" 
                             onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
                        <div class="jf-movie-poster-fallback" style="display: none;">
                            <svg class="tabler-icon" style="width:28px;height:28px;" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4l0 16"/><path d="M16 4l0 16"/><path d="M4 8l4 0"/><path d="M4 16l4 0"/><path d="M4 12l16 0"/><path d="M16 8l4 0"/><path d="M16 16l4 0"/></svg>
                            <span style="font-size: 11px; font-weight: 600; line-height: 1.3;">${escapeHtml(movie.Name)}</span>
                        </div>
                        ${rating ? `<div class="jf-movie-rating-badge">★ ${rating}</div>` : ''}
                    </div>
                    <div class="jf-movie-info">
                        <div class="jf-movie-title">${escapeHtml(movie.Name)}</div>
                        <div class="jf-movie-meta">
                            <span>${year || 'Movie'}</span>
                            <span class="chip quality" style="font-size: 10px; padding: 1px 6px;">Library</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) {
        grid.innerHTML = `
            <div style="text-align: center; color: var(--accent-rose); padding: 40px; width: 100%; grid-column: 1 / -1;">
                Failed to load Jellyfin movies library: ${escapeHtml(err.message)}
            </div>
        `;
    }
}

async function checkJellyfinItem() {
    const input = document.getElementById('jfCheckInput');
    const resultBox = document.getElementById('jfCheckResultBox');
    if (!input || !resultBox) return;

    const title = input.value.trim();
    if (!title) return;

    resultBox.style.display = 'block';
    resultBox.innerHTML = '<span class="text-muted">Checking movie library...</span>';

    try {
        const res = await fetch(`/api/jellyfin/check?type=movie&title=${encodeURIComponent(title)}`, { credentials: 'include' });
        const data = await res.json();
        if (data.exists) {
            resultBox.innerHTML = `
                <div style="color: var(--accent-emerald); font-weight: 600; display: flex; align-items: center; gap: 6px;">
                    <svg class="tabler-icon text-emerald" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                    "${escapeHtml(title)}" is in your Jellyfin Movie Library.
                </div>
            `;
        } else {
            resultBox.innerHTML = `
                <div style="color: var(--text-secondary); display: flex; align-items: center; gap: 6px;">
                    <svg class="tabler-icon text-blue" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12.01" y2="8"/><polyline points="11 12 12 12 12 16 13 16"/></svg>
                    "${escapeHtml(title)}" is not in your Jellyfin Movie Library.
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
        const centerDot = document.getElementById('botCenterStatusDot');
        const centerDetail = document.getElementById('botCenterStatusDetail');
        const wizardArea = document.getElementById('botAuthWizardArea');

        if (data.connected) {
            if (dot) dot.className = 'status-dot online';
            if (label) { label.textContent = 'Connected'; label.style.color = 'var(--accent-emerald)'; }
            if (centerDot) centerDot.className = 'status-dot online';
            if (centerDetail) centerDetail.innerHTML = '<span style="color:var(--accent-emerald); font-weight:600;">Active & Connected</span> (MTProto Client)';
            if (wizardArea) { wizardArea.style.display = 'none'; wizardArea.innerHTML = ''; }
        } else if (data.auth && data.auth.step && data.auth.step !== 'idle' && data.auth.step !== 'done') {
            if (dot) dot.className = 'status-dot connecting';
            if (label) { label.textContent = `Auth: ${data.auth.step}`; label.style.color = 'var(--accent-amber)'; }
            if (centerDot) centerDot.className = 'status-dot connecting';
            if (centerDetail) centerDetail.innerHTML = `<span style="color:var(--accent-amber); font-weight:600;">Authenticating... (${data.auth.step})</span>`;
            renderBotAuthStep(data.auth);
        } else if (data.connecting) {
            if (dot) dot.className = 'status-dot connecting';
            if (label) { label.textContent = 'Connecting...'; label.style.color = 'var(--accent-amber)'; }
            if (centerDot) centerDot.className = 'status-dot connecting';
            if (centerDetail) centerDetail.innerHTML = '<span style="color:var(--accent-amber);">Connecting to Telegram...</span>';
            if (wizardArea) { wizardArea.style.display = 'none'; }
        } else {
            if (dot) dot.className = 'status-dot offline';
            if (label) { label.textContent = 'Disconnected'; label.style.color = 'var(--accent-rose)'; }
            if (centerDot) centerDot.className = 'status-dot offline';
            if (centerDetail) centerDetail.innerHTML = '<span style="color:var(--accent-rose);">Disconnected. Click Reconnect to link session.</span>';
            if (wizardArea) { wizardArea.style.display = 'none'; }
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
                    <input type="text" id="botPhoneInput" class="form-input" placeholder="+1234567890" style="flex: 1;" onkeydown="if(event.key==='Enter') submitBotPhone()">
                    <button class="btn-primary-action" onclick="submitBotPhone()">Next</button>
                </div>
            </div>
        `;
        setTimeout(() => document.getElementById('botPhoneInput')?.focus(), 100);
    } else if (step === 'need_code') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card">
                <h3>Telegram Code</h3>
                <p style="font-size: 12px; color: var(--text-secondary);">Enter the verification code received on your Telegram app</p>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <input type="text" id="botCodeInput" class="form-input" placeholder="12345" style="flex: 1;" onkeydown="if(event.key==='Enter') submitBotCode()">
                    <button class="btn-primary-action" onclick="submitBotCode()">Verify</button>
                </div>
            </div>
        `;
        setTimeout(() => document.getElementById('botCodeInput')?.focus(), 100);
    } else if (step === 'need_password') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card">
                <h3>2FA Cloud Password</h3>
                <p style="font-size: 12px; color: var(--text-secondary);">Enter your Telegram Two-Step Verification cloud password</p>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <input type="password" id="botPasswordInput" class="form-input" placeholder="Password" style="flex: 1;" onkeydown="if(event.key==='Enter') submitBotPassword()">
                    <button class="btn-primary-action" onclick="submitBotPassword()">Sign In</button>
                </div>
            </div>
        `;
        setTimeout(() => document.getElementById('botPasswordInput')?.focus(), 100);
    } else if (step === 'authenticating') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card">
                <h3 style="color: var(--accent-amber);">Authenticating...</h3>
                <p style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">Communicating with Telegram servers...</p>
            </div>
        `;
    } else if (step === 'error') {
        wizardArea.innerHTML = `
            <div class="auth-wizard-card" style="border: 1px solid var(--accent-rose);">
                <h3 style="color: var(--accent-rose);">Authentication Error</h3>
                <p style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${escapeHtml(auth.error || 'Connection or authentication failed')}</p>
                <div style="margin-top: 10px;">
                    <button class="btn-primary-action" onclick="startBotReconnect()">Retry Reconnect</button>
                </div>
            </div>
        `;
    }
}

async function startBotReconnect() {
    showToast('Starting bot reconnect...', 'info');
    try {
        const res = await fetch('/api/bot/reconnect', { method: 'POST', credentials: 'include' });
        const data = await res.json();
        if (data.connected || (data.success && data.message === 'Already connected')) {
            showToast('Telegram Bot connected successfully!', 'success');
        } else if (data.error) {
            showToast(data.error, 'error');
        } else {
            showToast('Connecting to Telegram...', 'info');
        }
        await checkBotStatus();

        // Rapid polling for 15 seconds to catch connection / auth updates smoothly
        let count = 0;
        const poller = setInterval(async () => {
            count++;
            await checkBotStatus();
            if (count >= 10) clearInterval(poller);
        }, 1500);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitBotPhone() {
    const input = document.getElementById('botPhoneInput');
    if (!input || !input.value.trim()) return;
    try {
        const res = await fetch('/api/bot/auth/phone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ phone: input.value.trim() })
        });
        const data = await res.json();
        if (data.error) showToast(data.error, 'error');
        await checkBotStatus();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitBotCode() {
    const input = document.getElementById('botCodeInput');
    if (!input || !input.value.trim()) return;
    try {
        const res = await fetch('/api/bot/auth/code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ code: input.value.trim() })
        });
        const data = await res.json();
        if (data.error) showToast(data.error, 'error');
        await checkBotStatus();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitBotPassword() {
    const input = document.getElementById('botPasswordInput');
    if (!input || !input.value.trim()) return;
    try {
        const res = await fetch('/api/bot/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ password: input.value.trim() })
        });
        const data = await res.json();
        if (data.error) showToast(data.error, 'error');
        await checkBotStatus();
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
    const confirmed = await showConfirmModal({
        title: 'Delete User Account',
        message: 'Are you sure you want to permanently delete this user?',
        confirmText: 'Delete User',
        type: 'danger'
    });
    if (!confirmed) return;
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
// NEW INDIAN OTT RELEASES MODULE (BOLLYWOOD & SOUTH INDIAN CINEMA)
// ==========================================================================
const releasesState = {
    items: [],
    page: 1,
    totalPages: 1,
    total: 0,
    providerFilter: 'all',
    industryFilter: 'all',
    searchQuery: '',
    sortBy: 'date_desc',
    loading: false,
    refreshing: false,
    searchDebounce: null,
};

// Platform styling and brand identity map
const OTT_PLATFORMS = {
    netflix: { name: 'Netflix', color: '#E50914', bg: 'rgba(229, 9, 20, 0.15)', border: 'rgba(229, 9, 20, 0.4)' },
    'amazon prime video': { name: 'Prime Video', color: '#00A8E1', bg: 'rgba(0, 168, 225, 0.15)', border: 'rgba(0, 168, 225, 0.4)' },
    'amazon prime': { name: 'Prime Video', color: '#00A8E1', bg: 'rgba(0, 168, 225, 0.15)', border: 'rgba(0, 168, 225, 0.4)' },
    'disney+ hotstar': { name: 'Disney+ Hotstar', color: '#FFCC00', bg: 'rgba(255, 204, 0, 0.15)', border: 'rgba(255, 204, 0, 0.4)' },
    hotstar: { name: 'Hotstar', color: '#FFCC00', bg: 'rgba(255, 204, 0, 0.15)', border: 'rgba(255, 204, 0, 0.4)' },
    zee5: { name: 'Zee5', color: '#c084fc', bg: 'rgba(162, 28, 175, 0.15)', border: 'rgba(162, 28, 175, 0.4)' },
    'sony liv': { name: 'Sony LIV', color: '#818cf8', bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.4)' },
    sonyliv: { name: 'Sony LIV', color: '#818cf8', bg: 'rgba(99, 102, 241, 0.15)', border: 'rgba(99, 102, 241, 0.4)' },
    jiocinema: { name: 'JioCinema', color: '#f43f5e', bg: 'rgba(244, 63, 94, 0.15)', border: 'rgba(244, 63, 94, 0.4)' },
    youtube: { name: 'YouTube', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.4)' },
};

function getPlatformBadge(provider) {
    const rawName = (provider?.name || '').toLowerCase();
    let match = null;
    for (const key of Object.keys(OTT_PLATFORMS)) {
        if (rawName.includes(key)) {
            match = OTT_PLATFORMS[key];
            break;
        }
    }

    if (!match) {
    match = { name: provider.name || 'OTT', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: 'rgba(56, 189, 248, 0.3)' };
    }

    return `<span class="ott-badge" style="color: ${match.color}; background: ${match.bg}; border-color: ${match.border};">
        ${provider.logoUrl ? `<img src="${provider.logoUrl}" alt="${escapeHtml(match.name)}" class="ott-badge-logo" onerror="this.style.display='none'">` : ''}
        <span>${escapeHtml(match.name)}</span>
    </span>`;
}

function syncReleasesStateFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        const urlPage = parseInt(params.get('page'), 10);
        if (!isNaN(urlPage) && urlPage >= 1) {
            releasesState.page = urlPage;
        } else {
            releasesState.page = 1;
        }

        const platform = params.get('platform') || params.get('provider');
        if (platform) {
            releasesState.providerFilter = platform.toLowerCase();
        } else {
            releasesState.providerFilter = 'all';
        }

        const industry = params.get('industry');
        if (industry) {
            releasesState.industryFilter = industry.toLowerCase();
        } else {
            releasesState.industryFilter = 'all';
        }

        const sort = params.get('sort');
        if (sort) {
            releasesState.sortBy = sort;
        } else {
            releasesState.sortBy = 'date_desc';
        }

        // Sync UI form controls
        const sortSelect = document.getElementById('releasesSortSelect');
        if (sortSelect) {
            sortSelect.value = releasesState.sortBy;
        }
        document.querySelectorAll('#platformFilterPills .pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.platform === releasesState.providerFilter);
        });
        document.querySelectorAll('#industryFilterPills .pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.industry === releasesState.industryFilter);
        });
    } catch {}
}

function updateReleasesUrl(push = true) {
    try {
        if (state.currentView !== 'releases') return;
        const url = new URL(window.location.href);
        url.pathname = '/releases';

        if (releasesState.page > 1) {
            url.searchParams.set('page', String(releasesState.page));
        } else {
            url.searchParams.delete('page');
        }

        if (releasesState.providerFilter && releasesState.providerFilter !== 'all') {
            url.searchParams.set('platform', releasesState.providerFilter);
        } else {
            url.searchParams.delete('platform');
            url.searchParams.delete('provider');
        }

        if (releasesState.industryFilter && releasesState.industryFilter !== 'all') {
            url.searchParams.set('industry', releasesState.industryFilter);
        } else {
            url.searchParams.delete('industry');
        }

        // Remove any residual search params
        url.searchParams.delete('search');

        if (releasesState.sortBy && releasesState.sortBy !== 'date_desc') {
            url.searchParams.set('sort', releasesState.sortBy);
        } else {
            url.searchParams.delete('sort');
        }

        const newPath = url.pathname + (url.search ? url.search : '');
        const currentPath = window.location.pathname + window.location.search;

        if (newPath !== currentPath) {
            if (push) {
                history.pushState({ view: 'releases', page: releasesState.page }, '', newPath);
            } else {
                history.replaceState({ view: 'releases', page: releasesState.page }, '', newPath);
            }
        }
    } catch {}
}

async function loadNewReleases(page = null, updateUrl = true) {
    if (page === null) {
        syncReleasesStateFromUrl();
        page = releasesState.page || 1;
    } else {
        releasesState.page = page;
    }

    if (updateUrl) {
        updateReleasesUrl(true);
    }

    const grid = document.getElementById('releasesGrid');
    if (!grid) return;

    grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 50px 20px; color: var(--text-muted);">
            <div class="spinner" style="margin: 0 auto 12px;"></div>
            <div>Discovering new OTT releases...</div>
        </div>
    `;

    try {
        const queryParams = new URLSearchParams({
            page: String(releasesState.page),
            limit: '24',
            provider: releasesState.providerFilter,
            industry: releasesState.industryFilter,
            sort: releasesState.sortBy,
        });

        const [releasesRes, statsRes] = await Promise.all([
            fetch(`/api/new-releases?${queryParams.toString()}`, { credentials: 'include' }),
            fetch('/api/new-releases/stats', { credentials: 'include' })
        ]);

        const data = await releasesRes.json();
        const stats = await statsRes.json();

        // Update stats
        if (stats) {
            const statTotal = document.getElementById('statTotalReleases');
            const statN = document.getElementById('statNetflixCount');
            const statP = document.getElementById('statPrimeCount');
            const statH = document.getElementById('statHotstarCount');
            const statZ = document.getElementById('statZee5Count');

            if (statTotal) statTotal.textContent = stats.total || '0';
            if (statN) statN.textContent = stats.platformCounts?.['Netflix'] || '0';
            if (statP) statP.textContent = stats.platformCounts?.['Amazon Prime Video'] || '0';
            if (statH) statH.textContent = stats.platformCounts?.['Disney+ Hotstar'] || '0';
            if (statZ) statZ.textContent = (stats.platformCounts?.['Zee5'] || 0) + (stats.platformCounts?.['Sony LIV'] || 0);

            const lastUpdatedEl = document.getElementById('releasesLastUpdatedTag');
            if (lastUpdatedEl) {
                if (stats.lastRefreshed) {
                    const d = new Date(stats.lastRefreshed);
                    lastUpdatedEl.textContent = `Last refreshed: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                } else {
                    lastUpdatedEl.textContent = `No items cached yet (Click Refresh)`;
                }
            }
        }

        releasesState.items = data.releases || [];
        releasesState.total = data.pagination?.total || 0;
        releasesState.totalPages = data.pagination?.totalPages || 1;

        if (releasesState.items.length === 0) {
            if (releasesState.total === 0 && !releasesState.searchQuery && releasesState.providerFilter === 'all' && releasesState.industryFilter === 'all') {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px;" class="releases-empty-card">
                        <div class="brand-icon-box" style="width: 48px; height: 48px; margin: 0 auto 16px; background: rgba(229, 9, 20, 0.15); color: #ff5252;">
                            <svg class="tabler-icon" style="width:28px;height:28px;" viewBox="0 0 24 24"><path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M8 4v16"/><path d="M16 4v16"/><path d="M4 8h4"/><path d="M4 16h4"/><path d="M4 12h16"/><path d="M16 8h4"/><path d="M16 16h4"/></svg>
                        </div>
                        <h2 style="font-size: 18px; margin-bottom: 6px; font-weight: 700;">No OTT Releases Cached Yet</h2>
                        <p style="color: var(--text-secondary); font-size: 13px; max-width: 500px; margin: 0 auto 20px;">
                            Click below to perform an initial scan of TMDB for the latest Indian OTT releases across Netflix, Prime Video, Hotstar, Zee5, and Sony LIV.
                        </p>
                        <button class="btn-primary-action" onclick="triggerManualReleasesRefresh(90)" style="padding: 10px 24px; font-size: 13.5px; margin: 0 auto;">
                            <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>
                            Fetch OTT Releases Now
                        </button>
                    </div>
                `;
            } else {
                grid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: var(--text-muted);">
                        <div style="font-size: 15px; font-weight: 600; color: #fff; margin-bottom: 4px;">No matching releases found</div>
                        <div style="font-size: 12.5px;">Try changing your platform, industry, or search filters.</div>
                    </div>
                `;
            }
            renderReleasesPagination();
            return;
        }

        renderReleaseCards(releasesState.items);
        renderReleasesPagination();

    } catch (err) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--accent-rose);">
                <div>Failed to load OTT releases: ${escapeHtml(err.message)}</div>
                <button class="btn-header" style="margin-top: 10px;" onclick="loadNewReleases(1, true)">Retry</button>
            </div>
        `;
    }
}

function renderReleaseCards(items) {
    const grid = document.getElementById('releasesGrid');
    if (!grid) return;

    grid.innerHTML = items.map(item => {
        const posterSrc = item.posterUrl || 'https://via.placeholder.com/300x450/111827/ffffff?text=No+Poster';
        const rating = item.rating ? Number(item.rating).toFixed(1) : 'N/A';
        const providers = item.providers || [];
        const providerBadges = providers.slice(0, 3).map(p => getPlatformBadge(p)).join('');
        const extraCount = providers.length > 3 ? `<span class="ott-badge more">+${providers.length - 3}</span>` : '';

        const year = item.year || (item.releaseDate ? item.releaseDate.slice(0, 4) : '');
        const formattedDate = item.releaseDate ? new Date(item.releaseDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';

        const isExists = Boolean(item.jellyfinExists);

        return `
            <div class="movie-release-card ${isExists ? 'in-library' : ''}">
                <div class="card-poster-wrap">
                    <img src="${posterSrc}" alt="${escapeHtml(item.title)}" class="card-poster-img" loading="lazy" onerror="this.src='https://via.placeholder.com/300x450/111827/ffffff?text=Poster+Unavailable'">
                    <div class="poster-overlay-gradient"></div>
                    <div class="card-top-badges">
                        <span class="badge-rating">
                            <svg class="tabler-icon star-icon" viewBox="0 0 24 24"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"/></svg>
                            ${rating}
                        </span>
                        ${isExists ? `<span class="badge-jellyfin-in" title="Already available in your Jellyfin Movie Library"><svg class="tabler-icon" style="width:11px;height:11px;stroke-width:3;display:inline-block;vertical-align:middle;margin-right:2px;" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>In Library</span>` : ''}
                    </div>
                    <div class="card-industry-tag">${escapeHtml(item.industry || 'Cinema')}</div>
                    
                    <!-- Hover Quick Actions -->
                    <div class="card-hover-actions">
                        ${isExists ? `
                            <button class="btn-card-action in-library" onclick="switchView('jellyfin')" title="Already in your Jellyfin Library">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                                In Library (Jellyfin)
                            </button>
                            <button class="btn-card-action secondary" onclick="directSearchRelease('${escapeHtml(item.title).replace(/'/g, "\\'")}', '${escapeHtml(year)}')" title="Search alternate release quality">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                Search Again
                            </button>
                        ` : `
                            <button class="btn-card-action primary" onclick="directSearchRelease('${escapeHtml(item.title).replace(/'/g, "\\'")}', '${escapeHtml(year)}')" title="Search & Download with Telegram Bot">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                Search & Download
                            </button>
                        `}
                        <div style="display: flex; gap: 6px; width: 100%;">
                            <button class="btn-card-action secondary" style="flex: 1;" onclick="askCopilotRelease('${escapeHtml(item.title).replace(/'/g, "\\'")}', '${escapeHtml(year)}')" title="Ask AI Copilot to find movie">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M8 9h8"/><path d="M8 13h6"/><path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"/></svg>
                                Copilot
                            </button>
                            <button class="btn-card-action secondary" style="flex: 1;" onclick="addReleaseToWatchlist('${escapeHtml(item.title).replace(/'/g, "\\'")}', '${escapeHtml(year)}')" title="Add to Watchlist">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12z"/><path d="M9 8h6"/></svg>
                                Request
                            </button>
                        </div>
                    </div>
                </div>
                
                <div class="card-body-content">
                    <div class="card-title-row">
                        <h3 class="card-movie-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</h3>
                        <span class="card-movie-year">${escapeHtml(year)}</span>
                    </div>
                    
                    <div class="card-date-row">
                        <span class="card-date-label">OTT Launch:</span>
                        <span class="card-date-val">${escapeHtml(formattedDate)}</span>
                    </div>

                    <!-- OTT Platforms List -->
                    <div class="card-ott-providers-row">
                        ${providerBadges || `<span class="ott-badge generic">OTT Stream</span>`}
                        ${extraCount}
                    </div>

                    ${item.overview ? `<p class="card-synopsis-text" title="${escapeHtml(item.overview)}">${escapeHtml(item.overview)}</p>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function renderReleasesPagination() {
    const bar = document.getElementById('releasesPaginationBar');
    if (!bar) return;

    if (releasesState.totalPages <= 1) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    const cur = releasesState.page;
    const total = releasesState.totalPages;

    let pageBtnsHtml = '';
    const maxVisible = 5;
    let startPage = Math.max(1, cur - Math.floor(maxVisible / 2));
    let endPage = Math.min(total, startPage + maxVisible - 1);
    if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
    }

    for (let p = startPage; p <= endPage; p++) {
        pageBtnsHtml += `
            <button class="btn-page ${p === cur ? 'active' : ''}" style="${p === cur ? 'background: var(--accent-blue); color: #fff; font-weight: 700; border-color: var(--accent-blue);' : ''}" onclick="loadNewReleases(${p}, true)">${p}</button>
        `;
    }

    bar.innerHTML = `
        <button class="btn-page ${cur <= 1 ? 'disabled' : ''}" onclick="loadNewReleases(${cur - 1}, true)" ${cur <= 1 ? 'disabled' : ''}>Previous</button>
        <div style="display: flex; gap: 4px; align-items: center;">
            ${pageBtnsHtml}
        </div>
        <span class="page-indicator" style="font-size: 12px; color: var(--text-muted); margin: 0 4px;">Page ${cur} of ${total} (${releasesState.total} titles)</span>
        <button class="btn-page ${cur >= total ? 'disabled' : ''}" onclick="loadNewReleases(${cur + 1}, true)" ${cur >= total ? 'disabled' : ''}>Next</button>
    `;
}

async function triggerManualReleasesRefresh(daysBack = 90) {
    const btnManual = document.getElementById('btnManualRefreshReleases');

    if (releasesState.refreshing) return;
    releasesState.refreshing = true;

    const originalManualHtml = btnManual ? btnManual.innerHTML : '';
    if (btnManual) {
        btnManual.innerHTML = `<div class="spinner" style="width:13px;height:13px;border-width:2px;display:inline-block;margin-right:6px;"></div> Scanning OTT (3 Mo)...`;
        btnManual.disabled = true;
    }

    showToast('Scanning last 3 months of Indian OTT releases from TMDB...', 'info');

    try {
        const res = await fetch('/api/new-releases/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ daysBack })
        });

        const data = await res.json();
        if (res.status === 429) {
            showToast(`⚠️ ${data.error}`, 'warning', 7000);
        } else if (data.success) {
            showToast(`✅ ${data.message}`, 'success', 6000);
            await loadNewReleases(1, true);
        } else {
            showToast(data.error || 'Refresh failed', 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        releasesState.refreshing = false;
        if (btnManual) {
            btnManual.innerHTML = originalManualHtml;
            btnManual.disabled = false;
        }
    }
}

function filterReleasesByPlatform(platform) {
    releasesState.providerFilter = platform;
    document.querySelectorAll('#platformFilterPills .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.platform === platform);
    });
    loadNewReleases(1, true);
}

function filterReleasesByIndustry(industry) {
    releasesState.industryFilter = industry;
    document.querySelectorAll('#industryFilterPills .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.industry === industry);
    });
    loadNewReleases(1, true);
}

function handleReleasesSortChange() {
    const select = document.getElementById('releasesSortSelect');
    releasesState.sortBy = select?.value || 'date_desc';
    loadNewReleases(1, true);
}

function directSearchRelease(title, year) {
    switchView('studio');
    const studioInput = document.getElementById('studioSearchInput');
    const studioYear = document.getElementById('studioYearInput');
    if (studioInput) studioInput.value = title;
    if (studioYear) studioYear.value = year || '';
    setStudioType('movie');
    performStudioSearch();
    showToast(`Searching releases for "${title}"`, 'info');
}

function askCopilotRelease(title, year) {
    switchView('chat');
    const chatInput = document.getElementById('chatInput');
    if (chatInput) {
        chatInput.value = `Search and download ${title} ${year ? year : ''}`.trim();
        sendChatMessage();
    }
}

async function addReleaseToWatchlist(title, year) {
    try {
        const res = await fetch('/api/requested-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ title, type: 'movie', year })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`Added "${title}" to Requested Media`, 'success');
        } else {
            showToast(data.error || 'Failed to request', 'error');
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

    const initialView = window.__INITIAL_VIEW__ || getViewForPath(window.location.pathname);
    switchView(initialView, false);

    checkBotStatus();
    setInterval(checkBotStatus, 20000);
    initWebSocket();
});

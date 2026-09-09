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

async function safeApiFetch(url, options = {}) {
    try {
        const res = await fetch(url, { credentials: 'include', ...options });
        const text = await res.text();
        let data = null;
        try {
            data = JSON.parse(text);
        } catch {
            if (!res.ok) {
                return { success: false, error: `Server returned HTTP ${res.status} (${res.statusText || 'Error'})` };
            }
            return { success: false, error: 'Unexpected server response format' };
        }
        if (!res.ok) {
            return { success: false, error: data?.error || data?.message || `HTTP ${res.status}` };
        }
        return data;
    } catch (err) {
        return { success: false, error: err.message || 'Network error' };
    }
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
    admin: '/user'
};

const VIEW_TITLES = {
    chat: 'AI Downloader',
    releases: 'New Releases',
    downloads: 'Download Station',
    requested: 'Requested Media',
    jellyfin: 'Jellyfin Library',
    bot: 'Telegram Bot',
    admin: 'User Management'
};

function getViewForPath(pathname) {
    const userRole = state.user?.role || 'user';
    if (userRole === 'user') return 'jellyfin';

    const p = (pathname || window.location.pathname || '/').toLowerCase();
    if (p.startsWith('/releases') || p.startsWith('/new-releases') || p.startsWith('/ott')) return 'releases';
    if (p.startsWith('/download') || p.startsWith('/downlaod')) return 'downloads';
    if (p.startsWith('/request')) return 'requested';
    if (p.startsWith('/jellyfin')) return 'jellyfin';
    if (p.startsWith('/telegram') || p.startsWith('/bot')) return 'bot';
    if (p.startsWith('/user') || p.startsWith('/users') || p.startsWith('/admin')) {
        return userRole === 'admin' ? 'admin' : 'chat';
    }
    return 'chat';
}

function switchView(viewName, updateHistory = true) {
    const userRole = state.user?.role || 'user';

    // Role protection on client view switching:
    if (userRole === 'user' && viewName !== 'jellyfin') {
        viewName = 'jellyfin';
    } else if (userRole === 'mod' && viewName === 'admin') {
        viewName = 'chat';
    }

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
    document.title = `CineGrab - ${VIEW_TITLES[viewName] || 'AI Copilot'}`;

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

const COMPILE_ANIMATED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" role="img" aria-label="Compile" class="ai-matrix-loader-svg"><title>Compile</title><desc>Each column fills bottom-up, then releases as one.</desc><defs><circle id="b" r="2.4" fill="#ffffff" opacity="0.12"/><circle id="l" r="3.1"/></defs><style>.l{fill:#ffffff;opacity:0;animation:icon-28-k 700ms cubic-bezier(0.65, 0, 0.35, 1) infinite both;}@keyframes icon-28-k{0%{opacity:0.08;}14%{opacity:1;}72%{opacity:0.95;}100%{opacity:0.08;}}@media (prefers-reduced-motion:reduce){.l{animation:none;opacity:0.45;}}.d00{animation-delay:280ms;}.d01{animation-delay:308ms;}.d02{animation-delay:336ms;}.d03{animation-delay:364ms;}.d04{animation-delay:392ms;}.d10{animation-delay:210ms;}.d11{animation-delay:238ms;}.d12{animation-delay:266ms;}.d13{animation-delay:294ms;}.d14{animation-delay:322ms;}.d20{animation-delay:140ms;}.d21{animation-delay:168ms;}.d22{animation-delay:196ms;}.d23{animation-delay:224ms;}.d24{animation-delay:252ms;}.d30{animation-delay:70ms;}.d31{animation-delay:98ms;}.d32{animation-delay:126ms;}.d33{animation-delay:154ms;}.d34{animation-delay:182ms;}.d40{animation-delay:0ms;}.d41{animation-delay:28ms;}.d42{animation-delay:56ms;}.d43{animation-delay:84ms;}.d44{animation-delay:112ms;}</style><use href="#b" x="6" y="6"/><use href="#b" x="17" y="6"/><use href="#b" x="28" y="6"/><use href="#b" x="39" y="6"/><use href="#b" x="50" y="6"/><use href="#b" x="6" y="17"/><use href="#b" x="17" y="17"/><use href="#b" x="28" y="17"/><use href="#b" x="39" y="17"/><use href="#b" x="50" y="17"/><use href="#b" x="6" y="28"/><use href="#b" x="17" y="28"/><use href="#b" x="28" y="28"/><use href="#b" x="39" y="28"/><use href="#b" x="50" y="28"/><use href="#b" x="6" y="39"/><use href="#b" x="17" y="39"/><use href="#b" x="28" y="39"/><use href="#b" x="39" y="39"/><use href="#b" x="50" y="39"/><use href="#b" x="6" y="50"/><use href="#b" x="17" y="50"/><use href="#b" x="28" y="50"/><use href="#b" x="39" y="50"/><use href="#b" x="50" y="50"/><use class="l d00" href="#l" x="6" y="6"/><use class="l d01" href="#l" x="17" y="6"/><use class="l d02" href="#l" x="28" y="6"/><use class="l d03" href="#l" x="39" y="6"/><use class="l d04" href="#l" x="50" y="6"/><use class="l d10" href="#l" x="6" y="17"/><use class="l d11" href="#l" x="17" y="17"/><use class="l d12" href="#l" x="28" y="17"/><use class="l d13" href="#l" x="39" y="17"/><use class="l d14" href="#l" x="50" y="17"/><use class="l d20" href="#l" x="6" y="28"/><use class="l d21" href="#l" x="17" y="28"/><use class="l d22" href="#l" x="28" y="28"/><use class="l d23" href="#l" x="39" y="28"/><use class="l d24" href="#l" x="50" y="28"/><use class="l d30" href="#l" x="6" y="39"/><use class="l d31" href="#l" x="17" y="39"/><use class="l d32" href="#l" x="28" y="39"/><use class="l d33" href="#l" x="39" y="39"/><use class="l d34" href="#l" x="50" y="39"/><use class="l d40" href="#l" x="6" y="50"/><use class="l d41" href="#l" x="17" y="50"/><use class="l d42" href="#l" x="28" y="50"/><use class="l d43" href="#l" x="39" y="50"/><use class="l d44" href="#l" x="50" y="50"/></svg>`;

function handleWebSocketMessage(msg) {
    if (msg.type === 'ai_status') {
        if (msg.sessionId === state.sessionId) {
            updateTypingIndicator(msg.label);
        }
    } else if (msg.type === 'new_download') {
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
                    <span class="chat-search-hint">10Gbps CDN · Instant Autonomous Download</span>
                </div>
                <div class="chat-search-list">
                    ${results.map((r, idx) => {
                        const isRecommended = r.isBest || r.index === bestIdx || idx === 0;
                        const titleText = r.name || r.text || '';
                        const sizeStr = r.sizeMB ? (r.sizeMB >= 1024 ? `${(r.sizeMB / 1024).toFixed(2)} GB` : `${r.sizeMB} MB`) : '';
                        const res = (titleText.match(/\\b(480p|720p|1080p|2160p|4k|400p)\\b/i) || [])[1] || '720p';
                        const codec = (titleText.match(/\\b(hevc|x265|h265|x264|h264|avc)\\b/i) || [])[1] || '';
                        const langTag = getLanguageTag(titleText);
                        const categories = Array.isArray(r.category) ? r.category : [];

                        return `
                            <div class="chat-release-card ${isRecommended ? 'recommended' : ''}" onclick="handleQuickPrompt('download ${r.index || idx + 1}')">
                                <div class="chat-release-left" style="display: flex; gap: 12px; align-items: center;">
                                    ${r.thumbnail ? `
                                        <img src="${escapeHtml(r.thumbnail)}" alt="Poster" class="chat-release-thumb" style="width: 48px; height: 68px; object-fit: cover; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); flex-shrink: 0;" onerror="this.style.display='none'">
                                    ` : `
                                        <span class="chat-release-index">#${r.index || idx + 1}</span>
                                    `}
                                    <div class="chat-release-meta" style="flex: 1; min-width: 0;">
                                        <div class="chat-release-title" title="${escapeHtml(titleText)}" style="font-weight: 600; font-size: 13px; line-height: 1.3; color: #fff; margin-bottom: 4px;">
                                            ${escapeHtml(titleText)}
                                        </div>
                                        <div class="chat-release-tags" style="display: flex; flex-wrap: wrap; gap: 4px;">
                                            <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-weight: 700;">⚡ 10Gbps 720p</span>
                                            ${langTag ? `<span class="badge ${langTag.type}">${langTag.label}</span>` : ''}
                                            <span class="badge res">${escapeHtml(res.toUpperCase())}</span>
                                            ${sizeStr ? `<span class="badge size">${sizeStr}</span>` : ''}
                                            ${codec ? `<span class="badge codec">${escapeHtml(codec.toUpperCase())}</span>` : ''}
                                            ${categories.slice(0, 3).map(c => `<span class="badge" style="background: var(--bg-surface-elevated); color: var(--text-secondary);">${escapeHtml(c)}</span>`).join('')}
                                            ${isRecommended ? `<span class="badge rec">⭐ Best Match</span>` : ''}
                                        </div>
                                    </div>
                                </div>
                                <button class="btn-download-release ${isRecommended ? 'primary' : ''}" onclick="event.stopPropagation(); handleQuickPrompt('download ${r.index || idx + 1}')">
                                    <svg class="tabler-icon" style="width:15px;height:15px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                    Download #${r.index || idx + 1}
                                </button>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }

    row.innerHTML = `
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

function showTypingIndicator(initialLabel = 'Thinking...') {
    removeTypingIndicator();
    const chatBox = document.getElementById('chatMessagesBox');
    if (!chatBox) return;

    const row = document.createElement('div');
    row.id = 'chatTypingIndicator';
    row.className = 'message-row assistant typing-row';
    row.innerHTML = `
        <div class="ai-thought-pill">
            <div class="ai-thought-svg-icon">
                ${COMPILE_ANIMATED_SVG}
            </div>
            <div class="ai-thought-body">
                <span class="ai-thought-label" id="aiThoughtLabel">${escapeHtml(initialLabel)}</span>
            </div>
        </div>
    `;
    chatBox.appendChild(row);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function updateTypingIndicator(label) {
    const labelEl = document.getElementById('aiThoughtLabel');
    if (labelEl && label) {
        labelEl.textContent = label;
    }
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
                const sCall = data.toolCalls.find(tc =>
                    (tc.tool === 'search_media' || tc.tool === 'search_movie' || tc.tool === 'search_series') &&
                    tc.result?.data?.results?.length > 0
                );
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
        askCopilotRelease(param, '');
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
    const bestIdx = data.bestIdx || 0;

    container.innerHTML = `
        <div class="chat-search-results-panel studio-panel-wrap">
            <div class="chat-search-header">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
                    <span>🎬 <strong>${escapeHtml(movieTitle)}</strong> ${movieYear ? `(${escapeHtml(movieYear)})` : ''} · <strong>${total} Available Releases</strong></span>
                    <span class="chip best" style="background: rgba(16, 185, 129, 0.2); color: #34d399; font-weight: 700;">⚡ 10Gbps Fast CDN</span>
                </div>
                <span class="chat-search-hint">Select any release below to download directly to your media server in 720p:</span>
            </div>
            <div class="chat-search-list">
                ${results.map((r, i) => {
                    const optIndex = r.index || (i + 1);
                    const isRecommended = i === bestIdx || optIndex === 1;
                    const titleText = r.name || r.text || '';
                    const categories = Array.isArray(r.category) ? r.category : [];
                    const stars = Array.isArray(r.stars) ? r.stars.join(', ') : '';

                    return `
                        <div class="chat-release-card ${isRecommended ? 'recommended' : ''}" onclick="triggerStudioMovieDownload(${optIndex}, '${escapeHtml(r.url || '').replace(/'/g, "\\'")}')">
                            <div class="chat-release-left" style="display: flex; gap: 14px; align-items: center;">
                                ${r.thumbnail ? `
                                    <img src="${escapeHtml(r.thumbnail)}" alt="Poster" class="chat-release-thumb" style="width: 54px; height: 78px; object-fit: cover; border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,0.5); flex-shrink: 0;" onerror="this.style.display='none'">
                                ` : `
                                    <span class="chat-release-index">#${optIndex}</span>
                                `}
                                <div class="chat-release-meta" style="flex: 1; min-width: 0;">
                                    <div class="chat-release-title" title="${escapeHtml(titleText)}" style="font-weight: 600; font-size: 13.5px; line-height: 1.35; color: #fff; margin-bottom: 5px;">
                                        ${escapeHtml(titleText)}
                                    </div>
                                    <div class="chat-release-tags" style="display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 4px;">
                                        <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-weight: 700;">⚡ 720p CDN</span>
                                        ${categories.slice(0, 3).map(c => `<span class="badge" style="background: var(--bg-surface-elevated); color: var(--text-secondary);">${escapeHtml(c)}</span>`).join('')}
                                        ${r.post_date ? `<span class="badge" style="background: var(--bg-surface-elevated); color: var(--text-muted);">${escapeHtml(r.post_date)}</span>` : ''}
                                        ${isRecommended ? `<span class="badge rec">⭐ Recommended</span>` : ''}
                                    </div>
                                    ${stars ? `<div style="font-size: 11px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">Cast: ${escapeHtml(stars)}</div>` : ''}
                                </div>
                            </div>
                            <button class="btn-download-release ${isRecommended ? 'primary' : ''}" onclick="event.stopPropagation(); triggerStudioMovieDownload(${optIndex}, '${escapeHtml(r.url || '').replace(/'/g, "\\'")}', this)">
                                <svg class="tabler-icon" style="width:15px;height:15px;" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                Download 720p
                            </button>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

let isTriggeringDownload = false;
async function triggerStudioMovieDownload(optionIndex, targetUrl, btnElement) {
    if (isTriggeringDownload) return;
    isTriggeringDownload = true;

    if (btnElement) {
        btnElement.disabled = true;
        btnElement.dataset.origHtml = btnElement.innerHTML;
        btnElement.innerHTML = `<span style="display:inline-block;animation:spin 0.8s linear infinite;">⏳</span> Queuing...`;
    }

    try {
        const res = await fetch('/api/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                searchId: state.searchResultSession,
                optionIndex: typeof optionIndex === 'number' ? optionIndex : undefined,
                targetUrl: targetUrl || (typeof optionIndex === 'string' ? optionIndex : undefined)
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'Download started in 720p!', 'success');
            if (btnElement) {
                btnElement.innerHTML = `✅ Queued 720p`;
                btnElement.classList.remove('primary');
            }
            switchView('downloads');
        } else {
            showToast(data.error || 'Failed to start download', 'error', 6000);
            if (btnElement && btnElement.dataset.origHtml) {
                btnElement.disabled = false;
                btnElement.innerHTML = btnElement.dataset.origHtml;
            }
        }
    } catch (err) {
        showToast(err.message, 'error');
        if (btnElement && btnElement.dataset.origHtml) {
            btnElement.disabled = false;
            btnElement.innerHTML = btnElement.dataset.origHtml;
        }
    } finally {
        setTimeout(() => { isTriggeringDownload = false; }, 800);
    }
}

async function triggerStudioEpisodeDownload(buttonText, btnElement) {
    await triggerStudioMovieDownload(buttonText, undefined, btnElement);
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
    if (!requestId) return;
    const data = await safeApiFetch(`/api/downloads/${requestId}/pause`, { method: 'POST' });
    if (data.success) {
        showToast('Download paused', 'info');
        loadDownloadHistory();
    } else {
        showToast(data.error || 'Failed to pause download', 'error');
    }
}

async function resumeDownload(requestId) {
    if (!requestId) return;
    const data = await safeApiFetch(`/api/downloads/${requestId}/resume`, { method: 'POST' });
    if (data.success) {
        showToast('Download resumed', 'success');
        loadDownloadHistory();
    } else {
        showToast(data.error || 'Failed to resume download', 'error');
    }
}

async function retryDownload(requestId) {
    if (!requestId) return;
    const data = await safeApiFetch(`/api/downloads/${requestId}/retry`, { method: 'POST' });
    if (data.success) {
        showToast('Download retry queued', 'info');
        loadDownloadHistory();
    } else {
        showToast(data.error || 'Failed to retry download', 'error');
    }
}

async function cancelDownload(requestId) {
    if (!requestId) return;
    const confirmed = await showConfirmModal({
        title: 'Remove Download Entry',
        message: 'Are you sure you want to remove this download entry from the list?',
        confirmText: 'Remove Entry',
        type: 'danger'
    });
    if (!confirmed) return;
    const data = await safeApiFetch(`/api/downloads/${requestId}`, { method: 'DELETE' });
    if (data.success) {
        showToast('Download removed', 'info');
        loadDownloadHistory();
    } else {
        showToast(data.error || 'Failed to remove download', 'error');
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
    const data = await safeApiFetch('/api/downloads/clear/failed', { method: 'DELETE' });
    if (data.success) {
        showToast('Cleared failed downloads', 'info');
        loadDownloadHistory();
    } else {
        showToast(data.error || 'Failed to clear failed downloads', 'error');
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
    const data = await safeApiFetch('/api/downloads/clear/all', { method: 'DELETE' });
    if (data.success) {
        showToast('Cleared download history', 'info');
        loadDownloadHistory();
    } else {
        showToast(data.error || 'Failed to clear download history', 'error');
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

let cachedJellyfinMovies = [];
let jfSearchDebounceTimer = null;

function renderJellyfinMovieCardHtml(movie) {
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
}

function renderJellyfinGrid(movies) {
    const grid = document.getElementById('jfMoviesGrid');
    if (!grid) return;

    if (!movies || movies.length === 0) {
        grid.innerHTML = `
            <div style="text-align: center; color: var(--text-muted); padding: 48px 20px; width: 100%; grid-column: 1 / -1;">
                <div style="width: 52px; height: 52px; border-radius: 50%; background: var(--bg-surface-elevated); border: 1px solid var(--border-medium); display: flex; align-items: center; justify-content: center; color: var(--accent-cyan); margin: 0 auto 12px;">
                    <svg class="tabler-icon" style="width:26px;height:26px;" viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                </div>
                <div style="font-size: 15px; font-weight: 600; color: #fff;">No Movies Found</div>
                <div style="font-size: 12.5px; color: var(--text-secondary); margin-top: 4px;">No movies matching your criteria in your Jellyfin collection.</div>
            </div>
        `;
        return;
    }

    grid.innerHTML = movies.map(renderJellyfinMovieCardHtml).join('');
}

async function loadJellyfinLibrary(force = false) {
    const grid = document.getElementById('jfMoviesGrid');
    if (!grid) return;

    if (force || cachedJellyfinMovies.length === 0) {
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
        cachedJellyfinMovies = data.items || [];
        renderJellyfinGrid(cachedJellyfinMovies);
    } catch (err) {
        grid.innerHTML = `
            <div style="text-align: center; color: var(--accent-rose); padding: 40px; width: 100%; grid-column: 1 / -1;">
                Failed to load Jellyfin movies library: ${escapeHtml(err.message)}
            </div>
        `;
    }
}

function handleJellyfinSearchInput(val) {
    clearTimeout(jfSearchDebounceTimer);
    jfSearchDebounceTimer = setTimeout(() => {
        performJellyfinLookup(val);
    }, 150);
}

async function performJellyfinLookup(query) {
    const q = (query || '').trim().toLowerCase();
    const resultBox = document.getElementById('jfCheckResultBox');
    
    if (!q) {
        if (resultBox) {
            resultBox.style.display = 'none';
            resultBox.innerHTML = '';
        }
        renderJellyfinGrid(cachedJellyfinMovies);
        return;
    }

    // Filter in cached library
    const matched = cachedJellyfinMovies.filter(m => {
        const name = (m.Name || '').toLowerCase();
        const orig = (m.OriginalTitle || '').toLowerCase();
        return name.includes(q) || orig.includes(q);
    });

    // Also update library collection grid below in real-time
    renderJellyfinGrid(matched);

    if (resultBox) {
        resultBox.style.display = 'block';

        if (matched.length > 0) {
            resultBox.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <div style="color: var(--accent-emerald); font-weight: 600; display: flex; align-items: center; gap: 6px; font-size: 12.5px;">
                        <svg class="tabler-icon text-emerald" style="width:16px;height:16px;" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                        <span>Found ${matched.length} ${matched.length === 1 ? 'matching movie' : 'matching movies'} in your Jellyfin Library (showing below)</span>
                    </div>
                    <span class="chip quality" style="background: rgba(16, 185, 129, 0.15); color: var(--accent-emerald); border-color: rgba(16, 185, 129, 0.3); font-size: 10.5px; padding: 2px 8px;">In Library</span>
                </div>
            `;
        } else {
            resultBox.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                    <div>
                        <div style="color: var(--text-secondary); display: flex; align-items: center; gap: 6px; font-size: 12.5px;">
                            <svg class="tabler-icon text-blue" style="width:16px;height:16px;" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12.01" y2="8"/><polyline points="11 12 12 12 12 16 13 16"/></svg>
                            <span><strong>"${escapeHtml(q)}"</strong> is not in your Jellyfin Library.</span>
                        </div>
                        <p style="font-size: 11.5px; color: var(--text-muted); margin-top: 3px; margin-bottom: 0;">You can discover & download this movie directly using AI Copilot.</p>
                    </div>
                    <button class="btn-primary-action" onclick="askCopilotRelease('${escapeHtml(q).replace(/'/g, "\\'")}', '')" style="padding: 5px 12px; font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px;">
                        <svg class="tabler-icon" viewBox="0 0 24 24" style="width:13px;height:13px;"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                        Download with AI
                    </button>
                </div>
            `;
        }
    }
}

function checkJellyfinItem() {
    const input = document.getElementById('jfCheckInput');
    if (!input) return;
    performJellyfinLookup(input.value);
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
let adminUsersList = [];

async function loadAdminUsers() {
    const tableBody = document.getElementById('adminUsersTableBody');
    if (!tableBody) return;

    try {
        const res = await fetch('/api/admin/users', { credentials: 'include' });
        const data = await res.json();
        adminUsersList = data.users || [];
        if (adminUsersList.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 24px;">No registered users found</td></tr>`;
            return;
        }

        tableBody.innerHTML = adminUsersList.map(u => {
            const isSelf = u.id === state.user.id;
            const roleBadgeClass = u.role === 'admin' ? 'best' : u.role === 'mod' ? 'quality' : 'source';
            const roleLabel = u.role === 'admin' ? 'Admin' : u.role === 'mod' ? 'Mod' : 'User';

            return `
            <tr>
                <td style="font-weight: 600; color: #fff;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div class="user-avatar" style="width: 26px; height: 26px; font-size: 11px; flex-shrink: 0;">${escapeHtml((u.name || 'U').charAt(0).toUpperCase())}</div>
                        <span>${escapeHtml(u.name)}</span>
                        ${isSelf ? '<span class="chip" style="font-size: 9px; padding: 0 4px; background: rgba(56,139,253,0.15); color: #58a6ff;">You</span>' : ''}
                    </div>
                </td>
                <td style="color: var(--text-secondary); font-size: 12.5px;">${escapeHtml(u.email)}</td>
                <td><span class="chip ${roleBadgeClass}" style="font-weight: 600; font-size: 11px;">${roleLabel}</span></td>
                <td style="color: var(--text-muted); font-size: 11.5px;">${new Date(u.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                <td style="text-align: right;">
                    <div style="display: inline-flex; gap: 6px; align-items: center; justify-content: flex-end;">
                        <button class="btn-header" style="padding: 3px 8px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;" onclick="openEditUserModal(${u.id})">
                            <svg class="tabler-icon" viewBox="0 0 24 24" style="width: 12px; height: 12px;"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/></svg>
                            Edit
                        </button>
                        ${!isSelf ? `
                        <button class="btn-header" style="color: var(--accent-rose); padding: 3px 8px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;" onclick="deleteAdminUser(${u.id})">
                            <svg class="tabler-icon" viewBox="0 0 24 24" style="width: 12px; height: 12px;"><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>
                            Delete
                        </button>
                        ` : ''}
                    </div>
                </td>
            </tr>
            `;
        }).join('');
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--accent-rose); padding: 20px;">Failed to load users: ${escapeHtml(err.message)}</td></tr>`;
    }
}

async function openEditUserModal(userId) {
    let user = adminUsersList.find(u => String(u.id) === String(userId));
    if (!user) {
        try {
            const res = await fetch('/api/admin/users', { credentials: 'include' });
            const data = await res.json();
            adminUsersList = data.users || [];
            user = adminUsersList.find(u => String(u.id) === String(userId));
        } catch (e) {}
    }
    if (!user) {
        showToast('User not found', 'error');
        return;
    }

    const existing = document.getElementById('editUserModalBackdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'editUserModalBackdrop';
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
        <div class="modal-card" style="max-width: 440px;" role="dialog" aria-modal="true">
            <div class="modal-header">
                <div class="modal-header-icon" style="background: rgba(56, 139, 253, 0.15); color: #58a6ff;">
                    <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/></svg>
                </div>
                <div>
                    <h3 class="modal-title" style="font-size: 16px;">Edit User Account</h3>
                    <p class="modal-subtitle" style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">Managing ${escapeHtml(user.email)}</p>
                </div>
            </div>
            <form id="dynamicEditUserForm" onsubmit="saveEditUser(event, ${user.id})">
                <div class="modal-body" style="display: flex; flex-direction: column; gap: 14px; padding: 16px 0;">
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">Full Name</label>
                        <input type="text" id="editUserNameInput" class="form-input" required value="${escapeHtml(user.name || '')}" placeholder="Full Name">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">Email Address</label>
                        <input type="email" id="editUserEmailInput" class="form-input" required value="${escapeHtml(user.email || '')}" placeholder="user@example.com">
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">Role</label>
                        <select id="editUserRoleInput" class="form-input" style="background: var(--bg-input);">
                            <option value="user" ${user.role === 'user' ? 'selected' : ''}>User (Jellyfin Library Only)</option>
                            <option value="mod" ${user.role === 'mod' ? 'selected' : ''}>Mod (Full Access except Users)</option>
                            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin (Full Access + Users)</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" style="font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block;">New Password</label>
                        <input type="password" id="editUserPasswordInput" class="form-input" placeholder="Leave empty to keep current password" autocomplete="new-password">
                        <span style="font-size: 11px; color: var(--text-muted); margin-top: 4px; display: block;">Leave blank if you do not want to change the password.</span>
                    </div>
                </div>
                <div class="modal-actions" style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 10px;">
                    <button type="button" class="btn-cancel" onclick="document.getElementById('editUserModalBackdrop')?.remove()">Cancel</button>
                    <button type="submit" id="btnSaveEditUser" class="btn-primary-action">Save Changes</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => {
        backdrop.classList.add('active');
        document.getElementById('editUserNameInput')?.focus();
    });

    const handleKey = (e) => {
        if (e.key === 'Escape') {
            backdrop.remove();
            window.removeEventListener('keydown', handleKey);
        }
    };
    window.addEventListener('keydown', handleKey);

    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
            backdrop.remove();
            window.removeEventListener('keydown', handleKey);
        }
    });
}

function closeEditUserModal() {
    const modal = document.getElementById('editUserModalBackdrop');
    if (modal) modal.remove();
}

async function saveEditUser(e, userId) {
    if (e && e.preventDefault) e.preventDefault();
    const id = userId || document.getElementById('editUserId')?.value;
    const name = document.getElementById('editUserNameInput')?.value.trim();
    const email = document.getElementById('editUserEmailInput')?.value.trim();
    const role = document.getElementById('editUserRoleInput')?.value;
    const password = document.getElementById('editUserPasswordInput')?.value.trim();

    if (!id || !name || !email || !role) {
        showToast('Name, email, and role are required', 'error');
        return;
    }

    const saveBtn = document.getElementById('btnSaveEditUser');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
    }

    try {
        const payload = { name, email, role };
        if (password) payload.password = password;

        const res = await fetch(`/api/admin/users/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            showToast('User updated successfully', 'success');
            document.getElementById('editUserModalBackdrop')?.remove();
            loadAdminUsers();
            if (Number(id) === state.user.id) {
                state.user.name = name;
                state.user.email = email;
                state.user.role = role;
                document.querySelectorAll('.user-name').forEach(el => el.textContent = name);
            }
        } else {
            showToast(data.error || 'Failed to update user', 'error');
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Changes';
        }
    }
}

window.openEditUserModal = openEditUserModal;
window.closeEditUserModal = closeEditUserModal;
window.saveEditUser = saveEditUser;

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
            showToast(`User ${name} created (${role})`, 'success');
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
        } else {
            showToast(data.error || 'Failed to delete user', 'error');
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
        let cleanName = (provider?.name || 'OTT')
            .replace(/Amazon Channel|Apple TV Channel|Channel/gi, '')
            .trim();
        if (cleanName.length > 14) cleanName = cleanName.slice(0, 13) + '…';
        match = { name: cleanName, color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: 'rgba(56, 189, 248, 0.3)' };
    }

    return `<span class="ott-badge" style="color: ${match.color}; background: ${match.bg}; border-color: ${match.border};" title="${escapeHtml(provider?.name || match.name)}">
        ${provider?.logoUrl ? `<img src="${provider.logoUrl}" alt="${escapeHtml(match.name)}" class="ott-badge-logo" onerror="this.style.display='none'">` : ''}
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
        document.querySelectorAll('.ott-metric-card').forEach(card => {
            const attr = (card.getAttribute('onclick') || '').toLowerCase();
            card.classList.toggle('active', attr.includes(`'${releasesState.providerFilter}'`));
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
        const providerBadges = providers.slice(0, 2).map(p => getPlatformBadge(p)).join('');
        const extraCount = providers.length > 2 ? `<span class="ott-badge more" title="${providers.slice(2).map(p => escapeHtml(p.name)).join(', ')}">+${providers.length - 2}</span>` : '';

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

                    <!-- Card Bottom Actions (Single AI Download Button) -->
                    <div class="card-bottom-actions">
                        ${isExists ? `
                            <button class="btn-card-action in-library" onclick="switchView('jellyfin')" title="Already in your Jellyfin Library">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M5 12l5 5l10 -10"/></svg>
                                <span>In Library</span>
                            </button>
                        ` : `
                            <button class="btn-card-action primary" onclick="askCopilotRelease('${escapeHtml(item.title).replace(/'/g, "\\'")}', '${escapeHtml(year)}')" title="Download movie with AI Copilot">
                                <svg class="tabler-icon" viewBox="0 0 24 24"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>
                                <span>Download</span>
                            </button>
                        `}
                    </div>
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
    document.querySelectorAll('.ott-metric-card').forEach(card => {
        const attr = (card.getAttribute('onclick') || '').toLowerCase();
        card.classList.toggle('active', attr.includes(`'${platform}'`));
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
    askCopilotRelease(title, year);
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

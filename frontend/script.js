// ============================================
// TEMPEST X AI MOTION PORTAL
// Complete Frontend Logic
// ============================================

// ===== AUTHENTICATION STATE =====
let currentUser = null;
let isAuthenticated = false;
let sessionLogoutTimer = null;
let authLoadingTimer = null;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

window.__pageErrors = [];
window.onerror = (message, source, lineno, colno, error) => {
    window.__pageErrors.push({ type: 'error', message, source, lineno, colno, error: error?.toString() });
    return false;
};
window.addEventListener('unhandledrejection', (event) => {
    window.__pageErrors.push({ type: 'unhandledrejection', reason: event.reason?.toString() });
});

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function clearLocalSession() {
    currentUser = null;
    isAuthenticated = false;
    localStorage.removeItem('tempest_user');
    localStorage.removeItem('tempest_session_expires_at');
    if (sessionLogoutTimer) clearTimeout(sessionLogoutTimer);
    sessionLogoutTimer = null;
}

function finishAuthLoading() {
    if (authLoadingTimer) {
        clearTimeout(authLoadingTimer);
        authLoadingTimer = null;
    }
    $('authLoading')?.classList.add('hidden');
}

function scheduleAuthLoadingTimeout() {
    if (authLoadingTimer) clearTimeout(authLoadingTimer);
    authLoadingTimer = setTimeout(() => {
        console.warn('Auth session check timed out; falling back to login screen');
        finishAuthLoading();
        $('loginScreen')?.classList.add('active');
        if ($('mainApp')) $('mainApp').style.display = 'none';
    }, 5000);
}

function scheduleSessionLogout(expiresAt) {
    if (sessionLogoutTimer) clearTimeout(sessionLogoutTimer);
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
        expireSession();
        return;
    }
    sessionLogoutTimer = setTimeout(expireSession, remaining);
}

function expireSession() {
    clearLocalSession();
    $('mainApp').style.display = 'none';
    $('loginScreen').classList.add('active');
    finishAuthLoading();
    showLoginError('Your 30-minute session has expired. Please sign in again.');
}

const originalFetch = window.fetch.bind(window);
window.fetch = (...args) => originalFetch(...args).then(response => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (response.status === 401 && !url.includes('/api/auth/login')) expireSession();
    return response;
});

// Load user from localStorage if exists
function initAuthState() {
    const savedUser = localStorage.getItem('tempest_user');
    const expiresAt = Number(localStorage.getItem('tempest_session_expires_at'));
    if (!savedUser || !expiresAt || expiresAt <= Date.now()) {
        clearLocalSession();
        $('loginScreen').classList.add('active');
        finishAuthLoading();
        return;
    }

    scheduleAuthLoadingTimeout();
    fetch('/api/auth/me')
        .then(response => response.json().then(data => ({ response, data })))
        .then(({ response, data }) => {
            if (!response.ok || !data.success) return expireSession();
            currentUser = data.user;
            isAuthenticated = true;
            localStorage.setItem('tempest_user', JSON.stringify(currentUser));
            scheduleSessionLogout(expiresAt);
            showMainApp();
            initializeApp();
            finishAuthLoading();
        })
        .catch(() => expireSession());
}

// ===== LOGIN HANDLING =====
function handleLogin(event) {
    event.preventDefault();
    
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value.trim();
    
    if (!username || !password) {
        showLoginError('Please enter both username and password');
        return;
    }
    
    fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            currentUser = data.user;
            isAuthenticated = true;
            localStorage.setItem('tempest_user', JSON.stringify(currentUser));
            const expiresAt = Date.now() + SESSION_TIMEOUT_MS;
            localStorage.setItem('tempest_session_expires_at', expiresAt.toString());
            scheduleSessionLogout(expiresAt);
            showMainApp();
            initializeApp();
        } else {
            showLoginError(data.error || 'Login failed. Please check your credentials.');
        }
    })
    .catch(err => {
        console.error('Login error:', err);
        showLoginError('Connection error. Please try again.');
    });
}

function showLoginError(message) {
    const errorDiv = $('loginError');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

function handleLogout() {
    if (!confirm('Are you sure you want to logout?')) return;
    originalFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearLocalSession();
    
    // Reset form
    $('loginUsername').value = '';
    $('loginPassword').value = '';
    
    // Hide main app and show login
    $('mainApp').style.display = 'none';
    $('loginScreen').classList.add('active');
}

function showMainApp() {
    $('loginScreen').classList.remove('active');
    $('mainApp').style.display = 'flex';
    updateCurrentUserDisplay();
    applyRoleBasedAccessControl();
}

function updateCurrentUserDisplay() {
    if (currentUser) {
        const roleLabels = {
            'super_admin': 'Superadmin',
            'admin': 'Admin',
            'operator': 'Operator'
        };
        $('currentUserDisplay').textContent = `${roleLabels[currentUser.role] || 'User'} · ${currentUser.username}`;
    }
}

function applyRoleBasedAccessControl() {
    if (!currentUser) return;
    
    const aiControls = $('aiControls');
    if (aiControls) {
        aiControls.style.display = currentUser.role === 'super_admin' ? 'flex' : 'none';
    }
    
    // Show/hide navigation items based on role
    document.querySelectorAll('.nav-item').forEach(item => {
        const allowedRoles = item.dataset.roles ? item.dataset.roles.split(',') : [];
        if (allowedRoles.includes(currentUser.role)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
    applyCaptureRoleAccess();
    const scheduleView = $('view-schedule');
    if (scheduleView) {
        const operatorMode = currentUser.role === 'operator';
        scheduleView.classList.toggle('operator-mode', operatorMode);
        scheduleView.querySelectorAll('button, input, select, textarea').forEach(control => {
            control.disabled = operatorMode;
            control.setAttribute('aria-disabled', operatorMode ? 'true' : 'false');
        });
    }
    
    // Set default view based on role
    const firstVisible = Array.from(document.querySelectorAll('.nav-item')).find(item => item.style.display === 'flex');
    const view = firstVisible ? firstVisible.dataset.view : 'live';
    switchView(view);
}

function applyCaptureRoleAccess() {
    const role = currentUser?.role;
    document.querySelectorAll('[data-allowed-roles]').forEach(element => {
        const allowedRoles = element.dataset.allowedRoles.split(',');
        element.style.display = allowedRoles.includes(role) ? '' : 'none';
    });

    if (role === 'operator') {
        const recordingsTab = document.querySelector('.capture-tab[data-capture-tab="recordings"]');
        if (recordingsTab) recordingsTab.click();
    }
}

// ===== SOCKET.IO CONNECTION =====
let socket = null;

function initializeSocket() {
    if (socket) return;
    socket = io();
    
    socket.on('connect', () => {
        console.log('✅ Connected to server');
        updateStatus('online');
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnected from server');
        updateStatus('offline');
    });

    socket.on('initial_data', (data) => {
        state.cameras = applySavedCameraOrder(data.cameras || []);
        state.alerts = (data.alerts || []).map(normalizeAlert);
        state.stats = data.stats || { total_alerts: 0, acknowledged: 0, unacknowledged: 0, today_count: 0 };
        renderAll();
        if (state.currentView === 'system') loadSystemIntegrationStatus();
    });

    socket.on('new_alert', (alert) => {
        const normalizedAlert = normalizeAlert(alert);
        if (!getCameraById(normalizedAlert.camera_id)) {
            console.warn('Ignoring alert for unknown camera:', normalizedAlert.camera_id, normalizedAlert.camera_name);
            return;
        }

        state.alerts = [normalizedAlert, ...state.alerts];
        if (state.alerts.length > 100) state.alerts = state.alerts.slice(0, 100);
        highlightCameraMotion(normalizedAlert);
        renderMotionPopup(normalizedAlert);
        renderStats();
        updateAlertBadge();
        playAlertSound();
    });

    socket.on('alert_acknowledged', (alert) => {
        const index = state.alerts.findIndex(a => a.id === alert.id);
        if (index !== -1) {
            state.alerts[index] = alert;
            renderStats();
            updateAlertBadge();
        }
    });

    socket.on('stats_update', (stats) => {
        state.stats = stats;
        renderStats();
        updateAlertBadge();
    });

    socket.on('camera_deleted', (data) => {
        const cameraId = data?.camera_id;
        if (!cameraId) return;
        state.cameras = state.cameras.filter(c => c.id !== cameraId);
        state.alerts = state.alerts.filter(a => a.camera_id !== cameraId);
        delete state.motionActiveCameras[cameraId];
        clearMotionClipsForCamera(cameraId);
        renderAll();
    });

}

// ===== STATE =====
let state = {
    cameras: [],
    alerts: [],
    users: [],
    recordings: [],
    stats: { total_alerts: 0, acknowledged: 0, unacknowledged: 0, today_count: 0, processing_alerts: 0, acknowledged_alerts: 0, users_processing_alerts: 0 },
    scheduleConfig: null,
    currentView: 'live',
    motionActiveCameras: {},
    recordingCameras: {}
};
let motionBlinkTimers = {};
let calendarMode = 'schedule';
let calendarYear = null;
let calendarMonth = null;

// ===== DOM REFERENCES =====
const actorHeaders = () => ({
    'Content-Type': 'application/json',
    'X-Actor-Username': currentUser?.username || 'System'
});

// ===== INITIALIZATION =====
function initializeApp() {
    initializeSocket();
    loadUserSummary();
    loadSystemMetrics();
    loadRecordingsConfig();
}

function getCameraById(cameraId) {
    if (cameraId == null) return null;
    return state.cameras.find(cam => cam.id === cameraId || cam.id.toString() === cameraId.toString());
}

function highlightCameraMotion(alert) {
    if (!alert) return;

    let cameraId = alert.camera_id;
    const camera = getCameraById(cameraId);
    if (!camera && alert.camera_name) {
        const match = state.cameras.find(cam => cam.name === alert.camera_name);
        cameraId = match ? match.id : null;
    }

    if (!cameraId && alert.camera_name) {
        const fallback = state.cameras.find(cam => cam.location === alert.camera_name || cam.name.includes(alert.camera_name));
        cameraId = fallback ? fallback.id : null;
    }

    if (!cameraId || !getCameraById(cameraId)) return;

    state.motionActiveCameras[cameraId] = Date.now();
    clearTimeout(motionBlinkTimers[cameraId]);
    motionBlinkTimers[cameraId] = setTimeout(() => {
        delete state.motionActiveCameras[cameraId];
        if (state.currentView === 'live') {
            renderCameras();
        }
    }, 3500);

    if (state.currentView === 'live') {
        renderCameras();
    }
}

// ===== STATUS =====
function updateStatus(status) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (status === 'online') {
        dot.className = 'status-dot online';
        text.textContent = 'System Online';
    } else {
        dot.className = 'status-dot';
        dot.style.background = '#f44336';
        text.textContent = 'Disconnected';
    }
}

// ===== CLOCK =====
function updateClock() {
    const now = new Date();
    $('currentTime').textContent = now.toLocaleTimeString('en-US', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ===== NAVIGATION =====
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', function(e) {
        e.preventDefault();
        const view = this.dataset.view;
        switchView(view);
    });
});

function switchView(view) {
    state.currentView = view;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const selectedNav = document.querySelector(`.nav-item[data-view="${view}"]`);
    if (selectedNav) selectedNav.classList.add('active');
    document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`view-${view}`);
    if (target) target.classList.add('active');
    
    // Refresh data based on view
    if (view === 'live') renderAll();
    if (view === 'cameras') {
        renderCameras();
        loadRecordings();
        loadRecordingsConfig();
    }
    if (view === 'schedule') loadScheduleConfig();
    if (view === 'analytics') loadAnalytics();
    if (view === 'system') {
        loadSystemMetrics();
        loadSystemRecordingStorage();
        loadSystemIntegrationStatus();
    }
    if (view === 'users') loadUsers();
    if (view === 'settings') loadIntegrationSettings();
}

// ===== RENDER FUNCTIONS =====

function renderAll() {
    renderStats();
    renderCameras();
    renderCapturePanels();
    updateCaptureOverview();
    updateAlertBadge();
}

function renderCapturePanels() {
    renderCaptureZonesPanel();
    renderCaptureStoragePanel();
        refreshIcons();
}

function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
}

function renderCaptureZonesPanel() {
    const panel = $('motionZonesPanelContent');
    if (!panel) return;

    if (state.cameras.length === 0) {
        panel.className = 'capture-empty-panel';
        panel.innerHTML = '<strong>No cameras configured</strong><span>Add a camera first, then create a detection zone from this tab.</span><button class="btn btn-primary" onclick="showAddCamera()">+ Add Camera</button>';
        return;
    }

    panel.className = 'capture-zone-list';
    panel.innerHTML = state.cameras.map(camera => {
        const zones = normalizeCameraZones(camera);
        const items = zones.length ? zones.map((zone, index) => `
            <div class="capture-zone-item">
                <strong>${index + 1}. ${zone.name || 'Zone'}</strong>
                <div class="capture-zone-meta">
                    <span>${zone.object_type || 'human'}</span>
                    <span>${zone.points?.length || 0} pts</span>
                </div>
            </div>
        `).join('') : '<div class="capture-zone-item capture-zone-item-empty">No zones configured yet.</div>';

        return `
            <div class="capture-zone-card">
                <div class="capture-zone-card-heading"><h4>${camera.name || 'Camera'}</h4><span class="capture-zone-count">${zones.length} zone${zones.length === 1 ? '' : 's'}</span></div>
                <div class="capture-zone-items">${items}</div>
                <div class="capture-zone-actions">
                    <button class="btn btn-sm btn-primary" onclick="openZoneEditor(${camera.id})">Add Rule</button>
                    <button class="btn btn-sm btn-secondary" onclick="editCamera(${camera.id})">Camera Settings</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderCaptureStoragePanel() {
    const panel = $('captureStoragePanelContent');
    if (!panel) return;

    const totalStorageMb = state.recordings.reduce((sum, rec) => sum + (Number(rec.size_mb) || 0), 0);
    const archivedCount = state.recordings.filter(rec => rec.archived).length;
    const retentionDays = Number($('recordingRetentionDays')?.value) || 30;
    const liveCameraCount = state.cameras.filter(camera => (camera.status || 'online') !== 'offline').length;
        refreshIcons();

    const storageLimitMb = Math.max(totalStorageMb, 1000);
    const storagePercent = Math.min(100, (totalStorageMb / storageLimitMb) * 100);
    panel.className = 'capture-storage-list';
    panel.innerHTML = `
        <div class="capture-storage-card">
            <h4>Capture Summary</h4>
            <div class="capture-storage-grid">
                <div>
                    <span class="capture-stat-label">Total Storage</span>
                    <span class="big">${totalStorageMb.toFixed(1)} MB</span>
                </div>
                <div>
                    <span class="capture-stat-label">Recorded Clips</span>
                    <span class="big">${state.recordings.length}</span>
                </div>
                <div>
                    <span class="capture-stat-label">Archived</span>
                    <span class="big">${archivedCount}</span>
                </div>
                <div>
                    <span class="capture-stat-label">Live Cameras</span>
                    <span class="big">${liveCameraCount}</span>
                </div>
            </div>
            <div class="capture-storage-meter" aria-label="Storage usage">
                <div class="capture-storage-meter-label"><span>Usage</span><span>${storagePercent.toFixed(0)}%</span></div>
                <div class="capture-storage-meter-track"><span style="width: ${storagePercent}%"></span></div>
            </div>
        </div>
        <div class="capture-storage-card">
            <h4>Retention</h4>
            <div class="capture-storage-meta"><span>Policy</span><span>${retentionDays} days</span></div>
            <div class="capture-storage-meta"><span>Auto Cleanup</span><span>${$('autoCleanupEnabled')?.checked ? 'Enabled' : 'Disabled'}</span></div>
            <div class="capture-storage-actions">
                <button class="btn btn-primary" onclick="saveRecordingsConfig()">Save Policy</button>
                <button class="btn" onclick="performCleanup()">Cleanup Now</button>
            </div>
        </div>
    `;
}

function renderStats() {
    const stats = state.stats;
    if ($('totalCameras')) {
        $('totalCameras').textContent = state.cameras.length;
    }
        refreshIcons();
    if ($('liveCameraCount')) {
        $('liveCameraCount').textContent = `${state.cameras.length} camera${state.cameras.length === 1 ? '' : 's'}`;
    }
    if ($('todayAlerts')) {
        $('todayAlerts').textContent = stats.today_count || 0;
    }
    if ($('acknowledgedAlerts')) {
        $('acknowledgedAlerts').textContent = stats.acknowledged || 0;
    }
    if ($('pendingAlerts')) {
        $('pendingAlerts').textContent = stats.unacknowledged || 0;
    }

    if ($('usersProcessingAlerts')) {
        $('usersProcessingAlerts').textContent = stats.users_processing_alerts || state.users.filter(u => u.status === 'active').length || 0;
    }
    if ($('alertsBeingProcessed')) {
        $('alertsBeingProcessed').textContent = stats.processing_alerts || stats.unacknowledged || 0;
    }
    if ($('acknowledgedAlertsCount')) {
        $('acknowledgedAlertsCount').textContent = stats.acknowledged_alerts || stats.acknowledged || 0;
    }
}

function loadSystemMetrics() {
    // Prefer dedicated uptime endpoint for production accuracy
    fetch('/api/system/uptime')
        .then(res => res.json())
        .then(u => {
            if (u.success && typeof u.uptime_seconds === 'number') {
                setSystemUptime(u.uptime_seconds);
            }
        })
        .catch(() => {})
        .finally(() => {
            // Then fetch full system metrics for other fields
            fetch('/api/system')
                .then(res => res.json())
                .then(data => {
                    if (data.success && data.system) {
                        const sys = data.system;
                        updateSystemMeter('cpuLoad', 'cpuUsageBar', sys.cpu_load);
                        updateSystemMeter('ramUsage', 'ramUsageBar', sys.ram_usage);
                        updateSystemMeter('rootDisk', 'rootDiskBar', sys.root_disk);
                        setText('coreTemp', sys.core_temp != null ? `${sys.core_temp.toFixed(1)}°C` : 'Unavailable');
                        setText('gpuTemp', sys.gpu_temp != null ? `${sys.gpu_temp.toFixed(1)}°C` : 'Unavailable');
                        setText('systemDiskCapacity', `${formatBytes(sys.disk_used_bytes)} used / ${formatBytes(sys.disk_total_bytes)}`);
                        setText('systemDiskFree', formatBytes(sys.disk_free_bytes));
                        setSystemHealth(sys);
                    }
                })
                .catch(err => console.error('Error loading system metrics:', err));
        });
}

function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
}

function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}

function updateSystemMeter(valueId, barId, value) {
    const number = Number(value);
    const bounded = Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
    setText(valueId, Number.isFinite(number) ? `${number.toFixed(1)}%` : 'Unavailable');
    const bar = $(barId);
    if (bar) bar.style.width = `${bounded}%`;
}

function setSystemHealth(system) {
    const status = system.status || 'Normal';
    setText('systemHealthStatus', status === 'Normal' ? 'System healthy' : `System ${status.toLowerCase()}`);
    setText('systemHealthSummary', `CPU ${system.cpu_load.toFixed(1)}% · Memory ${system.ram_usage.toFixed(1)}% · Disk ${system.root_disk.toFixed(1)}%`);
    const card = $('systemHealthCard');
    const dot = $('systemHealthDot');
    if (card) card.dataset.status = status.toLowerCase();
    if (dot) dot.dataset.status = status.toLowerCase();
}

function loadSystemRecordingStorage() {
    fetch('/api/recordings', { credentials: 'include' })
        .then(response => response.json())
        .then(data => {
            if (!data.success) return;
            state.recordings = data.recordings || [];
            const total = state.recordings.reduce((sum, recording) => sum + (Number(recording.size_mb) || 0), 0);
            setText('systemRecordingStorage', `${total.toFixed(2)} MB`);
        })
        .catch(() => setText('systemRecordingStorage', 'Unavailable'));
}

function loadSystemIntegrationStatus() {
    fetch('/api/settings/alarm-wall', { credentials: 'include' })
        .then(response => response.json())
        .then(data => {
            const settings = data.settings || {};
            setText('systemAlarmWallStatus', settings.alarm_wall_enabled ? 'Enabled' : 'Disabled');
        })
        .catch(() => setText('systemAlarmWallStatus', 'Unavailable'));
    const online = state.cameras.filter(camera => (camera.status || 'online') !== 'offline').length;
    setText('systemCameraStatus', `${online} / ${state.cameras.length}`);
}

function updateMetricGauge(fieldId, value, needleId, cardSelector, trendId) {
    const needle = $(needleId);
    const card = document.querySelector(cardSelector);
    if (!needle || !card || typeof value !== 'number') return;

    const boundedValue = Math.min(100, Math.max(0, value));
    const rotation = -90 + (boundedValue * 180 / 100);
    needle.style.transform = `translateX(-50%) rotate(${rotation}deg)`;

    card.classList.toggle('low', boundedValue <= 50);
    card.classList.toggle('medium', boundedValue > 50 && boundedValue <= 75);
    card.classList.toggle('high', boundedValue > 75);

    if (trendId && fieldId === 'cpuLoad') {
        const trend = $(trendId);
        if (trend && _prevCpuLoad != null) {
            if (boundedValue > _prevCpuLoad) {
                trend.textContent = '↑';
                trend.classList.add('trend-up');
                trend.classList.remove('trend-down', 'trend-flat');
                card.classList.add('cpu-up');
                card.classList.remove('cpu-down', 'cpu-flat');
            } else if (boundedValue < _prevCpuLoad) {
                trend.textContent = '↓';
                trend.classList.add('trend-down');
                trend.classList.remove('trend-up', 'trend-flat');
                card.classList.add('cpu-down');
                card.classList.remove('cpu-up', 'cpu-flat');
            } else {
                trend.textContent = '→';
                trend.classList.add('trend-flat');
                trend.classList.remove('trend-up', 'trend-down');
                card.classList.add('cpu-flat');
                card.classList.remove('cpu-up', 'cpu-down');
            }
        }
    }

    if (fieldId === 'cpuLoad') {
        _prevCpuLoad = boundedValue;
    }
}

// Uptime ticker state
let _systemUptimeSeconds = null;
let _systemUptimeIntervalId = null;
let _prevCpuLoad = null;

function formatUptimeParts(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    let rem = totalSeconds % 86400;
    const hours = Math.floor(rem / 3600);
    rem = rem % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    return { days, hours, minutes, seconds };
}

function pad(n) { return n.toString().padStart(2, '0'); }

function updateUptimeDisplay() {
    if (_systemUptimeSeconds == null) return;
    const parts = formatUptimeParts(_systemUptimeSeconds);
    const daysEl = $('systemUptimeDays');
    const timeEl = $('systemUptimeTime');
    const barFill = $('uptimeBarFill');
    if (daysEl) daysEl.textContent = parts.days;
    if (timeEl) timeEl.textContent = `${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`;
    if (barFill) {
        // percent of current day elapsed
        const secondsToday = (_systemUptimeSeconds % 86400);
        const pct = Math.min(100, Math.max(0, (secondsToday / 86400) * 100));
        barFill.style.width = `${pct.toFixed(1)}%`;
    }
}

function startSystemUptimeTicker() {
    if (_systemUptimeIntervalId) clearInterval(_systemUptimeIntervalId);
    _systemUptimeIntervalId = setInterval(() => {
        if (_systemUptimeSeconds != null) {
            _systemUptimeSeconds += 1;
            updateUptimeDisplay();
        }
    }, 1000);
    updateUptimeDisplay();
}

function setSystemUptime(seconds) {
    _systemUptimeSeconds = Number(seconds) || 0;
    startSystemUptimeTicker();
}

function loadIntegrationSettings() {
    // Load system settings
    fetch('/api/settings')
        .then(res => res.json())
        .then(data => {
            if (data.success && data.settings) {
                const settings = data.settings;
                if ($('globalThreshold')) $('globalThreshold').value = settings.confidence_threshold || 70;
                if ($('detectionInterval')) $('detectionInterval').value = settings.detection_interval || 10;
                if ($('thresholdValue')) $('thresholdValue').textContent = (settings.confidence_threshold || 70) + '%';

                if ($('smtpServer')) $('smtpServer').value = settings.smtp_server || '';
                if ($('smtpPort')) $('smtpPort').value = settings.smtp_port || 2525;
                if ($('integrationSender')) $('integrationSender').value = settings.sender || '';
                if ($('integrationPassword')) $('integrationPassword').value = settings.password || '';
                if ($('integrationSecurity')) $('integrationSecurity').value = settings.security || 'none';
            }
        })
        .catch(err => {
            // Settings endpoint may not exist, use defaults
            if ($('globalThreshold')) $('globalThreshold').value = 70;
            if ($('detectionInterval')) $('detectionInterval').value = 10;
            if ($('thresholdValue')) $('thresholdValue').textContent = '70%';
        });

    loadNetworkSettings();
    loadAlarmWallSettings();

    // initialize settings tabs after loading defaults
    setTimeout(initSettingsTabs, 50);
}

function loadNetworkSettings() {
    fetch('/api/settings/network')
        .then(res => res.json())
        .then(data => {
            if (!data.success || !data.settings) {
                return;
            }
            const settings = data.settings;
            const useDhcp = settings.mode === 'dhcp';
            const networkDhcp = $('networkDhcp');
            const networkStatic = $('networkStatic');
            const dhcpHostname = $('dhcpHostname');
            const staticIp = $('staticIp');
            const staticSubnet = $('staticSubnet');
            const staticGateway = $('staticGateway');
            const staticDns = $('staticDns');

            if (networkDhcp && networkStatic) {
                networkDhcp.checked = useDhcp;
                networkStatic.checked = !useDhcp;
            }
            if (dhcpHostname) dhcpHostname.value = settings.dhcp_hostname || '';
            if (staticIp) staticIp.value = settings.static_ip || '';
            if (staticSubnet) staticSubnet.value = settings.static_subnet || '';
            if (staticGateway) staticGateway.value = settings.static_gateway || '';
            if (staticDns) staticDns.value = settings.static_dns || '';

            const current = settings.current_network || {};
            if ($('networkInterfaceName')) $('networkInterfaceName').textContent = current.interface || 'N/A';
            if ($('networkCurrentIp')) $('networkCurrentIp').textContent = current.ip || 'N/A';
            if ($('networkCurrentSubnet')) $('networkCurrentSubnet').textContent = current.subnet || 'N/A';
            if ($('networkCurrentGateway')) $('networkCurrentGateway').textContent = current.gateway || 'N/A';
            if ($('networkCurrentDns')) $('networkCurrentDns').textContent = Array.isArray(current.dns) ? current.dns.join(', ') : (current.dns || 'N/A');
            if ($('networkCurrentMac')) $('networkCurrentMac').textContent = current.mac || 'N/A';
            if (current.error && $('networkStatusMessage')) {
                setNetworkStatusMessage(`Unable to read current network info: ${current.error}`, true);
            }
        })
        .catch(() => {
            if ($('networkInterfaceName')) $('networkInterfaceName').textContent = 'N/A';
            if ($('networkCurrentIp')) $('networkCurrentIp').textContent = 'N/A';
            if ($('networkCurrentSubnet')) $('networkCurrentSubnet').textContent = 'N/A';
            if ($('networkCurrentGateway')) $('networkCurrentGateway').textContent = 'N/A';
            if ($('networkCurrentDns')) $('networkCurrentDns').textContent = 'N/A';
            if ($('networkCurrentMac')) $('networkCurrentMac').textContent = 'N/A';
            setNetworkStatusMessage('Unable to load current network info.', true);
        });
}

function saveAiDetectionSettings() {
    const payload = {
        confidence_threshold: $('globalThreshold') ? Number($('globalThreshold').value) : 70,
        detection_interval: $('detectionInterval') ? Number($('detectionInterval').value) : 10
    };

    fetch('/api/settings/thresholds', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('AI detection settings saved successfully.');
        } else {
            alert('Unable to save AI settings: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error saving AI detection settings:', err);
        alert('Unable to save AI settings at this time.');
    });
}

function saveSystemIntegrationSettings() {
    const payload = {
        device_id: $('deviceId') ? $('deviceId').value.trim() : '',
        smtp_server: $('smtpServer') ? $('smtpServer').value.trim() : '',
        smtp_port: $('smtpPort') ? Number($('smtpPort').value) : 2525,
        recipient_domain: $('recipientDomain') ? $('recipientDomain').value.trim() : '',
        sender: $('integrationSender') ? $('integrationSender').value.trim() : '',
        password: $('integrationPassword') ? $('integrationPassword').value : '',
        security: $('integrationSecurity') ? $('integrationSecurity').value : 'none'
    };

    fetch('/api/settings', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('System integration settings saved successfully.');
        } else {
            alert('Unable to save settings: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error saving system integration settings:', err);
        alert('Unable to save settings at this time.');
    });
}

function setNetworkStatusMessage(message, isError = false) {
    const statusEl = $('networkStatusMessage');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('success', !!message && !isError);
    statusEl.classList.toggle('error', !!message && isError);
}

function saveNetworkSettings() {
    const networkDhcp = $('networkDhcp');
    const mode = networkDhcp && networkDhcp.checked ? 'dhcp' : 'static';
    const payload = {
        mode,
        dhcp_hostname: $('dhcpHostname') ? $('dhcpHostname').value.trim() : '',
        static_ip: $('staticIp') ? $('staticIp').value.trim() : '',
        static_subnet: $('staticSubnet') ? $('staticSubnet').value.trim() : '',
        static_gateway: $('staticGateway') ? $('staticGateway').value.trim() : '',
        static_dns: $('staticDns') ? $('staticDns').value.trim() : ''
    };

    setNetworkStatusMessage('Saving network settings...');

    fetch('/api/settings/network', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            setNetworkStatusMessage('Network settings saved successfully.');
            loadNetworkSettings();
        } else {
            const message = data.error || 'Unable to save network settings.';
            setNetworkStatusMessage(message, true);
            console.error('Network settings save failed:', data);
        }
    })
    .catch(err => {
        console.error('Error saving network settings:', err);
        setNetworkStatusMessage('Unable to save network settings at this time.', true);
    });
}

function initSettingsTabs() {
    const tabs = document.querySelectorAll('.settings-tab');
    const panels = document.querySelectorAll('.settings-panel');
    if (!tabs || tabs.length === 0) return;

    function activate(tabEl) {
        const target = tabEl.dataset.tab;
        tabs.forEach(t => t.classList.toggle('active', t === tabEl));
        panels.forEach(p => p.style.display = (p.dataset.panel === target) ? '' : 'none');
    }

    tabs.forEach(t => {
        t.onclick = (e) => {
            e.preventDefault();
            activate(t);
        };
    });

    // ensure one active
    const active = document.querySelector('.settings-tab.active') || tabs[0];
    if (active) activate(active);
}

function initCaptureTabs() {
    const tabs = document.querySelectorAll('.capture-tab');
    const panels = document.querySelectorAll('.capture-panel');
    if (!tabs || tabs.length === 0) return;

    function activate(tabEl) {
        const target = tabEl.dataset.captureTab;
        tabs.forEach(t => t.classList.toggle('active', t === tabEl));
        panels.forEach(panel => {
            const isActive = panel.dataset.capturePanel === target;
            panel.classList.toggle('active', isActive);
        });
    }

    tabs.forEach(tab => {
        tab.onclick = (event) => {
            event.preventDefault();
            activate(tab);
        };
    });

    const active = document.querySelector('.capture-tab.active') || tabs[0];
    if (active) activate(active);
}

function updateCaptureOverview() {
    const totalCameras = state.cameras.length;
    const totalRecordings = state.recordings.length;
    const pendingAlerts = state.stats.unacknowledged || 0;
    const totalStorageMb = state.recordings.reduce((sum, rec) => sum + (Number(rec.size_mb) || 0), 0);

    const camerasEl = $('captureOverviewCameras');
    const recordingsEl = $('captureOverviewRecordings');
    const alertsEl = $('captureOverviewAlerts');
    const storageEl = $('captureOverviewStorage');

    if (camerasEl) camerasEl.textContent = totalCameras;
    if (recordingsEl) recordingsEl.textContent = totalRecordings;
    if (alertsEl) alertsEl.textContent = pendingAlerts;
    if (storageEl) storageEl.textContent = `${totalStorageMb.toFixed(1)} MB`;
}

function renderCameras() {
    const grid = $('cameraGrid');
    const mgmt = $('cameraManagement');
    
    // Camera Grid (Dashboard)
    if (grid) {
        if (state.cameras.length === 0) {
            grid.innerHTML = `<div class="empty-state">No cameras configured. <button class="btn btn-primary" onclick="showAddCamera()">Add your first camera</button></div>`;
        } else {
            grid.innerHTML = state.cameras.map(cam => {
                const isMotionActive = !!state.motionActiveCameras[cam.id];
                return `
                    <div class="camera-card draggable" draggable="true" data-camera-id="${cam.id}" ${isMotionActive ? 'data-motion-active="true"' : ''}>
                        <div class="camera-preview">
                            <span class="camera-placeholder"><i data-lucide="video"></i></span>
                            <span class="overlay-label">${cam.location || 'Unknown'}</span>
                            <span class="motion-badge">${isMotionActive ? 'Motion' : 'Standby'}</span>
                        </div>
                        <div class="camera-info">
                            <div>
                                <div class="camera-name">${cam.name}</div>
                            </div>
                            <span class="camera-status ${cam.status || 'online'}">${cam.status || 'Online'}</span>
                        </div>
                        <div class="camera-actions">
                            <button class="btn btn-sm icon-action-btn" title="Preview camera" aria-label="Preview camera" onclick="event.stopPropagation(); openCameraPreview(${cam.id})"><i data-lucide="eye"></i></button>
                            <button class="btn btn-sm icon-action-btn" title="Edit camera" aria-label="Edit camera" onclick="event.stopPropagation(); editCamera(${cam.id})"><i data-lucide="pencil"></i></button>
                            <button class="btn btn-sm icon-action-btn" title="Add motion rule" aria-label="Add motion rule" onclick="event.stopPropagation(); openZoneEditor(${cam.id})"><i data-lucide="scan-line"></i></button>
                        </div>
                    </div>
                `;
            }).join('');

            grid.querySelectorAll('.camera-card.draggable').forEach(card => {
                card.addEventListener('dragstart', handleCameraDragStart);
                card.addEventListener('dragend', handleCameraDragEnd);
                card.addEventListener('dragover', handleCameraDragOver);
                card.addEventListener('dragleave', handleCameraDragLeave);
                card.addEventListener('drop', handleCameraDrop);
            });
        }
    }
    
    // Camera Management (Cameras tab)
    if (mgmt) {
        if (state.cameras.length === 0) {
            mgmt.innerHTML = `<div class="empty-state">No cameras configured. Click "Add Camera" to get started.</div>`;
        } else {
            mgmt.innerHTML = `
                <div class="camera-grid-list">
                    ${state.cameras.map(cam => `
                        <div class="camera-feed-card">
                            <div class="camera-feed-preview">
                                <div class="camera-feed-screen">
                                    <div class="feed-status-row">
                                        <span class="feed-status ${cam.status === 'offline' ? 'offline' : ''}">${cam.status || 'Online'}</span>
                                        <span id="recording-status-${cam.id}" class="feed-recording-status ${state.recordingCameras[cam.id] ? 'recording' : ''}"><i data-lucide="${state.recordingCameras[cam.id] ? 'circle-stop' : 'circle'}"></i>${state.recordingCameras[cam.id] ? 'Recording' : 'Ready'}</span>
                                    </div>
                                </div>
                            </div>
                            <div class="camera-feed-info">
                                <div class="camera-name">${cam.name}</div>
                                <div class="camera-location">${cam.location || 'Unknown location'}</div>
                                <div class="camera-ip">IP: ${cam.ip || 'N/A'}</div>
                                <div class="camera-feed-actions">
                                    <button class="btn btn-sm icon-action-btn" title="Edit camera" aria-label="Edit camera" onclick="editCamera(${cam.id})"><i data-lucide="pencil"></i></button>
                                    <button class="btn btn-sm icon-action-btn" id="rec-btn-${cam.id}" title="Start recording" aria-label="Start recording" onclick="toggleRecording(${cam.id}, '${cam.name}')"><i data-lucide="circle"></i></button>
                                    <button class="btn btn-sm btn-danger icon-action-btn" title="Delete camera" aria-label="Delete camera" onclick="deleteCamera(${cam.id})"><i data-lucide="trash-2"></i></button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    }
    
    // Load and render recordings
    loadRecordings();
}

function getRuleLabel(ruleType) {
    const normalized = (ruleType || '').toString().toLowerCase();
    if (normalized === 'human') return 'Human';
    if (normalized === 'car' || normalized === 'vehicle') return 'Car';
    return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : '';
}

function getRuleIcon(ruleType) {
    const normalized = (ruleType || '').toString().toLowerCase();
    if (normalized === 'human') return '<i data-lucide="user-round"></i>';
    if (normalized === 'car' || normalized === 'vehicle') return '<i data-lucide="car"></i>';
    return '<i data-lucide="scan-line"></i>';
}

function getSavedCameraOrder() {
    try {
        const raw = localStorage.getItem('cameraOrder');
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function saveCameraOrder(order) {
    try {
        localStorage.setItem('cameraOrder', JSON.stringify(order));
    } catch (err) {
        console.error('Unable to save camera order:', err);
    }
}

function applySavedCameraOrder(cameras) {
    const order = getSavedCameraOrder();
    if (!Array.isArray(order) || order.length === 0) return cameras;

    const cameraMap = new Map(cameras.map(cam => [cam.id, cam]));
    const ordered = [];
    order.forEach(id => {
        if (cameraMap.has(id)) {
            ordered.push(cameraMap.get(id));
            cameraMap.delete(id);
        }
    });

    return ordered.concat(Array.from(cameraMap.values()));
}

function normalizeAlert(alert) {
    const normalizedType = (alert.object_detected || 'human').toString().toLowerCase();
    let object_detected = normalizedType;
    if (normalizedType === 'person') object_detected = 'human';
    if (normalizedType === 'vehicle') object_detected = 'car';
    return {
        ...alert,
        object_detected,
        zone: typeof alert.zone === 'object' ? (alert.zone.name || 'Unknown zone') : (alert.zone || 'Unknown zone')
    };
}


function updateAlertBadge() {
    const badge = $('alertBadge');
    if (!badge) return;
    const pending = state.alerts.filter(a => !a.acknowledged).length;
    badge.textContent = pending;
    badge.style.display = pending > 0 ? 'inline' : 'none';
}

// ===== ALERT ACTIONS =====
async function acknowledgeAlert(alertId) {
    try {
        const res = await fetch(`/api/alerts/${alertId}/acknowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: currentUser?.username || 'Admin' })
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Request failed (${res.status}): ${text}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`Expected JSON response, got ${contentType}: ${text}`);
        }

        const data = await res.json();
        if (data.success) {
            refreshAlerts();
            console.log('Alert acknowledged');
        }
    } catch (err) {
        console.error('Error acknowledging alert:', err);
        alert(`Unable to acknowledge alert. ${err.message}`);
    }
}

function refreshAlerts() {
    fetch('/api/alerts?limit=50')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                state.alerts = data.alerts.map(normalizeAlert);
                updateAlertBadge();
            }
        })
        .catch(err => console.error('Error refreshing alerts:', err));
}

let draggedCameraId = null;

function handleCameraDragStart(event) {
    const card = event.currentTarget;
    draggedCameraId = card.dataset.cameraId;
    card.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
}

function handleCameraDragEnd(event) {
    event.currentTarget.classList.remove('dragging');
    draggedCameraId = null;
}

function handleCameraDragOver(event) {
    event.preventDefault();
    if (!event.currentTarget.classList.contains('drag-over')) {
        event.currentTarget.classList.add('drag-over');
    }
}

function handleCameraDragLeave(event) {
    event.currentTarget.classList.remove('drag-over');
}

function handleCameraDrop(event) {
    event.preventDefault();
    const targetId = event.currentTarget.dataset.cameraId;
    event.currentTarget.classList.remove('drag-over');
    if (!draggedCameraId || draggedCameraId === targetId) return;
    reorderCameraCards(parseInt(draggedCameraId, 10), parseInt(targetId, 10));
}

function reorderCameraCards(fromId, toId) {
    const fromIndex = state.cameras.findIndex(cam => cam.id === fromId);
    const toIndex = state.cameras.findIndex(cam => cam.id === toId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

    const [moved] = state.cameras.splice(fromIndex, 1);
    state.cameras.splice(toIndex, 0, moved);
    saveCameraOrder(state.cameras.map(cam => cam.id));
    renderCameras();
}
function renderMotionPopup(alert) {
    if (!alert || !['human', 'car'].includes(alert.object_detected)) return;
    if (!getCameraById(alert.camera_id)) return;
    const area = $('motionPopupArea');
    if (!area) return;

    const clipEl = document.createElement('div');
    clipEl.className = 'motion-clip';
    clipEl.dataset.cameraId = alert.camera_id;
    clipEl.innerHTML = `
        <div class="clip-icon">${getRuleIcon(alert.object_detected)}</div>
        <h4>${getRuleLabel(alert.object_detected)} detected</h4>
        <div class="clip-meta"><span>${alert.camera_name || 'Camera'}</span><span>${alert.zone || 'Unknown zone'}</span></div>
        <div class="clip-duration">10s clip</div>
    `;

    area.prepend(clipEl);
    setTimeout(() => {
        clipEl.remove();
    }, 10000);
}

function clearMotionClipsForCamera(cameraId) {
    const area = $('motionPopupArea');
    if (!area) return;
    const clips = area.querySelectorAll('.motion-clip');
    clips.forEach(clip => {
        if (clip.dataset.cameraId && clip.dataset.cameraId.toString() === cameraId.toString()) {
            clip.remove();
        }
    });
}

// ===== CAMERA MANAGEMENT =====nlet editingCameraId = null;

function showAddCamera() {
    editingCameraId = null;
    $('addCameraModal').classList.add('show');
    // Reset form
    $('camName').value = '';
    $('camLocation').value = '';
    $('camRTSP').value = '';
    $('camRTSPUsername').value = '';
    $('camRTSPPassword').value = '';
    $('camThreshold').value = 70;
    $('camThresholdValue').textContent = '70%';
}

function closeModal() {
    document.querySelectorAll('.modal').forEach(modal => modal.classList.remove('show'));
    activeZoneCameraId = null;
    activeZoneEditingIndex = null;
    zonePoints = [];
}

function editCamera(cameraId) {
    const camera = state.cameras.find(cam => cam.id === cameraId);
    if (!camera) return;

    editingCameraId = cameraId;
    $('editCamName').value = camera.name || '';
    $('editCamLocation').value = camera.location || '';
    $('editCamIP').value = camera.ip || '';
    $('editCamRTSP').value = camera.rtsp_url || '';
    $('editCamRTSPUsername').value = camera.rtsp_username || '';
    $('editCamRTSPPassword').value = camera.rtsp_password || '';
    $('editCamThreshold').value = camera.confidence_threshold || 70;
    $('editCamThresholdValue').textContent = `${camera.confidence_threshold || 70}%`;
    $('editCamZones').value = (camera.zones || []).join(', ');
    $('editCamDetectHumans').checked = camera.object_types ? camera.object_types.includes('human') : true;
    $('editCamDetectCars').checked = camera.object_types ? camera.object_types.includes('car') : true;
    $('editCameraModal').classList.add('show');
}

function saveCamera() {
    const data = {
        name: $('camName').value || `Camera ${state.cameras.length + 1}`,
        location: $('camLocation').value || 'Unknown',
        rtsp_url: $('camRTSP').value || '',
        rtsp_username: $('camRTSPUsername').value || '',
        rtsp_password: $('camRTSPPassword').value || '',
        confidence_threshold: parseInt($('camThreshold').value) || 70,
        zones: [],
        object_types: ['human', 'car']
    };

    if (editingCameraId) {
        const editObjectTypes = [];
        if ($('editCamDetectHumans')?.checked) editObjectTypes.push('human');
        if ($('editCamDetectCars')?.checked) editObjectTypes.push('car');

        const editData = {
            name: $('editCamName').value || data.name,
            location: $('editCamLocation').value || data.location,
            ip: $('editCamIP').value || data.ip,
            rtsp_url: $('editCamRTSP').value || '',
            rtsp_username: $('editCamRTSPUsername').value || '',
            rtsp_password: $('editCamRTSPPassword').value || '',
            confidence_threshold: parseInt($('editCamThreshold').value) || 70,
            zones: $('editCamZones').value ? $('editCamZones').value.split(',').map(s => s.trim()) : ['Zone 1', 'Zone 2'],
            object_types: editObjectTypes
        };

        fetch(`/api/cameras/${editingCameraId}`, {
            method: 'PUT',
            headers: actorHeaders(),
            body: JSON.stringify(editData)
        })
        .then(res => res.json())
        .then(response => {
            if (response.success) {
                const index = state.cameras.findIndex(cam => cam.id === editingCameraId);
                if (index !== -1) state.cameras[index] = response.camera;
                renderAll();
                closeModal();
                editingCameraId = null;
            } else {
                alert('Error updating camera: ' + (response.error || 'Unknown error'));
            }
        })
        .catch(err => {
            console.error('Error updating camera:', err);
            alert('Error updating camera. See console for details.');
        });
        return;
    }
    
    fetch('/api/cameras', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(data)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            state.cameras.push(data.camera);
            renderAll();
            closeModal();
        } else {
            alert('Error adding camera: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error saving camera:', err);
        alert('Error saving camera. See console for details.');
    });
}

// Removed camera connection toggle button; keep backend route available if needed

let activeZoneCameraId = null;
let activeZoneEditingIndex = null;
let zoneEditorMode = 'add';
let zonePoints = [];
let zoneCanvas = null;
let zoneContext = null;
let draggingPointIndex = null;
let isDraggingPoint = false;
let dragOffset = { x: 0, y: 0 };
const ZONE_POINT_RADIUS = 8;

function setZoneEditorMode(mode) {
    zoneEditorMode = mode;
    const zoneNameInput = $('zoneName');
    const zoneTypeSelect = $('zoneObjectType');
    const saveBtn = $('zoneSaveBtn');
    const headerTitle = document.querySelector('#zoneEditorModal .modal-header h3');
    const hint = document.querySelector('.zone-editor-hint');

    if (zoneNameInput) zoneNameInput.disabled = mode === 'view';
    if (zoneTypeSelect) zoneTypeSelect.disabled = mode === 'view';
    if (saveBtn) saveBtn.style.display = mode === 'view' ? 'none' : 'inline-block';

    if (headerTitle) {
        if (mode === 'add') headerTitle.textContent = '🧭 Add Detection Zone';
        else if (mode === 'edit') headerTitle.textContent = '🧭 Edit Detection Zone';
        else headerTitle.textContent = '🧭 View Detection Zone';
    }
    if (hint) {
        if (mode === 'view') {
            hint.textContent = 'Existing zones are read-only. Click Edit to modify this zone.';
        } else if (mode === 'edit') {
            hint.textContent = 'Modify the selected zone by dragging points or changing the rule, then save your changes.';
        } else {
            hint.textContent = 'Draw a motion trigger area for the selected camera by clicking and dragging on the preview.';
        }
    }
}

function getLegacyZoneType(camera) {
    if (!camera || !Array.isArray(camera.object_types) || camera.object_types.length === 0) {
        return 'human';
    }
    return (camera.object_types[0] || 'human').toString().toLowerCase();
}

function normalizeZoneItem(zone, camera) {
    if (!zone) return { name: 'Zone', object_type: getLegacyZoneType(camera), points: [] };
    if (typeof zone === 'string') {
        return { name: zone, object_type: getLegacyZoneType(camera), points: [] };
    }
    const rawType = zone.object_type || zone.type || zone.objectType || getLegacyZoneType(camera);
    const objectType = typeof rawType === 'string' ? rawType.toLowerCase() : 'human';
    return {
        name: zone.name || 'Zone',
        object_type: objectType,
        points: Array.isArray(zone.points) ? zone.points : []
    };
}

function normalizeCameraZones(camera) {
    if (!camera || !Array.isArray(camera.zones)) return [];
    return camera.zones.map(zone => normalizeZoneItem(zone, camera));
}

function getCurrentCameraZones() {
    const camera = state.cameras.find(cam => cam.id === activeZoneCameraId);
    return normalizeCameraZones(camera);
}

function openZoneEditor(cameraId, editIndex = null) {
    activeZoneCameraId = cameraId;
    activeZoneEditingIndex = editIndex;
    zonePoints = [];
    $('zoneName').value = '';
    $('zoneObjectType').value = 'human';

    const zones = getCurrentCameraZones();
    if (activeZoneEditingIndex !== null && zones[activeZoneEditingIndex]) {
        const zone = zones[activeZoneEditingIndex];
        $('zoneName').value = zone.name;
        $('zoneObjectType').value = zone.object_type;
        zonePoints = [...zone.points];
        setZoneEditorMode('edit');
    } else {
        setZoneEditorMode('add');
    }

    renderZoneList();
    $('zoneEditorModal').classList.add('show');
    setTimeout(initZoneCanvas, 50);
}

function selectZone(index) {
    if (activeZoneCameraId == null) return;
    activeZoneEditingIndex = index;
    const zones = getCurrentCameraZones();
    const zone = zones[index];
    if (!zone) return;

    $('zoneName').value = zone.name;
    $('zoneObjectType').value = zone.object_type;
    zonePoints = [...zone.points];
    setZoneEditorMode('view');
    renderZoneList();
    drawZoneCanvas();
}

function saveExistingZone(index) {
    if (activeZoneCameraId == null) return;
    const modalVisible = document.querySelector('#zoneEditorModal')?.classList.contains('show');
    if (modalVisible && activeZoneEditingIndex === index && zoneEditorMode === 'edit') {
        stageZoneChanges(index);
        return;
    }
    openZoneEditor(activeZoneCameraId, index);
}

function stageZoneChanges(index) {
    if (activeZoneCameraId == null) return;
    const camera = state.cameras.find(cam => cam.id === activeZoneCameraId);
    if (!camera) return;

    const zoneName = $('zoneName').value.trim() || 'New Zone';
    const objectType = $('zoneObjectType').value;
    if (zonePoints.length < 3) {
        alert('Please draw at least 3 points to save a zone.');
        return;
    }

    const updatedZone = {
        name: zoneName,
        object_type: objectType,
        points: zonePoints.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) }))
    };

    const zones = normalizeCameraZones(camera);
    if (zones[index]) {
        zones[index] = updatedZone;
    } else {
        zones.push(updatedZone);
    }

    camera.zones = zones;
    zonePoints = [...updatedZone.points];
    activeZoneEditingIndex = index;
    setZoneEditorMode('edit');
    renderZoneList();
    drawZoneCanvas();
}

function renderZoneList() {
    const zoneListEl = $('zoneList');
    if (!zoneListEl) return;

    const camera = state.cameras.find(cam => cam.id === activeZoneCameraId);
    const zones = normalizeCameraZones(camera);
    if (zones.length === 0) {
        zoneListEl.innerHTML = '<div class="zone-list-empty">No existing zones yet. Add one by drawing on the canvas.</div>';
        return;
    }

    zoneListEl.innerHTML = `
        <div class="zone-list-title">Existing Zones</div>
        <div class="zone-list-items">
            ${zones.map((zone, index) => `
                <div class="zone-list-item ${activeZoneEditingIndex === index ? 'selected' : ''} zone-type-${(zone.object_type || 'human').toLowerCase()}" onclick="selectZone(${index})">
                    <div class="zone-list-meta">
                        <span class="zone-name">${index + 1}. ${zone.name}</span>
                        <span class="zone-type">${zone.object_type}</span>
                        <span class="zone-count">${zone.points.length} pts</span>
                    </div>
                    <div class="zone-actions">
                        <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); saveExistingZone(${index})">${activeZoneEditingIndex === index && zoneEditorMode === 'edit' ? '💾 Save' : '✏️ Edit'}</button>
                        <button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); deleteZone(${index})"><i data-lucide="trash-2"></i> Delete</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renameZone(index) {
    if (activeZoneCameraId == null) return;
    const camera = state.cameras.find(cam => cam.id === activeZoneCameraId);
    const zones = normalizeCameraZones(camera);
    if (!zones[index]) return;

    const currentName = zones[index].name;
    const newName = prompt('Rename zone:', currentName);
    if (!newName || newName.trim() === '' || newName.trim() === currentName) return;

    zones[index].name = newName.trim();
    const payload = {
        zones,
        object_types: camera.object_types || []
    };

    fetch(`/api/cameras/${activeZoneCameraId}`, {
        method: 'PUT',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(response => {
        if (response.success) {
            const camIndex = state.cameras.findIndex(cam => cam.id === activeZoneCameraId);
            if (camIndex !== -1) state.cameras[camIndex] = response.camera;
            renderZoneList();
        } else {
            alert('Error renaming zone: ' + (response.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error renaming zone:', err);
        alert('Error renaming zone. See console for details.');
    });
}

function deleteZone(index) {
    if (activeZoneCameraId == null) return;
    const camera = state.cameras.find(cam => cam.id === activeZoneCameraId);
    const zones = normalizeCameraZones(camera);
    if (!zones[index]) return;

    if (!confirm(`Delete zone "${zones[index].name}"?`)) return;

    zones.splice(index, 1);
    const payload = {
        zones,
        object_types: camera.object_types || []
    };

    fetch(`/api/cameras/${activeZoneCameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(response => {
        if (response.success) {
            const camIndex = state.cameras.findIndex(cam => cam.id === activeZoneCameraId);
            if (camIndex !== -1) state.cameras[camIndex] = response.camera;
            renderZoneList();
        } else {
            alert('Error deleting zone: ' + (response.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error deleting zone:', err);
        alert('Error deleting zone. See console for details.');
    });
}

function initZoneCanvas() {
    const canvas = $('zoneCanvas');
    if (!canvas) return;
    zoneCanvas = canvas;
    zoneContext = canvas.getContext('2d');
    drawZoneCanvas();

    canvas.onmousedown = (event) => {
        if (zoneEditorMode === 'view') return;
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
        const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
        const hitIndex = findPointHit(x, y);
        if (hitIndex >= 0) {
            draggingPointIndex = hitIndex;
            isDraggingPoint = true;
            dragOffset.x = zonePoints[hitIndex].x - x;
            dragOffset.y = zonePoints[hitIndex].y - y;
            drawZoneCanvas();
            return;
        }

        zonePoints.push({ x, y });
        drawZoneCanvas();
    };

    canvas.onmousemove = (event) => {
        if (zoneEditorMode === 'view') return;
        if (!isDraggingPoint || draggingPointIndex === null) return;
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
        const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
        zonePoints[draggingPointIndex].x = clamp(x + dragOffset.x, 0, canvas.width);
        zonePoints[draggingPointIndex].y = clamp(y + dragOffset.y, 0, canvas.height);
        drawZoneCanvas();
    };

    canvas.onmouseup = () => {
        isDraggingPoint = false;
        draggingPointIndex = null;
    };

    canvas.onmouseleave = () => {
        isDraggingPoint = false;
        draggingPointIndex = null;
    };

    const zoneTypeSelect = $('zoneObjectType');
    if (zoneTypeSelect) {
        zoneTypeSelect.onchange = drawZoneCanvas;
    }

    drawZoneCanvas();
}

function getZoneColor(objectType = 'human', light = false, highlight = false) {
    const type = (objectType || 'human').toString().toLowerCase();
    const selected = highlight ? '' : '';
    switch (type) {
        case 'car':
        case 'vehicle':
            return light
                ? { stroke: 'rgba(255, 82, 82, 0.3)', fill: 'rgba(255, 82, 82, 0.08)', point: '#ffb3b3' }
                : { stroke: highlight ? '#ff1744' : '#ff5252', fill: highlight ? 'rgba(255, 82, 82, 0.25)' : 'rgba(255, 82, 82, 0.18)', point: '#ffb3b3' };
        case 'animal':
            return light
                ? { stroke: 'rgba(178, 102, 255, 0.3)', fill: 'rgba(178, 102, 255, 0.08)', point: '#d8b3ff' }
                : { stroke: highlight ? '#9b4dff' : '#b266ff', fill: highlight ? 'rgba(178, 102, 255, 0.22)' : 'rgba(178, 102, 255, 0.18)', point: '#d8b3ff' };
        default:
            return light
                ? { stroke: 'rgba(124, 183, 255, 0.3)', fill: 'rgba(124, 183, 255, 0.08)', point: '#62d6aa' }
                : { stroke: highlight ? '#4eaaff' : '#7cb7ff', fill: highlight ? 'rgba(124, 183, 255, 0.3)' : 'rgba(124, 183, 255, 0.25)', point: '#62d6aa' };
    }
}

function drawZoneCanvas() {
    if (!zoneCanvas || !zoneContext) return;
    const cameraZones = getCurrentCameraZones();
    zoneContext.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height);
    zoneContext.fillStyle = 'rgba(45, 52, 54, 0.96)';
    zoneContext.fillRect(0, 0, zoneCanvas.width, zoneCanvas.height);

    cameraZones.forEach((zone, index) => {
        if (!zone.points || zone.points.length < 2) return;
        const isSelectedZone = activeZoneEditingIndex === index;
        const colors = getZoneColor(zone.object_type, true, isSelectedZone);
        zoneContext.beginPath();
        zoneContext.moveTo(zone.points[0].x, zone.points[0].y);
        for (let i = 1; i < zone.points.length; i++) {
            zoneContext.lineTo(zone.points[i].x, zone.points[i].y);
        }
        zoneContext.closePath();
        zoneContext.strokeStyle = colors.stroke;
        zoneContext.lineWidth = isSelectedZone ? 3 : 1.5;
        zoneContext.stroke();
        zoneContext.fillStyle = colors.fill;
        zoneContext.fill();
    });

    if (zonePoints.length >= 2) {
        const colors = getZoneColor($('zoneObjectType').value || 'human', false, true);
        zoneContext.beginPath();
        zoneContext.moveTo(zonePoints[0].x, zonePoints[0].y);
        for (let i = 1; i < zonePoints.length; i++) {
            zoneContext.lineTo(zonePoints[i].x, zonePoints[i].y);
        }
        zoneContext.closePath();
        zoneContext.strokeStyle = colors.stroke;
        zoneContext.lineWidth = 2;
        zoneContext.stroke();
        zoneContext.fillStyle = colors.fill;
        zoneContext.fill();
    }

    zonePoints.forEach((point, index) => {
        const isDragging = index === draggingPointIndex && isDraggingPoint;
        const colors = getZoneColor($('zoneObjectType').value || 'human', false, isDragging);
        zoneContext.beginPath();
        zoneContext.arc(point.x, point.y, ZONE_POINT_RADIUS, 0, Math.PI * 2);
        zoneContext.fillStyle = colors.fill;
        zoneContext.fill();
        zoneContext.strokeStyle = colors.stroke;
        zoneContext.lineWidth = 2;
        zoneContext.stroke();
        zoneContext.fillStyle = '#fff';
        zoneContext.font = '12px sans-serif';
        zoneContext.fillText(index + 1, point.x + 10, point.y - 8);
    });
}

function findPointHit(x, y) {
    return zonePoints.findIndex(point => {
        return Math.hypot(point.x - x, point.y - y) <= ZONE_POINT_RADIUS;
    });
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function saveZone() {
    if (!activeZoneCameraId) return;
    const camera = state.cameras.find(cam => cam.id === activeZoneCameraId);
    if (!camera) return;

    if (zonePoints.length < 3) {
        alert('Please draw at least 3 points to create a zone.');
        return;
    }

    const zoneName = $('zoneName').value.trim() || 'New Zone';
    const objectType = $('zoneObjectType').value;
    const zone = {
        name: zoneName,
        object_type: objectType,
        points: zonePoints.map(point => ({ x: Math.round(point.x), y: Math.round(point.y) }))
    };

    const zones = normalizeCameraZones(camera);
    if (activeZoneEditingIndex !== null && zones[activeZoneEditingIndex]) {
        zones[activeZoneEditingIndex] = zone;
    } else {
        zones.push(zone);
    }

    const updatedObjectTypes = Array.from(new Set([...(camera.object_types || []), objectType]));
    const payload = {
        zones,
        object_types: updatedObjectTypes
    };

    fetch(`/api/cameras/${activeZoneCameraId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(response => {
        if (response.success) {
            const index = state.cameras.findIndex(cam => cam.id === activeZoneCameraId);
            if (index !== -1) state.cameras[index] = response.camera;
            renderAll();
            closeModal();
            activeZoneCameraId = null;
            zonePoints = [];
        } else {
            alert('Error saving zone: ' + (response.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error saving zone:', err);
        alert('Error saving zone.');
    });
}

function deleteCamera(cameraId) {
    if (!confirm('Are you sure you want to delete this camera?')) return;
    
    fetch(`/api/cameras/${cameraId}`, {
        method: 'DELETE',
        headers: actorHeaders()
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            state.cameras = state.cameras.filter(c => c.id !== cameraId);
            state.alerts = state.alerts.filter(a => a.camera_id !== cameraId);
            delete state.motionActiveCameras[cameraId];
            renderAll();
        } else {
            alert('Error deleting camera: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => console.error('Error deleting camera:', err));
}

function toggleRecording(cameraId, cameraName) {
    const isRecording = state.recordingCameras[cameraId];
    const endpoint = isRecording ? `/api/recordings/${cameraId}/stop` : `/api/recordings/${cameraId}/start`;
    const method = 'POST';
    
    fetch(endpoint, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera_id: cameraId, camera_name: cameraName })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            state.recordingCameras[cameraId] = !isRecording;
            const btn = $(`rec-btn-${cameraId}`);
            const status = $(`recording-status-${cameraId}`);
            if (btn) {
                if (state.recordingCameras[cameraId]) {
                    btn.innerHTML = '<i data-lucide="square"></i>';
                    btn.title = 'Stop recording';
                    btn.setAttribute('aria-label', 'Stop recording');
                    btn.style.background = '#ff6b6b';
                    btn.style.color = 'white';
                } else {
                    btn.innerHTML = '<i data-lucide="circle"></i>';
                    btn.title = 'Start recording';
                    btn.setAttribute('aria-label', 'Start recording');
                    btn.style.background = '';
                    btn.style.color = '';
                }
                refreshIcons();
            }
            if (status) {
                status.className = `feed-recording-status ${state.recordingCameras[cameraId] ? 'recording' : ''}`;
                status.innerHTML = `<i data-lucide="${state.recordingCameras[cameraId] ? 'circle-stop' : 'circle'}"></i>${state.recordingCameras[cameraId] ? 'Recording' : 'Ready'}`;
                refreshIcons();
            }
            alert(`Recording ${isRecording ? 'stopped' : 'started'} for ${cameraName}`);
        } else {
            alert('Error: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error toggling recording:', err);
        alert('Error toggling recording');
    });
}

let currentPlayingRecording = null;

function loadRecordings() {
    fetch('/api/recordings')
        .then(res => res.json())
        .then(data => {
            if (!data.success) return;
            state.recordings = data.recordings || [];
            renderRecordings(state.recordings);
            renderCapturePanels();
            updateCaptureOverview();
        })
        .catch(err => console.error('Error loading recordings:', err));
}

function renderRecordings(recordings) {
    state.recordings = recordings || [];
    const container = $('recordingsContainer');
    if (!container) return;
    
    if (recordings.length === 0) {
        container.innerHTML = '<div class="empty-recordings">No recordings yet. Start recording from the Captures tab to archive video clips.</div>';
        renderCapturePanels();
        updateCaptureOverview();
        return;
    }
    
    container.innerHTML = recordings.map(rec => {
        const startTime = new Date(rec.started_at).toLocaleString();
        const duration = Math.round(rec.duration) || 0;
        const durationStr = duration > 60 ? `${Math.floor(duration/60)}m ${duration%60}s` : `${duration}s`;
        
        return `
            <div class="recording-card" onclick="playRecording(${rec.id})">
                <div class="recording-thumbnail"><i data-lucide="clapperboard"></i></div>
                <div class="recording-info">
                    <div class="recording-name">${rec.camera_name}</div>
                    <div class="recording-meta">Created: ${startTime}</div>
                    <div class="recording-meta">Duration: ${durationStr}</div>
                    <div class="recording-meta">Size: ${(rec.size_mb || 0).toFixed(2)} MB</div>
                    ${rec.archived ? '<div class="recording-meta" style="color: #ffd93d;">📦 Archived</div>' : ''}
                </div>
                <div class="recording-actions" onclick="event.stopPropagation()">
                    <button class="btn btn-sm" onclick="playRecording(${rec.id})"><i data-lucide="play"></i> Play</button>
                    <button class="btn btn-sm" onclick="downloadRecording(${rec.id})"><i data-lucide="download"></i> Download</button>
                </div>
            </div>
        `;
    }).join('');
    renderCapturePanels();
    updateCaptureOverview();
}

function playRecording(recordingId) {
    fetch(`/api/recordings/${recordingId}`)
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                alert('Recording not found');
                return;
            }
            
            const recording = data.recording;
            currentPlayingRecording = recording;
            
            const modal = $('videoPlaybackModal');
            const title = $('videoTitle');
            const camera = $('videoCamera');
            const duration = $('videoDuration');
            const size = $('videoSize');
            const created = $('videoCreated');
            const player = $('videoPlayer');
            
            if (title) title.textContent = recording.filename;
            if (camera) camera.textContent = recording.camera_name;
            if (duration) duration.textContent = formatDuration(recording.duration);
            if (size) size.textContent = `${(recording.size_mb || 0).toFixed(2)} MB`;
            if (created) created.textContent = new Date(recording.created_at).toLocaleString();
            
            if (player) {
                player.src = `/recordings/${recording.filename}`;
                player.load();
            }
            
            showModal('videoPlaybackModal');
        })
        .catch(err => {
            console.error('Error loading recording:', err);
            alert('Error loading recording');
        });
}

function formatDuration(seconds) {
    const secs = Math.round(seconds || 0);
    const hours = Math.floor(secs / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    const remainingSecs = secs % 60;
    
    if (hours > 0) {
        return `${hours}h ${minutes}m ${remainingSecs}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${remainingSecs}s`;
    } else {
        return `${remainingSecs}s`;
    }
}

function downloadRecording(recordingId) {
    fetch(`/api/recordings/${recordingId}`)
        .then(res => res.json())
        .then(data => {
            if (!data.success) return;
            const recording = data.recording;
            const link = document.createElement('a');
            link.href = `/recordings/${recording.filename}`;
            link.download = recording.filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        })
        .catch(err => console.error('Error downloading recording:', err));
}

function archiveCurrentRecording() {
    if (!currentPlayingRecording) return;
    if (!confirm('Archive this recording?')) return;
    
    fetch(`/api/recordings/${currentPlayingRecording.id}/archive`, {
        method: 'POST'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('Recording archived');
            closeModal();
            loadRecordings();
        } else {
            alert('Error archiving recording');
        }
    })
    .catch(err => {
        console.error('Error archiving recording:', err);
        alert('Error archiving recording');
    });
}

function deleteCurrentRecording() {
    if (!currentPlayingRecording) return;
    if (!confirm('Delete this recording permanently?')) return;
    
    fetch(`/api/recordings/${currentPlayingRecording.id}`, {
        method: 'DELETE'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert('Recording deleted');
            closeModal();
            loadRecordings();
        } else {
            alert('Error deleting recording');
        }
    })
    .catch(err => {
        console.error('Error deleting recording:', err);
        alert('Error deleting recording');
    });
}

function openCameraPreview(cameraId) {
    const camera = state.cameras.find(cam => cam.id === cameraId);
    if (!camera) return;

    const previewTitle = $('previewModalTitle');
    const previewBody = $('previewModalBody');
    if (previewTitle) {
        previewTitle.textContent = camera.name;
    }

    if (previewBody) {
        const isMotionActive = !!state.motionActiveCameras[camera.id];
        previewBody.innerHTML = `
            <div class="preview-shell ${isMotionActive ? 'preview-active' : ''}">
                <div class="preview-placeholder">
                    <div class="preview-indicator">${isMotionActive ? 'Motion detected' : 'Camera live'}</div>
                    <div class="preview-feed-icon"><i data-lucide="video"></i></div>
                    <div class="preview-caption">${camera.location || 'Unknown location'}</div>
                </div>
                <div class="preview-info-grid">
                    <div class="preview-detail"><strong>Name</strong><span>${camera.name}</span></div>
                    <div class="preview-detail"><strong>IP</strong><span>${camera.ip || 'N/A'}</span></div>
                    <div class="preview-detail"><strong>RTSP</strong><span>${camera.rtsp_url || 'Not configured'}</span></div>
                    <div class="preview-detail"><strong>Threshold</strong><span>${camera.confidence_threshold || 70}%</span></div>
                </div>
            </div>
        `;
    }

    $('cameraPreviewModal').classList.add('show');
}

// ===== AI CONTROL =====
function startAI() {
    fetch('/api/ai/start', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                document.querySelector('.ai-status-dot').className = 'ai-status-dot active';
                document.querySelector('.ai-status-text').textContent = 'Running';
            }
        })
        .catch(err => console.error('Error starting AI:', err));
}

function stopAI() {
    fetch('/api/ai/stop', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                document.querySelector('.ai-status-dot').className = 'ai-status-dot inactive';
                document.querySelector('.ai-status-text').textContent = 'Stopped';
            }
        })
        .catch(err => console.error('Error stopping AI:', err));
}

// ===== SCHEDULE MANAGEMENT =====
function loadScheduleConfig() {
    fetch('/api/schedule')
        .then(res => res.json())
        .then(data => {
            if (!data.success) return;
            const schedule = data.schedule || {};
            state.scheduleConfig = schedule;
            $('scheduleEnabled').checked = schedule.enabled !== false;
            if ($('scheduleDefaultMode')) {
                $('scheduleDefaultMode').value = schedule.default_mode || 'disarmed';
            }
            if ($('scheduleTimezone')) {
                $('scheduleTimezone').value = schedule.timezone || 'UTC';
            }
            if ($('scheduleProfilingMethod')) {
                $('scheduleProfilingMethod').value = schedule.profiling_method || 'routine';
            }
            renderScheduleRows(schedule.schedules || []);
            renderHolidayRows(schedule.holiday_overrides || []);
            renderScheduleOperatorSummary(schedule, null);
            applyScheduleReadOnlyMode();
            refreshScheduleState();
        })
        .catch(err => console.error('Error loading schedule config:', err));
}

function refreshScheduleState() {
    fetch('/api/schedule/effective')
        .then(res => res.json())
        .then(data => {
            if (!data.success) return;
            const stateData = data.state || {};
            renderScheduleOperatorSummary(null, stateData);
            const badge = $('scheduleBadge');
            const title = $('scheduleStatusTitle');
            const text = $('scheduleStatusText');
            const detail = $('scheduleStatusDetail');
            if (!badge || !title || !text || !detail) return;

            const modeLabel = stateData.mode === 'armed' ? 'Armed' : 'Disarmed';
            const timezoneLabel = $('scheduleTimezone')?.value || 'UTC';
            badge.textContent = modeLabel;
            badge.className = `schedule-badge ${stateData.mode === 'armed' ? 'armed' : 'disarmed'}`;
            title.textContent = modeLabel;
            const description = `${stateData.reason || 'Current mode'}${stateData.schedule_name ? ` • ${stateData.schedule_name}` : ''}${stateData.source === 'manual_override' ? ' • Manual override active' : ''} • ${timezoneLabel}`;
            text.textContent = description;

            const light = $('scheduleStateLight');
            const lightLabel = $('scheduleStateLightLabel');
            if (light && lightLabel) {
                const armed = stateData.mode === 'armed';
                light.className = `schedule-state-light ${armed ? 'armed' : 'disarmed'}`;
                lightLabel.textContent = armed ? 'Armed' : 'Disarmed';
            }

            if (stateData.source === 'manual_override' && stateData.manual_override && stateData.manual_override.set_at) {
                const overrideTime = new Date(stateData.manual_override.set_at).toLocaleString();
                detail.textContent = `Manual override set at ${overrideTime}`;
                detail.style.display = 'block';
            } else {
                detail.textContent = '';
                detail.style.display = 'none';
            }
        })
        .catch(err => console.error('Error refreshing effective schedule:', err));
}

function renderScheduleOperatorSummary(schedule, stateData) {
    const summary = $('scheduleOperatorSummary');
    if (!summary) return;
    const mode = stateData?.mode || schedule?.default_mode || 'disarmed';
    const overrides = (schedule || state.scheduleConfig)?.holiday_overrides || [];
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = overrides
        .filter(item => item.date && item.date >= today)
        .sort((left, right) => left.date.localeCompare(right.date))[0];
    const holidayText = upcoming
        ? `Next holiday: ${upcoming.name || 'Holiday'} (${upcoming.date}) · ${upcoming.mode === 'armed' ? 'Armed' : 'Disarmed'}`
        : `Holiday overrides: ${overrides.length}`;
    summary.innerHTML = `<strong>Operator view</strong><span>Monitoring is currently ${mode === 'armed' ? 'Armed' : 'Disarmed'}.</span><span>${holidayText}</span>`;
}

function setManualSchedule(mode) {
    if (mode !== 'armed' && mode !== 'disarmed') return;
    fetch('/api/schedule/manual', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify({ mode })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            refreshScheduleState();
            alert(`Schedule manually set to ${mode}.`);
        } else {
            alert('Unable to set manual schedule override.');
        }
    })
    .catch(err => {
        console.error('Error setting manual schedule:', err);
        alert('Unable to set manual schedule override.');
    });
}

function clearManualSchedule() {
    fetch('/api/schedule')
        .then(res => res.json())
        .then(data => {
            if (!data.success) throw new Error('Failed to load schedule configuration');
            const schedule = data.schedule || {};
            const shouldEnableSchedule = schedule.enabled === false;
            const payload = {
                ...schedule,
                enabled: true,
                manual_override: null
            };

            if (shouldEnableSchedule) {
                return fetch('/api/schedule', {
                    method: 'POST',
                    headers: actorHeaders(),
                    body: JSON.stringify(payload)
                });
            }

            return fetch('/api/schedule/manual', {
                method: 'POST',
                headers: actorHeaders(),
                body: JSON.stringify({ mode: null })
            });
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                if ($('scheduleEnabled')) {
                    $('scheduleEnabled').checked = true;
                }
                refreshScheduleState();
                alert('Auto mode enabled and following routine schedules.');
            } else {
                alert('Unable to clear manual schedule override.');
            }
        })
        .catch(err => {
            console.error('Error clearing manual schedule:', err);
            alert('Unable to clear manual schedule override.');
        });
}

function formatMilitaryTime(value) {
    if (!value) return '00:00';
    const match = /^\d{1,2}:\d{2}$/.exec(value);
    if (!match) return '00:00';
    const [hours, minutes] = value.split(':').map(part => parseInt(part, 10));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return '00:00';
    const safeHours = Math.max(0, Math.min(hours, 23));
    const safeMinutes = Math.max(0, Math.min(minutes, 59));
    return `${String(safeHours).padStart(2, '0')}:${String(safeMinutes).padStart(2, '0')}`;
}

function getScheduleDayType(schedule) {
    const days = schedule.days || [];
    const normalized = days.map(day => day.trim()).filter(Boolean);
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const weekends = ['Sat', 'Sun'];
    const allDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    if (normalized.length === 7 && allDays.every(day => normalized.includes(day))) {
        return 'daily';
    }
    if (normalized.length === 5 && weekdays.every(day => normalized.includes(day))) {
        return 'weekdays';
    }
    if (normalized.length === 2 && weekends.every(day => normalized.includes(day))) {
        return 'weekends';
    }
    return 'manual';
}

function getScheduleManualDays(schedule) {
    if (schedule.manual_days) {
        return schedule.manual_days;
    }
    return (schedule.days || []).join(', ');
}

function renderScheduleRows(schedules) {
    const rows = $('scheduleRows');
    if (!rows) return;
    rows.innerHTML = schedules.length === 0
        ? '<div class="schedule-empty">No routine schedules yet. Add one to define arming windows.</div>'
        : schedules.map((schedule, index) => {
            const dayType = schedule.day_type || getScheduleDayType(schedule);
            const manualDays = getScheduleManualDays(schedule);
            return `
            <div class="schedule-row">
                <input type="text" value="${schedule.name || ''}" placeholder="Schedule name" onchange="updateScheduleField(${index}, 'name', this.value)">
                <select onchange="updateScheduleField(${index}, 'day_type', this.value)">
                    <option value="daily" ${dayType === 'daily' ? 'selected' : ''}>Daily</option>
                    <option value="weekdays" ${dayType === 'weekdays' ? 'selected' : ''}>Weekdays</option>
                    <option value="weekends" ${dayType === 'weekends' ? 'selected' : ''}>Weekends</option>
                    <option value="manual" ${dayType === 'manual' ? 'selected' : ''}>Manual</option>
                </select>
                <input type="text" value="${manualDays}" placeholder="Mon, Tue" onchange="updateScheduleField(${index}, 'manual_days', this.value)" style="${dayType !== 'manual' ? 'display:none;' : ''}">
                <input type="time" value="${formatMilitaryTime(schedule.start || '00:00')}" onchange="updateScheduleField(${index}, 'start', this.value)" title="Arming time - when to arm the system" placeholder="Arming time">
                <input type="time" value="${formatMilitaryTime(schedule.end || '23:59')}" onchange="updateScheduleField(${index}, 'end', this.value)" title="Disarming time - when to disarm the system" placeholder="Disarming time">
                <button class="btn btn-danger btn-sm" onclick="removeScheduleRow(${index})">✕</button>
            </div>
        `;
        }).join('');
}

function renderHolidayRows(overrides) {
    const rows = $('holidayRows');
    if (!rows) return;
    rows.innerHTML = overrides.length === 0
        ? '<div class="schedule-empty">No holiday overrides yet. Add one to force a monitoring mode for special days.</div>'
        : overrides.map((item, index) => `
            <div class="schedule-row holiday-row">
                <input type="text" value="${item.name || ''}" placeholder="Holiday name" onchange="updateHolidayField(${index}, 'name', this.value)">
                <input type="date" value="${item.date || ''}" onchange="updateHolidayField(${index}, 'date', this.value)">
                <select onchange="updateHolidayField(${index}, 'mode', this.value)">
                    <option value="armed" ${item.mode === 'armed' ? 'selected' : ''}>Armed</option>
                    <option value="disarmed" ${item.mode === 'disarmed' ? 'selected' : ''}>Disarmed</option>
                </select>
                <input type="text" value="${item.notes || ''}" placeholder="Override notes" onchange="updateHolidayField(${index}, 'notes', this.value)">
                <button class="btn btn-danger btn-sm" onclick="removeHolidayRow(${index})">✕</button>
            </div>
        `).join('');
}

function getScheduleModel() {
    const schedules = [];
    const scheduleRows = document.querySelectorAll('#scheduleRows .schedule-row');
    scheduleRows.forEach(row => {
        const inputs = row.querySelectorAll('input, select');
        if (!inputs.length) return;
        const name = inputs[0].value.trim();
        const dayType = inputs[1].value;
        const manualDays = inputs[2].value;
        const start = formatMilitaryTime(inputs[3].value);
        const end = formatMilitaryTime(inputs[4].value);
        let days = [];

        if (dayType === 'daily') {
            days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        } else if (dayType === 'weekdays') {
            days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
        } else if (dayType === 'weekends') {
            days = ['Sat', 'Sun'];
        } else if (dayType === 'manual') {
            days = manualDays.split(',').map(day => day.trim()).filter(Boolean);
        }

        if (name || days.length || start || end) {
            schedules.push({ name, day_type: dayType, manual_days: manualDays, days, start, end, mode: 'armed' });
        }
    });

    const holidayOverides = [];
    const holidayRows = document.querySelectorAll('#holidayRows .schedule-row');
    holidayRows.forEach(row => {
        const inputs = row.querySelectorAll('input, select');
        if (!inputs.length) return;
        const name = inputs[0].value.trim();
        const date = inputs[1].value;
        const mode = inputs[2].value;
        const notes = inputs[3].value.trim();
        if (name || date) {
            holidayOverides.push({ name, date, mode, notes });
        }
    });

    return {
        enabled: $('scheduleEnabled').checked,
        default_profile: $('scheduleDefaultProfile')?.value || 'default',
        default_mode: $('scheduleDefaultMode').value,
        default_days: $('scheduleDefaultDays')?.value || 'weekdays',
        default_time: formatMilitaryTime($('scheduleDefaultTime')?.value || '08:00'),
        timezone: $('scheduleTimezone').value || 'UTC',
        profiling_method: $('scheduleProfilingMethod').value || 'routine',
        schedules,
        holiday_overrides: holidayOverides
    };
}

function addScheduleRow() {
    const rows = $('scheduleRows');
    if (!rows) return;
    const current = getScheduleModel();
    current.schedules.push({ name: '', day_type: 'weekdays', manual_days: '', start: '18:00', end: '06:00', mode: 'armed' });
    renderScheduleRows(current.schedules);
}

function updateScheduleField(index, field, value) {
    const rows = $('scheduleRows');
    if (!rows) return;
    const current = getScheduleModel();
    if (!current.schedules[index]) return;
    if (field === 'day_type') {
        current.schedules[index].day_type = value;
        if (value !== 'manual') {
            current.schedules[index].manual_days = '';
        }
    } else if (field === 'manual_days') {
        current.schedules[index].manual_days = value;
    } else {
        current.schedules[index][field] = value;
    }
    renderScheduleRows(current.schedules);
}

function removeScheduleRow(index) {
    const current = getScheduleModel();
    current.schedules.splice(index, 1);
    renderScheduleRows(current.schedules);
}

function addHolidayOverride() {
    const rows = $('holidayRows');
    if (!rows) return;
    const current = getScheduleModel();
    current.holiday_overrides.push({ name: '', date: '', mode: 'armed', notes: '' });
    renderHolidayRows(current.holiday_overrides);
}

function updateHolidayField(index, field, value) {
    const rows = $('holidayRows');
    if (!rows) return;
    const current = getScheduleModel();
    if (!current.holiday_overrides[index]) return;
    current.holiday_overrides[index][field] = value;
    renderHolidayRows(current.holiday_overrides);
}

function removeHolidayRow(index) {
    const current = getScheduleModel();
    current.holiday_overrides.splice(index, 1);
    renderHolidayRows(current.holiday_overrides);
}

function saveScheduleConfig() {
    const payload = getScheduleModel();
    fetch('/api/schedule', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            refreshScheduleState();
            alert('Schedule configuration saved.');
        } else {
            alert('Unable to save schedule configuration.');
        }
    })
    .catch(err => {
        console.error('Error saving schedule config:', err);
        alert('Unable to save schedule configuration.');
    });
}

// ===== RECORDINGS SETTINGS =====

function loadRecordingsConfig() {
    fetch('/api/recordings/config')
        .then(res => res.json())
        .then(data => {
            if (!data.success) return;
            const config = data.config;
            const retentionInput = $('recordingRetentionDays');
            const autoCleanup = $('autoCleanupEnabled');
            const display = $('retentionDaysDisplay');
            
            if (retentionInput) {
                retentionInput.value = config.retention_days || 30;
            }
            if (autoCleanup) {
                autoCleanup.checked = config.auto_cleanup_enabled !== false;
            }
            if (display) {
                display.textContent = `${config.retention_days || 30} days`;
            }
            renderCapturePanels();
        })
        .catch(err => console.error('Error loading recordings config:', err));
}

function saveRecordingsConfig() {
    const retentionDays = parseInt($('recordingRetentionDays')?.value) || 30;
    const autoCleanup = $('autoCleanupEnabled')?.checked ?? true;
    const display = $('retentionDaysDisplay');
    
    fetch('/api/recordings/config', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify({
            retention_days: retentionDays,
            auto_cleanup_enabled: autoCleanup
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            if (display) {
                display.textContent = `${retentionDays} days`;
            }
            renderCapturePanels();
            alert(`Recordings will be kept for ${retentionDays} days. Automatic cleanup is ${autoCleanup ? 'enabled' : 'disabled'}.`);
        } else {
            alert('Error saving recordings configuration');
        }
    })
    .catch(err => {
        console.error('Error saving recordings config:', err);
        alert('Error saving configuration');
    });
}

function performCleanup() {
    if (!confirm('This will delete recordings older than the retention period. Continue?')) return;
    
    fetch('/api/recordings/cleanup', {
        method: 'POST'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            alert(`Cleanup complete: ${data.deleted} recordings deleted.\n${data.message}`);
            loadRecordings();
        } else {
            alert('Error performing cleanup');
        }
    })
    .catch(err => {
        console.error('Error performing cleanup:', err);
        alert('Error performing cleanup');
    });
}

// ===== SETTINGS =====
function resetSystem() {
    if (confirm('⚠️ This will reset all data. Are you sure?')) {
        alert('System reset would clear all cameras and alerts.');
    }
}

function exportData() {
    fetch('/api/system/export')
        .then(res => res.json())
        .then(data => {
            if (!data.success || !data.system) {
                alert('Unable to export system data.');
                return;
            }
            const blob = new Blob([JSON.stringify(data.system, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tempest-x-system-export_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        })
        .catch(err => {
            console.error('Error exporting system data:', err);
            alert('Unable to export system data.');
        });
}

function rebootPortal() {
    if (!confirm('Rebooting the portal will restart the Flask server process. Continue?')) return;
    fetch('/api/system/reboot', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                alert(data.message || 'Restart initiated.');
            } else {
                alert('Unable to reboot portal.');
            }
        })
        .catch(err => {
            console.error('Error rebooting portal:', err);
            alert('Unable to reboot portal.');
        });
}

function triggerImport() {
    const input = $('systemImportFile');
    if (input) {
        input.value = '';
        input.click();
    }
}

function handleSystemImport(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function() {
        try {
            const data = JSON.parse(reader.result);
            const summary = summarizeImportPayload(data);
            if (!confirm(`Importing system data will overwrite current configuration.\n\n${summary}\n\nContinue?`)) return;

            fetch('/api/system/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            })
            .then(res => res.json())
            .then(resp => {
                if (resp.success) {
                    alert('System data imported successfully. Reloading app...');
                    window.location.reload();
                } else {
                    alert('Import failed: ' + (resp.error || 'Unknown error'));
                }
            })
            .catch(err => {
                console.error('Error importing system data:', err);
                alert('Unable to import system data.');
            });
        } catch (err) {
            console.error('Invalid JSON import file:', err);
            alert('The selected file is not valid JSON.');
        }
    };
    reader.readAsText(file);
}

function summarizeImportPayload(data) {
    const lines = [];
    if (data.cameras) {
        lines.push(`Cameras: ${Array.isArray(data.cameras) ? data.cameras.length : 'unknown'}`);
    }
    if (data.alerts) {
        lines.push(`Alerts: ${Array.isArray(data.alerts) ? data.alerts.length : 'unknown'}`);
    }
    if (data.users) {
        lines.push(`Users: ${Array.isArray(data.users) ? data.users.length : 'unknown'}`);
    }

    const settings = data.settings || {};
    if (settings.alarm_integration) {
        const site = settings.alarm_integration.site_name || 'Unnamed site';
        lines.push(`Site: ${site}`);
    }
    const scheduleConfig = settings.schedule_config || settings['schedule_config'] || null;
    if (scheduleConfig) {
        const defaultMode = scheduleConfig.default_mode || scheduleConfig.default_mode || 'unknown';
        const timezone = scheduleConfig.timezone || 'UTC';
        const schedules = Array.isArray(scheduleConfig.schedules) ? scheduleConfig.schedules.length : 'unknown';
        const overrides = Array.isArray(scheduleConfig.holiday_overrides) ? scheduleConfig.holiday_overrides.length : 'unknown';
        lines.push(`Default Mode: ${defaultMode}`);
        lines.push(`Timezone: ${timezone}`);
        lines.push(`Routine Schedules: ${schedules}`);
        lines.push(`Holiday Overrides: ${overrides}`);
    }

    if (lines.length === 0) {
        return 'No recognizable system config detected in the file.';
    }
    return lines.join('\n');
}

// ===== USER MANAGEMENT =====
let editingUserId = null;

function loadUsers() {
    fetch('/api/users')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                state.users = data.users || [];
                renderUsers(state.users);
            }
        })
        .catch(err => console.error('Error loading users:', err));
}

function canManageUser(user) {
    if (!currentUser) return false;
    if (currentUser.role === 'super_admin') return true;
    return user && user.role !== 'super_admin';
}

function renderUsers(users) {
    const usersList = $('usersList');
    if (!usersList) return;

    if (!users || users.length === 0) {
        usersList.innerHTML = '<p class="empty-list-message">No users found</p>';
        updateUserStats([]);
        return;
    }

    const rolesMap = {
        'super_admin': 'Super Admin',
        'admin': 'Admin',
        'operator': 'Operator'
    };

    usersList.innerHTML = users.map(user => {
        const canManage = canManageUser(user);
        const roleClass = `user-role-badge ${user.role}`;
        return `
            <div class="user-item">
                <div class="user-item-top">
                    <div class="user-item-main">
                        <div class="user-item-name">${user.username}</div>
                        <div class="user-item-email">${user.email || 'No email provided'}</div>
                    </div>
                    <span class="${roleClass}">${rolesMap[user.role] || user.role}</span>
                </div>
                <div class="user-item-actions">
                    ${canManage ? `<button class="btn btn-secondary btn-sm" onclick="editUserAccount(${user.id})">Update</button>` : ''}
                    ${canManage ? `<button class="btn btn-danger btn-sm" onclick="deleteUserAccount(${user.id})">Remove</button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    updateUserStats(users);
}

function updateUserStats(users) {
    if (!$('totalUsersCount') || !$('superAdminCount') || !$('operatorCount') || !$('activeUserCount')) return;
    $('totalUsersCount').textContent = users.length;
    $('superAdminCount').textContent = users.filter(u => u.role === 'super_admin').length;
    $('operatorCount').textContent = users.filter(u => u.role === 'operator').length;
    $('activeUserCount').textContent = users.filter(u => u.status === 'active').length;
}

function openUserModal(user = null) {
    if (!$('createUserModal')) return;
    editingUserId = user ? user.id : null;
    $('userName').value = user ? user.username || '' : '';
    $('userEmail').value = user ? user.email || '' : '';
    $('userPassword').value = '';
    $('userRole').value = user ? (user.role || 'operator') : 'operator';

    const title = $('createUserModal').querySelector('.modal-header h3');
    const actionBtn = $('createUserModal').querySelector('.modal-footer .btn-primary');
    if (title) title.textContent = user ? '✏️ Edit User' : '➕ Create New User';
    if (actionBtn) actionBtn.textContent = user ? 'Update User' : 'Create User';

    $('createUserModal').classList.add('show');
}

function editUserAccount(userId) {
    fetch(`/api/users/${userId}`)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                openUserModal(data.user);
            } else {
                alert('Error loading user: ' + (data.error || 'Unknown error'));
            }
        })
        .catch(err => {
            console.error('Error loading user:', err);
            alert('Error loading user details.');
        });
}

function saveUser() {
    const username = $('userName').value.trim();
    const email = $('userEmail').value.trim();
    const password = $('userPassword').value.trim();
    const role = $('userRole').value;

    if (!currentUser || (currentUser.role !== 'super_admin' && role === 'super_admin')) {
        alert('Only super admins can create or edit super-admin accounts.');
        return;
    }

    if (!username || !email) {
        alert('Please fill in the username and email fields');
        return;
    }

    if (!editingUserId && !password) {
        alert('Please enter a password for the new user');
        return;
    }

    const payload = { username, email, role };
    if (password) payload.password = password;

    const endpoint = editingUserId ? `/api/users/${editingUserId}` : '/api/users';
    const method = editingUserId ? 'PUT' : 'POST';

    fetch(endpoint, {
        method,
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            closeModal();
            editingUserId = null;
            loadUsers();
        } else {
            alert((editingUserId ? 'Error updating user: ' : 'Error creating user: ') + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error saving user:', err);
        alert('Error saving user.');
    });
}

function saveInlineUser() {
    const username = $('addUserName').value.trim();
    const email = $('addUserEmail').value.trim();
    const password = $('addUserPassword').value.trim();
    const role = $('addUserRole').value;

    if (!currentUser || currentUser.role !== 'super_admin') {
        alert('Only super admins can create users.');
        return;
    }

    if (!username || !email || !password) {
        alert('Please enter username, email, and password');
        return;
    }

    const payload = { username, email, password, role };
    fetch('/api/users', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            $('addUserName').value = '';
            $('addUserEmail').value = '';
            $('addUserPassword').value = '';
            $('addUserRole').value = 'operator';
            loadUsers();
        } else {
            alert('Error creating user: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error creating user:', err);
        alert('Error creating user.');
    });
}

function deleteUserAccount(userId) {
    const targetUser = state.users?.find(user => user.id === userId);
    if (!currentUser || !canManageUser(targetUser)) {
        alert('You do not have permission to manage this user.');
        return;
    }

    if (!confirm('Delete this user? This action cannot be undone.')) return;

    fetch(`/api/users/${userId}`, {
        method: 'DELETE',
        headers: actorHeaders()
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            loadUsers();
        } else {
            alert('Error deleting user: ' + (data.error || 'Unknown error'));
        }
    })
    .catch(err => {
        console.error('Error deleting user:', err);
        alert('Error deleting user.');
    });
}

// ===== SETTINGS =====

function loadUserSummary() {
    fetch('/api/users')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                state.users = data.users || [];
                renderStats();
            }
        })
        .catch(err => console.error('Error loading user summary:', err));
}

// ===== SOUND =====
function playAlertSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.value = 0.3;
        osc.start();
        setTimeout(() => {
            osc.frequency.value = 1000;
            setTimeout(() => {
                gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
                osc.stop();
            }, 100);
        }, 100);
    } catch (e) {
        // Audio not supported - silent alert
    }
}

// ===== THRESHOLD SLIDER =====
document.addEventListener('DOMContentLoaded', () => {
    refreshIcons();
    initCaptureTabs();

    // Global threshold
    const threshold = $('globalThreshold');
    if (threshold) {
        threshold.addEventListener('input', function() {
            $('thresholdValue').textContent = this.value + '%';
        });
    }
    
    // Camera threshold in modal
    const camThreshold = $('camThreshold');
    if (camThreshold) {
        camThreshold.addEventListener('input', function() {
            $('camThresholdValue').textContent = this.value + '%';
        });
    }

    // Recording retention days
    const retentionDays = $('recordingRetentionDays');
    if (retentionDays) {
        retentionDays.addEventListener('input', function() {
            const days = this.value || 30;
            const display = $('retentionDaysDisplay');
            if (display) {
                display.textContent = `${days} days`;
            }
        });
    }

    const editCamThreshold = $('editCamThreshold');
    if (editCamThreshold) {
        editCamThreshold.addEventListener('input', function() {
            $('editCamThresholdValue').textContent = this.value + '%';
        });
    }

    const networkDhcp = $('networkDhcp');
    const networkStatic = $('networkStatic');
    const dhcpFields = $('dhcpFields');
    const staticFields = $('staticFields');
    if (networkDhcp && networkStatic && dhcpFields && staticFields) {
        const toggleNetworkFields = () => {
            if (networkDhcp.checked && networkStatic.checked) {
                if (networkDhcp.dataset.lastChanged === 'dhcp') {
                    networkStatic.checked = false;
                } else {
                    networkDhcp.checked = false;
                }
            }
            if (!networkDhcp.checked && !networkStatic.checked) {
                // Ensure exactly one mode remains selected.
                networkStatic.checked = networkDhcp.dataset.lastChanged === 'dhcp';
                networkDhcp.checked = !networkStatic.checked;
            }
            dhcpFields.style.display = networkDhcp.checked ? 'flex' : 'none';
            staticFields.style.display = networkStatic.checked ? 'flex' : 'none';
        };
        const markLastChanged = (mode) => () => {
            if (mode === 'dhcp') {
                networkDhcp.dataset.lastChanged = 'dhcp';
                if (networkDhcp.checked) {
                    networkStatic.checked = false;
                }
            } else {
                networkStatic.dataset.lastChanged = 'static';
                if (networkStatic.checked) {
                    networkDhcp.checked = false;
                }
            }
            if (!networkDhcp.checked && !networkStatic.checked) {
                networkStatic.checked = true;
            }
            toggleNetworkFields();
        };
        networkDhcp.addEventListener('change', markLastChanged('dhcp'));
        networkStatic.addEventListener('change', markLastChanged('static'));
        networkDhcp.dataset.lastChanged = 'dhcp';
        toggleNetworkFields();
    }
});

// ===== UTILITY FUNCTIONS =====
function formatTime(isoString) {
    if (!isoString) return '--:--:--';
    try {
        const date = new Date(isoString);
        return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
        return isoString;
    }
}

// ===== USER MANAGEMENT =====

// ===== AUTO-REFRESH =====
setInterval(() => {
    if (isAuthenticated) {
        refreshAlerts();
        if (state.currentView === 'system') {
            loadSystemMetrics();
        }
    }
}, 5000);

// ===== INITIALIZATION =====
console.log('🛡️ TEMPEST X AI Motion Portal loaded');
console.log('Initializing authentication...');

// Initialize authentication state once DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initAuthState();
        if (!isAuthenticated) {
            $('loginScreen').classList.add('active');
            $('mainApp').style.display = 'none';
        }
    });
} else {
    initAuthState();
    if (!isAuthenticated) {
        $('loginScreen').classList.add('active');
        $('mainApp').style.display = 'none';
    }
}

// ===== CALENDAR VIEW =====
function openCalendarView(mode = 'schedule') {
    const modal = $('calendarModal');
    if (!modal) return;
    calendarMode = mode;
    calendarYear = null;
    calendarMonth = null;
    renderCalendar(null, null, mode);
    modal.classList.add('show');
}

function renderCalendar(year = null, month = null, mode = 'schedule') {
    const grid = $('calendarGrid');
    if (!grid) return;
    const now = new Date();
    calendarYear = year != null ? year : (calendarYear != null ? calendarYear : now.getFullYear());
    calendarMonth = month != null ? month : (calendarMonth != null ? calendarMonth : now.getMonth());
    const y = calendarYear;
    const m = calendarMonth;
    const first = new Date(y, m, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const titleEl = document.querySelector('#calendarModal .modal-header h3');
    if (titleEl) {
        titleEl.textContent = mode === 'history' ? '📅 System History Calendar' : '📅 Schedule Calendar';
    }

    const loadPromise = mode === 'history'
        ? (state.analyticsSummary
            ? Promise.resolve({ ok: true, json: () => Promise.resolve(state.analyticsSummary) })
            : fetch('/api/analytics/summary?audit_limit=365', { credentials: 'include' }))
        : fetch('/api/schedule', { credentials: 'include' });

    loadPromise
        .then(res => {
            if (res && res.ok === false) {
                return res.text().then(body => {
                    throw new Error(`Failed to load calendar (${res.status}): ${body}`);
                });
            }
            return res.json ? res.json() : Promise.resolve(res);
        })
        .then(data => {
        const eventsByDate = {};
        if (mode === 'history') {
            const events = data.audit_events || data.events || [];
            events.forEach(ev => {
                const date = ev.timestamp ? ev.timestamp.split('T')[0] : null;
                if (!date) return;
                eventsByDate[date] = eventsByDate[date] || [];
                eventsByDate[date].push(ev);
            });
        } else {
            const overrides = (data.schedule && data.schedule.holiday_overrides) || [];
            overrides.forEach(o => {
                if (o.date) eventsByDate[o.date] = o;
            });
        }

        let html = '<div class="calendar-controls">';
        html += `<button class="btn btn-sm" onclick="changeCalendarMonth(-1)">‹</button>`;
        html += `<div class="calendar-month">${first.toLocaleString(undefined,{month:'long'})} ${y}</div>`;
        html += `<button class="btn btn-sm" onclick="changeCalendarMonth(1)">›</button>`;
        html += '</div><div class="calendar-days">';
        // empty slots
        for (let i=0;i<startDay;i++) html += '<div class="calendar-cell empty"></div>';
        for (let d=1; d<=daysInMonth; d++) {
            const key = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const ev = eventsByDate[key];
            let eventHtml = '';
            if (ev) {
                if (mode === 'history') {
                    eventHtml = `<div class="cell-event">${ev.length} change${ev.length === 1 ? '' : 's'}</div>`;
                } else {
                    eventHtml = `<div class="cell-event">${ev.name}</div>`;
                }
            }
            html += `<div class="calendar-cell" data-date="${key}">
                <div class="cell-day">${d}</div>
                ${eventHtml}
            </div>`;
        }
        html += '</div>';
        grid.innerHTML = html;

        grid.querySelectorAll('.calendar-cell').forEach(cell => {
            if (cell.classList.contains('empty')) return;
            const date = cell.dataset.date;
            cell.addEventListener('click', () => {
                if (mode === 'history') {
                    showHistoryDayEvents(date, eventsByDate[date] || []);
                } else {
                    onCalendarDayClick(date, cell);
                }
            });
        });
    })
    .catch(err => {
        grid.textContent = err.message || 'Unable to load calendar';
        console.error('Calendar load error:', err);
    });
}

function changeCalendarMonth(offset) {
    if (calendarMonth == null || calendarYear == null) {
        const now = new Date();
        calendarYear = now.getFullYear();
        calendarMonth = now.getMonth();
    }
    const date = new Date(calendarYear, calendarMonth + offset, 1);
    calendarYear = date.getFullYear();
    calendarMonth = date.getMonth();
    renderCalendar(calendarYear, calendarMonth, calendarMode);
}

function showHistoryDayEvents(dateKey, events) {
    closeCalendarEditPanel();
    const grid = $('calendarGrid');
    if (!grid) return;

    const pop = document.createElement('div');
    pop.id = 'calendarEditPanel';
    pop.className = 'calendar-popover calendar-edit-panel';

    const entries = events.length ? events.map(ev => `
            <div class="calendar-history-row">
                <div><strong>${ev.actor || 'System'}</strong> <span>${ev.action}</span></div>
                <time>${ev.timestamp ? new Date(ev.timestamp).toLocaleString() : 'n/a'}</time>
            </div>
        `).join('') : '<div class="analytics-empty">No changes recorded for this day.</div>';

    pop.innerHTML = `
        <div class="edit-title">${dateKey}</div>
        <div class="calendar-history-list">${entries}</div>
        <div class="calendar-edit-actions">
            <button class="modal-close btn btn-primary" id="closeHistoryBtn" aria-label="Close">Close</button>
        </div>
    `;

    grid.appendChild(pop);
    const cellEl = grid.querySelector(`.calendar-cell[data-date="${dateKey}"]`);
    const rect = cellEl ? cellEl.getBoundingClientRect() : grid.getBoundingClientRect();
    const left = Math.max(8, rect.left + window.scrollX);
    const top = Math.max(8, rect.bottom + window.scrollY + 8);
    pop.style.position = 'fixed';
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.zIndex = 2000;

    $('closeHistoryBtn').onclick = () => closeCalendarEditPanel();
}

function closeCalendarEditPanel() {
    const existing = $('calendarEditPanel');
    if (existing) existing.remove();
}

function saveOverrideFromPanel(dateKey) {
    const name = $('editOverrideName')?.value.trim() || '';
    const mode = $('editOverrideMode')?.value || 'armed';
    const notes = $('editOverrideNotes')?.value.trim() || '';

    fetch('/api/schedule')
        .then(res => res.json())
        .then(data => {
            const schedule = data.schedule || {};
            const overrides = schedule.holiday_overrides || [];
            const idx = overrides.findIndex(o => o.date === dateKey);
            if (!name) {
                if (idx !== -1) overrides.splice(idx,1);
            } else {
                const entry = { name, date: dateKey, mode, notes };
                if (idx !== -1) overrides[idx] = entry; else overrides.push(entry);
            }
            schedule.holiday_overrides = overrides;
            fetch('/api/schedule', { method: 'POST', headers: actorHeaders(), body: JSON.stringify(schedule) })
                .then(r=>r.json()).then(resp=>{
                    if (resp.success) {
                        closeCalendarEditPanel();
                        renderCalendar();
                        refreshScheduleState();
                    } else alert('Failed to save override');
                });
        });
}

function deleteOverrideFromPanel(dateKey) {
    if (!confirm('Remove override for ' + dateKey + '?')) return;
    fetch('/api/schedule')
        .then(res => res.json())
        .then(data => {
            const schedule = data.schedule || {};
            const overrides = schedule.holiday_overrides || [];
            const idx = overrides.findIndex(o => o.date === dateKey);
            if (idx !== -1) overrides.splice(idx,1);
            schedule.holiday_overrides = overrides;
            fetch('/api/schedule', { method: 'POST', headers: actorHeaders(), body: JSON.stringify(schedule) })
                .then(r=>r.json()).then(resp=>{
                    if (resp.success) {
                        closeCalendarEditPanel();
                        renderCalendar();
                        refreshScheduleState();
                    } else alert('Failed to delete override');
                });
        });
}

function onCalendarDayClick(dateKey, cellEl) {
    // open floating popover anchored to cellEl
    closeCalendarEditPanel();
    const grid = $('calendarGrid');
    if (!grid) return;

    fetch('/api/schedule')
        .then(res => res.json())
        .then(data => {
            const schedule = data.schedule || {};
            const overrides = schedule.holiday_overrides || [];
            const existing = overrides.find(o => o.date === dateKey) || {};

            const pop = document.createElement('div');
            pop.id = 'calendarEditPanel';
            pop.className = 'calendar-popover calendar-edit-panel';
            pop.innerHTML = `
                <div class="edit-title">${dateKey}</div>
                <div class="calendar-edit-row"><label>Name</label><input id="editOverrideName" value="${existing.name ? existing.name.replace(/"/g,'&quot;') : ''}"></div>
                <div class="calendar-edit-row"><label>Mode</label>
                    <select id="editOverrideMode">
                        <option value="armed" ${existing.mode === 'armed' ? 'selected' : ''}>Armed</option>
                        <option value="disarmed" ${existing.mode === 'disarmed' ? 'selected' : ''}>Disarmed</option>
                    </select>
                </div>
                <div class="calendar-edit-row"><label>Notes</label><input id="editOverrideNotes" value="${existing.notes ? existing.notes.replace(/"/g,'&quot;') : ''}"></div>
                <div class="calendar-edit-actions">
                    <button class="btn btn-primary" id="saveOverrideBtn">Save</button>
                    <button class="btn btn-danger" id="deleteOverrideBtn">Delete</button>
                    <button class="modal-close" id="closeOverrideBtn" aria-label="Close">✕</button>
                </div>
            `;

            grid.appendChild(pop);

            // position popover using viewport (fixed) coordinates so it stays visible while scrolling
            const cellRect = cellEl.getBoundingClientRect();
            const left = Math.max(8, cellRect.left + window.scrollX);
            const top = Math.max(8, cellRect.bottom + window.scrollY + 8);
            pop.style.position = 'fixed';
            pop.style.left = `${left}px`;
            pop.style.top = `${top}px`;
            pop.style.zIndex = 2000;

            $('saveOverrideBtn').onclick = () => saveOverrideFromPanel(dateKey);
            $('deleteOverrideBtn').onclick = () => deleteOverrideFromPanel(dateKey);
            $('closeOverrideBtn').onclick = () => closeCalendarEditPanel();
        })
        .catch(err => console.error('Error opening editor:', err));
}

// ===== ANALYTICS =====
function getSelectedAlarmInterval() {
    const select = $('alarmIntervalSelect');
    return select ? select.value : 'day';
}

function renderCameraStorageCapacity(cameras, recordings) {
    const list = $('cameraStorageList');
    const total = $('cameraStorageTotal');
    if (!list) return;

    const storageByCamera = (recordings || []).reduce((totals, recording) => {
        const cameraId = String(recording.camera_id);
        totals[cameraId] = (totals[cameraId] || 0) + (Number(recording.size_mb) || 0);
        return totals;
    }, {});

    const cameraRows = (cameras || []).map(camera => ({
        name: camera.name || `Camera ${camera.id}`,
        storageMb: storageByCamera[String(camera.id)] || 0
    }));
    const totalStorageMb = cameraRows.reduce((sum, camera) => sum + camera.storageMb, 0);

    if (cameraRows.length === 0) {
        list.innerHTML = '<div class="analytics-empty">No cameras available</div>';
        if (total) total.textContent = '';
        return;
    }

    list.innerHTML = cameraRows.map(camera => `
        <div class="analytics-list-row analytics-storage-row">
            <span title="${camera.name}">${camera.name}</span>
            <strong>${camera.storageMb.toFixed(2)} MB</strong>
        </div>
    `).join('');
    if (total) total.textContent = `Total recorded storage: ${totalStorageMb.toFixed(2)} MB`;
}

function loadAnalytics() {
    const interval = getSelectedAlarmInterval();
    fetch(`/api/analytics/summary?audit_limit=365&alarm_interval=${encodeURIComponent(interval)}`, { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
            if (!data || !data.success) return;
            state.analyticsSummary = data;
            const intervalTextMap = {
                minute: 'per-minute',
                hour: 'per-hour',
                day: 'per-day',
                week: 'per-week'
            };
            const intervalLabel = intervalTextMap[interval] || 'per-day';
            if ($('alarmsPerCameraInfo')) {
                $('alarmsPerCameraInfo').textContent = `Showing ${intervalLabel} alarm counts over the selected period.`;
            }

            if ($('totalCameras')) $('totalCameras').textContent = data.total_cameras || 0;
            if ($('offlineCount')) $('offlineCount').textContent = data.offline_count || 0;

            renderCameraStorageCapacity(data.cameras || [], state.recordings);
            if ($('cameraStorageList') && !state.recordings.length) {
                fetch('/api/recordings', { credentials: 'include' })
                    .then(response => response.json())
                    .then(recordingData => {
                        if (recordingData.success) {
                            state.recordings = recordingData.recordings || [];
                            renderCameraStorageCapacity(data.cameras || [], state.recordings);
                        }
                    })
                    .catch(() => {});
            }

            if ($('auditEventsList')) {
                const events = data.audit_events || [];
                $('auditEventsList').innerHTML = events.length ? events.map(event => `
                    <div class="analytics-audit-row">
                        <div>
                            <strong>${event.actor || 'System'}</strong>
                            <span>${event.action}</span>
                        </div>
                        <time>${event.timestamp ? new Date(event.timestamp).toLocaleString() : 'n/a'}</time>
                    </div>
                `).join('') : '<div class="analytics-empty">No changes recorded yet</div>';
            }

            // Alarms per camera daily trend
            if ($('alarmsPerCamera')) {
                const labels = data.alarm_trend_labels || [];
                const trends = (data.alarm_trends || []).slice(0, 3);
                if (trends.length && labels.length) {
                        const maxCount = Math.max(...trends.flatMap(tr => tr.counts), 1);
                        const xStep = labels.length > 1 ? 160 / (labels.length - 1) : 160;

                        // build grid lines: horizontal ticks and vertical separators per label
                        const gridLines = (() => {
                            const lines = [];
                            const gridLeft = 10;
                            const gridRight = 10 + (labels.length > 1 ? (labels.length - 1) * xStep : xStep);
                            // horizontal grid (4 segments => 5 lines including 0/100)
                            const hTicks = 4;
                            for (let t = 0; t <= hTicks; t++) {
                                const y = 80 - (t / hTicks) * 60;
                                lines.push(`<line x1="${gridLeft}" x2="${gridRight.toFixed(2)}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="3 3" />`);
                            }
                            // vertical lines aligned to each label (subtle)
                            if (labels.length > 1) {
                                for (let i = 0; i < labels.length; i++) {
                                    const x = 10 + i * xStep;
                                    lines.push(`<line x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="12" y2="80" stroke="rgba(255,255,255,0.03)" stroke-width="1" />`);
                                }
                            }
                            return lines.join('');
                        })();

                        const chartLines = trends.map((trend, index) => {
                            const points = trend.counts.map((value, i) => {
                                const x = 10 + i * xStep;
                                const y = 80 - (value / maxCount) * 60;
                                return `${x.toFixed(2)},${y.toFixed(2)}`;
                            });
                            const colors = ['#6bc7ff', '#3aa7ff', '#7de0b3'];
                            return `
                                <polyline points="${points.join(' ')}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                            `;
                        }).join('');

                        const indicator = trends.map((trend, index) => {
                            const color = ['#6bc7ff', '#3aa7ff', '#7de0b3'][index % 3];
                            return `<div class="analytics-line-key"><span class="analytics-line-dot" style="background:${color}"></span>${trend.name} (${trend.total})</div>`;
                        }).join('');

                        const xLabels = labels.map((label, i) => `<div>${label}</div>`).join('');
                        $('alarmsPerCamera').innerHTML = `
                            <div class="analytics-line-key-row">${indicator}</div>
                            <div class="analytics-line-chart-wrapper">
                                <svg viewBox="0 0 180 100" preserveAspectRatio="none" class="analytics-line-chart">
                                    <defs>
                                        <linearGradient id="alarmGradient" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stop-color="#6bc7ff" stop-opacity="0.3" />
                                            <stop offset="100%" stop-color="#6bc7ff" stop-opacity="0" />
                                        </linearGradient>
                                    </defs>
                                    <rect x="0" y="0" width="180" height="100" fill="rgba(255,255,255,0.03)" />
                                    ${gridLines}
                                    ${chartLines}
                                </svg>
                            </div>
                            <div class="analytics-line-xlabels" style="grid-template-columns: repeat(${labels.length}, minmax(0, 1fr));">${xLabels}</div>
                        `;
                } else if (data.alarms_per_camera && Object.keys(data.alarms_per_camera).length) {
                    const rows = Object.entries(data.alarms_per_camera).map(([cid, count]) => {
                        const name = (data.cameras || []).find(cam => cam.id === Number(cid))?.name || `Camera ${cid}`;
                        return `<div class="analytics-line-key"><span>${name}</span><strong>${count}</strong></div>`;
                    }).join('');
                    $('alarmsPerCamera').innerHTML = `<div class="analytics-line-key-row">${rows}</div>`;
                } else {
                    $('alarmsPerCamera').innerHTML = 'No recent alarms';
                }
            }

            // Most detected today - Enhanced visualization
            if ($('mostDetectedToday')) {
                const subjects = data.detected_subjects_today || [];
                if (!subjects.length) {
                    $('mostDetectedToday').textContent = '-';
                } else {
                    // Enhanced color palette with gradients
                    const colorPalette = [
                        { main: '#ff8a65', light: '#ffb3a6', gradient: 'url(#grad1)' },
                        { main: '#ffd54f', light: '#ffe599', gradient: 'url(#grad2)' },
                        { main: '#81c784', light: '#b2dfdb', gradient: 'url(#grad3)' },
                        { main: '#64b5f6', light: '#b3e5fc', gradient: 'url(#grad4)' },
                        { main: '#ba68c8', light: '#e1bee7', gradient: 'url(#grad5)' },
                        { main: '#90a4ae', light: '#cfd8dc', gradient: 'url(#grad6)' }
                    ];

                    // build pie chart SVG with enhancements
                    const total = subjects.reduce((s, it) => s + it.count, 0) || 1;
                    let startAngle = -90; // start at top
                    const center = 50;
                    const radius = 40;

                    function polarToCartesian(cx, cy, r, angleDeg) {
                        const a = (angleDeg - 90) * Math.PI / 180.0;
                        return { x: cx + (r * Math.cos(a)), y: cy + (r * Math.sin(a)) };
                    }

                    function describeArc(cx, cy, r, startAngle, endAngle) {
                        const start = polarToCartesian(cx, cy, r, endAngle);
                        const end = polarToCartesian(cx, cy, r, startAngle);
                        const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
                        return [`M ${cx} ${cy}`, `L ${start.x.toFixed(2)} ${start.y.toFixed(2)}`, `A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`, 'Z'].join(' ');
                    }

                    const segments = subjects.map((it, idx) => {
                        const fraction = it.count / total;
                        const sweep = fraction * 360;
                        const trendIcon = it.trend === 'up' ? '<i data-lucide="trending-up"></i>' : (it.trend === 'down' ? '<i data-lucide="trending-down"></i>' : '<i data-lucide="minus"></i>');
                        const trendColor = it.trend === 'up' ? '#4caf50' : (it.trend === 'down' ? '#f44336' : '#9e9e9e');
                        const colors = colorPalette[idx % colorPalette.length];
                        const hourlyData = Array.isArray(it.hourly_breakdown) ? it.hourly_breakdown : [0]*24;
                        const seg = {
                            start: startAngle,
                            end: startAngle + sweep,
                            color: colors.main,
                            label: `${it.subject} (${it.count})`,
                            percentage: Math.round(fraction * 100),
                            yesterdayCount: it.yesterday_count || 0,
                            trend: it.trend || 'stable',
                            trendIcon: trendIcon,
                            trendColor: trendColor,
                            hourlyData: hourlyData,
                            peakHour: hourlyData.length > 0 ? hourlyData.indexOf(Math.max(...hourlyData)) : 0
                        };
                        startAngle += sweep;
                        return seg;
                    });

                    // Create gradient definitions for each segment
                    const gradients = segments.map((s, idx) => `
                        <defs>
                            <linearGradient id="grad${idx}" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" style="stop-color:${s.color};stop-opacity:1" />
                                <stop offset="100%" style="stop-color:${s.color};stop-opacity:0.7" />
                            </linearGradient>
                        </defs>
                    `).join('');

                    const svgSegments = segments.map((s, idx) => `
                        <g class="pie-segment" data-subject="${s.label}" style="cursor: pointer; transition: opacity 0.2s;">
                            <path d="${describeArc(center, center, radius, s.start, s.end)}" 
                                  fill="${s.color}" 
                                  stroke="rgba(255,255,255,0.15)" 
                                  stroke-width="1" 
                                  class="segment-path"
                                  style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3));" />
                        </g>
                    `).join('');

                    const legend = segments.map((s, idx) => {
                        const comparison = s.yesterdayCount > 0 
                            ? `<span style="color: ${s.trendColor}; font-size: 0.85em; margin-top: 2px; display: block;">${s.trendIcon} vs ${s.yesterdayCount} yesterday</span>`
                            : '';
                        return `<div class="analytics-pie-legend-item" style="padding: 8px; border-radius: 4px; transition: background 0.2s; cursor: pointer;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
                            <span class="analytics-pie-legend-swatch" style="background:${s.color}; box-shadow: 0 2px 4px rgba(0,0,0,0.2);"></span>
                            <span>
                                <strong>${s.label}</strong>
                                <br>
                                <small>${s.percentage}% of today</small>
                                ${comparison}
                            </span>
                        </div>`;
                    }).join('');

                    // Hourly timeline for top detection
                    const topSubject = segments[0];
                    const hourlyChart = topSubject && topSubject.hourlyData && Array.isArray(topSubject.hourlyData) ? `
                        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1);">
                            <small style="color: rgba(255,255,255,0.6);">Detection timeline for <strong>${topSubject.label.split('(')[0].trim()}</strong></small>
                            <div style="display: grid; grid-template-columns: repeat(24, 1fr); gap: 1px; margin-top: 6px; height: 24px;">
                                ${topSubject.hourlyData.map((count, hour) => {
                                    const maxVal = Math.max(...topSubject.hourlyData, 1);
                                    const height = maxVal > 0 ? (count / maxVal) * 100 : 0;
                                    return `<div style="background: ${topSubject.color}; opacity: ${Math.max(height/100, 0.2)}; border-radius: 2px; transition: opacity 0.2s;" title="${hour}:00 - ${count} detections"></div>`;
                                }).join('')}
                            </div>
                            <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; margin-top: 4px; font-size: 0.7em; color: rgba(255,255,255,0.5);">
                                <div>0h</div><div>4h</div><div>8h</div><div>12h</div><div>16h</div><div>20h</div>
                            </div>
                        </div>
                    ` : '';

                    $('mostDetectedToday').innerHTML = `
                        <div class="analytics-pie" style="position: relative;">
                            <div class="analytics-pie-center">
                                <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style="filter: drop-shadow(0 4px 8px rgba(0,0,0,0.3));">
                                    ${gradients}
                                    ${svgSegments}
                                    <circle cx="50" cy="50" r="20" class="analytics-pie-inner" />
                                </svg>
                                <div class="analytics-pie-center-label"><strong>${total}</strong> detections<br>today</div>
                            </div>
                            <div class="analytics-pie-legend">
                                ${legend}
                                ${hourlyChart}
                            </div>
                        </div>
                    `;
                }
            }

            // Recording status per camera
            if ($('recordingStatus')) {
                const last = data.last_recording || {};
                const cams = data.cameras || [];
                const rows = cams.map(c => {
                    const rec = last[c.id];
                    const txt = rec ? (rec.created_at || rec.started_at || 'recent') : 'No recordings';
                    return `<div>${c.name}: ${txt}</div>`;
                });
                $('recordingStatus').innerHTML = rows.join('');
            }
            refreshIcons();

        })
        .catch(err => {
            console.error('Analytics load error', err);
        });
}

function setAlarmWallStatus(message, isError = false) {
    const status = $('alarmWallStatusMessage');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('success', !!message && !isError);
    status.classList.toggle('error', !!message && isError);
}

function loadAlarmWallSettings() {
    fetch('/api/settings/alarm-wall')
        .then(res => res.json())
        .then(data => {
            if (!data.success) return;
            const settings = data.settings || {};
            if ($('alarmWallEnabled')) $('alarmWallEnabled').checked = settings.alarm_wall_enabled === true;
            if ($('alarmWallHost')) $('alarmWallHost').value = settings.alarm_wall_host || '';
            if ($('alarmWallPort')) $('alarmWallPort').value = settings.alarm_wall_port || 9100;
            if ($('alarmWallDeviceId')) $('alarmWallDeviceId').value = settings.alarm_wall_device_id || '';
            if ($('alarmWallIncludeClip')) $('alarmWallIncludeClip').checked = settings.alarm_wall_include_clip !== false;
            if ($('alarmWallTimeout')) $('alarmWallTimeout').value = settings.alarm_wall_timeout || 10;
        })
        .catch(() => setAlarmWallStatus('Unable to load Alarm Wall settings.', true));
}

function getAlarmWallPayload() {
    return {
        alarm_wall_enabled: $('alarmWallEnabled')?.checked === true,
        alarm_wall_host: $('alarmWallHost')?.value.trim() || '',
        alarm_wall_port: Number($('alarmWallPort')?.value) || 9100,
        alarm_wall_device_id: $('alarmWallDeviceId')?.value.trim() || '',
        alarm_wall_include_clip: $('alarmWallIncludeClip')?.checked !== false,
        alarm_wall_timeout: Number($('alarmWallTimeout')?.value) || 10
    };
}

function saveAlarmWallSettings() {
    setAlarmWallStatus('Saving XML/TCP settings...');
    fetch('/api/settings/alarm-wall', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(getAlarmWallPayload())
    })
        .then(res => res.json())
        .then(data => {
            if (data.success) setAlarmWallStatus('XML/TCP settings saved successfully.');
            else setAlarmWallStatus(data.error || 'Unable to save XML/TCP settings.', true);
        })
        .catch(() => setAlarmWallStatus('Unable to save XML/TCP settings.', true));
}

function testAlarmWallSettings() {
    setAlarmWallStatus('Sending XML test message...');
    const payload = getAlarmWallPayload();
    fetch('/api/settings/alarm-wall/test', {
        method: 'POST',
        headers: actorHeaders(),
        body: JSON.stringify(payload)
    })
        .then(res => res.json())
        .then(data => {
            if (data.success) setAlarmWallStatus(`${data.message} (${data.bytes_sent} bytes).`);
            else setAlarmWallStatus(data.error || 'Alarm Wall connection test failed.', true);
        })
        .catch(() => setAlarmWallStatus('Alarm Wall connection test failed.', true));
}

function applyScheduleReadOnlyMode() {
    const scheduleView = $('view-schedule');
    const operatorMode = currentUser?.role === 'operator';
    if (!scheduleView) return;
    scheduleView.classList.toggle('operator-mode', operatorMode);
    scheduleView.querySelectorAll('button, input, select, textarea').forEach(control => {
        control.disabled = operatorMode;
        control.setAttribute('aria-disabled', operatorMode ? 'true' : 'false');
    });
}
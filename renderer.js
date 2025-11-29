const { ipcRenderer, shell } = require('electron');
const path = require('path');

// Try to use @electron/remote or fall back to alternative approach
let dialog;
try {
    const remote = require('@electron/remote');
    dialog = remote.dialog;
} catch (error) {
    console.error('Failed to load @electron/remote:', error);
    // Fallback to asking main process to show dialog
    dialog = {
        showOpenDialog: async (options) => {
            return await ipcRenderer.invoke('show-open-dialog', options);
        }
    };
}

let savedProjectsCache = [];
let projectSearchTerm = '';
let projectGroupFilter = null;
const collapsedGroups = new Set();
let groupMetadata = {};
let groupManagerRowCounter = 0;
let hasLoadedSavedProjectsOnce = false;
let savedProjectsLoadPromise = null;
let groupOrder = [];
let draggedProjectId = null;
let draggedGroupName = null;
let projectDropPlaceholder = null;
let groupDropPlaceholder = null;
const THEME_PREFERENCE_KEY = 'htdocs-manager.theme-preference';
const ThemeModes = Object.freeze({
    LIGHT: 'light',
    DARK: 'dark',
    SYSTEM: 'system'
});
const ProjectStatusMeta = Object.freeze({
    ok: {
        icon: 'fa-check-circle',
        label: 'OK',
        className: 'project-status-ok',
        defaultMessage: 'Sin problemas detectados.'
    },
    warning: {
        icon: 'fa-exclamation-triangle',
        label: 'Revisar',
        className: 'project-status-warning',
        defaultMessage: 'Revisa la configuración de este proyecto.'
    },
    missing: {
        icon: 'fa-times-circle',
        label: 'Falta',
        className: 'project-status-missing',
        defaultMessage: 'No se encontró la ruta del proyecto.'
    }
});

function parseVersionSegments(rawVersion) {
    if (!rawVersion) {
        return null;
    }

    const match = String(rawVersion)
        .trim()
        .match(/V?\s*([0-9]+(?:\.[0-9]+)*)/i);

    if (!match) {
        return null;
    }

    const segments = match[1]
        .split('.')
        .map((segment) => {
            const value = Number.parseInt(segment, 10);
            return Number.isFinite(value) ? value : 0;
        });

    return segments.length ? segments : null;
}

function compareVersionSegments(a = [], b = []) {
    const maxLength = Math.max(a.length, b.length);
    for (let index = 0; index < maxLength; index += 1) {
        const segmentA = a[index] ?? 0;
        const segmentB = b[index] ?? 0;
        if (segmentA > segmentB) {
            return 1;
        }
        if (segmentA < segmentB) {
            return -1;
        }
    }
    return 0;
}

function formatVersionDisplay(rawVersion) {
    if (!rawVersion && rawVersion !== 0) {
        return null;
    }

    const match = String(rawVersion)
        .trim()
        .match(/([0-9]+(?:\.[0-9]+)*)/);

    if (!match) {
        return null;
    }

    return `V${match[1]}`;
}

const DEFAULT_LOCAL_VERSION_DISPLAY = 'V2.0';
const REMOTE_README_URL = 'https://raw.githubusercontent.com/RubenOnsurbe/HTDOCSManager/main/README.md';
const GITHUB_RELEASES_URL = 'https://github.com/RubenOnsurbe/HTDOCSManager/releases';
const VersionBannerStates = Object.freeze({
    checking: {
        icon: 'fa-circle-notch',
        spin: true,
        message: 'Comprobando versión más reciente...'
    },
    latest: {
        icon: 'fa-check-circle',
        spin: false,
        message: 'Estás usando la versión más reciente disponible.'
    },
    outdated: {
        icon: 'fa-exclamation-triangle',
        spin: false,
        message: 'Nueva versión disponible.',
        showLink: true
    },
    error: {
        icon: 'fa-times-circle',
        spin: false,
        message: 'No se pudo comprobar la versión. Inténtalo de nuevo.',
        showRetry: true
    }
});

const versionBannerRefs = {
    banner: null,
    icon: null,
    message: null,
    remote: null,
    local: null,
    retryButton: null,
    updateLink: null
};

let localVersionDisplay = DEFAULT_LOCAL_VERSION_DISPLAY;
let localVersionSegments = parseVersionSegments(DEFAULT_LOCAL_VERSION_DISPLAY) || [0];
let versionCheckPromise = null;
let lastRemoteVersionInfo = null;
let themePreference = ThemeModes.SYSTEM;
const systemThemeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolveEffectiveTheme(mode = themePreference) {
    if (mode === ThemeModes.SYSTEM) {
        return systemThemeMedia && systemThemeMedia.matches ? ThemeModes.DARK : ThemeModes.LIGHT;
    }
    return mode;
}

function updateThemeToggleUI(mode, effectiveMode = resolveEffectiveTheme(mode)) {
    const buttons = document.querySelectorAll('.theme-option[data-theme-mode]');
    buttons.forEach((button) => {
        const buttonMode = button.dataset.themeMode;
        const isActive = buttonMode === mode;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        button.classList.toggle('is-effective', buttonMode === effectiveMode);
    });
}

function applyThemePreference(mode, { save = true } = {}) {
    themePreference = mode;
    const body = document.body;
    if (!body) {
        return;
    }

    const effective = resolveEffectiveTheme(mode);
    body.classList.remove('dark-theme', 'light-theme');
    if (effective === ThemeModes.DARK) {
        body.classList.add('dark-theme');
    } else {
        body.classList.add('light-theme');
    }
    body.dataset.themePreference = mode;
    body.dataset.themeResolved = effective;

    if (save && window.localStorage) {
        window.localStorage.setItem(THEME_PREFERENCE_KEY, mode);
    }

    updateThemeToggleUI(mode, effective);
}

function initThemeToggle() {
    try {
        const stored = window.localStorage ? window.localStorage.getItem(THEME_PREFERENCE_KEY) : null;
        if (stored && Object.values(ThemeModes).includes(stored)) {
            themePreference = stored;
        }
    } catch (error) {
        console.warn('No se pudo leer la preferencia de tema:', error);
    }

    applyThemePreference(themePreference, { save: false });

    const toggleContainer = document.querySelector('.theme-toggle');
    if (toggleContainer) {
        toggleContainer.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-theme-mode]');
            if (!button) {
                return;
            }

            const selectedMode = button.dataset.themeMode;
            if (selectedMode && Object.values(ThemeModes).includes(selectedMode) && selectedMode !== themePreference) {
                applyThemePreference(selectedMode, { save: true });
            }
        });
    }

    if (systemThemeMedia && typeof systemThemeMedia.addEventListener === 'function') {
        systemThemeMedia.addEventListener('change', () => {
            if (themePreference === ThemeModes.SYSTEM) {
                applyThemePreference(ThemeModes.SYSTEM, { save: false });
            }
        });
    } else if (systemThemeMedia && typeof systemThemeMedia.addListener === 'function') {
        systemThemeMedia.addListener(() => {
            if (themePreference === ThemeModes.SYSTEM) {
                applyThemePreference(ThemeModes.SYSTEM, { save: false });
            }
        });
    }
}

async function fetchRemoteVersionInfo() {
    const response = await fetch(REMOTE_README_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Solicitud fallida con estado ${response.status}`);
    }

    const content = await response.text();
    const match = content.match(/Versi[óo]n\s+actual[^\n]*?V?\s*([0-9]+(?:\.[0-9]+)*)/i);
    if (!match) {
        throw new Error('No se encontró la versión remota en el README.');
    }

    const display = `V${match[1]}`;
    const segments = parseVersionSegments(display);
    if (!segments) {
        throw new Error('No se pudo interpretar la versión remota.');
    }

    return {
        display,
        segments
    };
}

function applyVersionBannerState(state, options = {}) {
    const banner = versionBannerRefs.banner;
    if (!banner) {
        return;
    }

    const meta = VersionBannerStates[state] || VersionBannerStates.checking;
    banner.dataset.status = state;
    banner.setAttribute('aria-busy', state === 'checking' ? 'true' : 'false');

    const messageElement = versionBannerRefs.message;
    if (messageElement) {
        messageElement.textContent = options.message || meta.message;
    }

    const remoteElement = versionBannerRefs.remote;
    if (remoteElement) {
        if (typeof options.remoteDisplay === 'string') {
            remoteElement.textContent = options.remoteDisplay;
        } else if (state === 'checking') {
            remoteElement.textContent = '...';
        } else if (state === 'error') {
            remoteElement.textContent = '--';
        }
    }

    const iconElement = versionBannerRefs.icon;
    if (iconElement) {
        iconElement.className = `fas ${meta.icon}`;
        if (meta.spin) {
            iconElement.classList.add('fa-spin');
        }
        iconElement.setAttribute('aria-hidden', 'true');
    }

    const updateLink = versionBannerRefs.updateLink;
    if (updateLink) {
        const showLink = options.showLink !== undefined ? options.showLink : Boolean(meta.showLink);
        updateLink.classList.toggle('is-hidden', !showLink);
    }

    const retryButton = versionBannerRefs.retryButton;
    if (retryButton) {
        const showRetry = options.showRetry !== undefined ? options.showRetry : Boolean(meta.showRetry);
        retryButton.classList.toggle('is-hidden', !showRetry);
    }
}

function applyRemoteVersionComparison(remoteInfo) {
    if (!remoteInfo || !remoteInfo.segments) {
        return;
    }

    const remoteDisplay = remoteInfo.display;
    const comparison = compareVersionSegments(remoteInfo.segments, localVersionSegments);

    if (comparison <= 0) {
        applyVersionBannerState('latest', {
            remoteDisplay,
            message: 'Estás usando la versión más reciente disponible.'
        });
    } else {
        applyVersionBannerState('outdated', {
            remoteDisplay,
            message: `Nueva versión disponible: ${remoteDisplay}.`
        });
    }
}

function updateVersionBanner() {
    if (!versionBannerRefs.banner) {
        return Promise.resolve();
    }

    if (versionCheckPromise) {
        return versionCheckPromise;
    }

    versionCheckPromise = (async () => {
        applyVersionBannerState('checking', { remoteDisplay: '...' });

        try {
            const remoteInfo = await fetchRemoteVersionInfo();
            lastRemoteVersionInfo = remoteInfo;
            applyRemoteVersionComparison(remoteInfo);
        } catch (error) {
            console.error('Error al comprobar la versión:', error);
            lastRemoteVersionInfo = null;
            applyVersionBannerState('error', {
                remoteDisplay: '--',
                message: 'No se pudo comprobar la versión. Revisa tu conexión y vuelve a intentarlo.'
            });
        } finally {
            versionCheckPromise = null;
        }
    })();

    return versionCheckPromise;
}

function initVersionBanner() {
    versionBannerRefs.banner = document.getElementById('version-banner');
    if (!versionBannerRefs.banner) {
        return;
    }

    versionBannerRefs.icon = document.getElementById('version-banner-icon');
    versionBannerRefs.message = document.getElementById('version-status-text');
    versionBannerRefs.remote = document.getElementById('remote-version');
    versionBannerRefs.local = document.getElementById('local-version');
    versionBannerRefs.retryButton = document.getElementById('version-check-button');
    versionBannerRefs.updateLink = document.getElementById('version-update-link');

    if (versionBannerRefs.local) {
        versionBannerRefs.local.textContent = localVersionDisplay;
    }

    if (versionBannerRefs.remote) {
        versionBannerRefs.remote.textContent = '...';
    }

    if (versionBannerRefs.retryButton) {
        versionBannerRefs.retryButton.addEventListener('click', () => {
            updateVersionBanner();
        });
    }

    if (versionBannerRefs.updateLink) {
        versionBannerRefs.updateLink.addEventListener('click', (event) => {
            event.preventDefault();
            const targetUrl = versionBannerRefs.updateLink.href || GITHUB_RELEASES_URL;
            if (shell && typeof shell.openExternal === 'function') {
                shell.openExternal(targetUrl);
            } else {
                window.open(targetUrl, '_blank', 'noopener');
            }
        });
    }

    updateVersionBanner();

    (async () => {
        try {
            const reportedVersion = await ipcRenderer.invoke('get-app-version');
            const formattedDisplay = formatVersionDisplay(reportedVersion);
            if (formattedDisplay) {
                localVersionDisplay = formattedDisplay;
                const parsedSegments = parseVersionSegments(formattedDisplay);
                if (parsedSegments) {
                    localVersionSegments = parsedSegments;
                }
                if (versionBannerRefs.local) {
                    versionBannerRefs.local.textContent = localVersionDisplay;
                }
                if (lastRemoteVersionInfo) {
                    applyRemoteVersionComparison(lastRemoteVersionInfo);
                }
            }
        } catch (error) {
            console.warn('No se pudo obtener la versión local desde el proceso principal:', error);
        }
    })();
}

function normalizeGroupName(value = '') {
    return String(value || '').trim();
}

function sanitizeHexColor(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
        return normalized.toUpperCase();
    }

    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
        return `#${normalized.toUpperCase()}`;
    }

    return null;
}

function deriveColorFromName(name = '') {
    const normalized = normalizeGroupName(name);
    if (!normalized) {
        return '#0078D4';
    }

    let hash = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
        hash &= hash; // Force int32
    }

    const hue = Math.abs(hash) % 360;
    const saturation = 65;
    const lightness = 52;
    return hslToHex(hue, saturation, lightness);
}

function hslToHex(h, s, l) {
    const sat = s / 100;
    const light = l / 100;
    const a = sat * Math.min(light, 1 - light);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const color = light - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color)
            .toString(16)
            .padStart(2, '0');
    };

    return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function hexToRgba(hex, alpha = 1) {
    const sanitized = sanitizeHexColor(hex);
    if (!sanitized) {
        return null;
    }

    const bigint = parseInt(sanitized.slice(1), 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getGroupColor(groupName) {
    const normalized = normalizeGroupName(groupName);
    if (!normalized) {
        return null;
    }

    const metadataEntry = groupMetadata[normalized];
    if (metadataEntry && metadataEntry.color && sanitizeHexColor(metadataEntry.color)) {
        return sanitizeHexColor(metadataEntry.color);
    }

    return deriveColorFromName(normalized);
}

function normalizeGroupMetadataMap(rawMetadata) {
    if (!rawMetadata || typeof rawMetadata !== 'object') {
        return {};
    }

    return Object.entries(rawMetadata).reduce((acc, [key, value]) => {
        const normalized = normalizeGroupName(key);
        if (!normalized) {
            return acc;
        }

        const color = value && value.color ? sanitizeHexColor(value.color) : null;
        if (color) {
            acc[normalized] = { color };
        } else {
            acc[normalized] = {};
        }
        return acc;
    }, {});
}

function normalizeGroupKeyForState(groupKey) {
    if (groupKey === '__ungrouped__') {
        return '__ungrouped__';
    }

    const trimmed = typeof groupKey === 'string' ? groupKey.trim() : '';
    return trimmed ? trimmed : '__ungrouped__';
}

function sanitizeGroupOrderList(rawOrder = []) {
    if (!Array.isArray(rawOrder)) {
        return [];
    }

    const seen = new Set();
    const sanitized = [];
    rawOrder.forEach((entry) => {
        let normalized = normalizeGroupName(entry);
        if (normalized === '__ungrouped__') {
            normalized = '';
        }
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        sanitized.push(normalized);
    });
    return sanitized;
}

function getOrderedGroupKeys(currentKeys = []) {
    const mapped = new Map();
    currentKeys.forEach((key) => {
        const normalized = normalizeGroupName(key);
        if (!mapped.has(normalized)) {
            mapped.set(normalized, key);
        }
    });

    const ordered = [];

    if (mapped.has('')) {
        ordered.push(mapped.get(''));
        mapped.delete('');
    }

    groupOrder.forEach((orderedName) => {
        const normalized = normalizeGroupName(orderedName);
        if (mapped.has(normalized)) {
            ordered.push(mapped.get(normalized));
            mapped.delete(normalized);
        }
    });

    Array.from(mapped.keys())
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
        .forEach((key) => {
            ordered.push(mapped.get(key));
        });

    return ordered;
}

function arraysEqual(a = [], b = []) {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((value, index) => value === b[index]);
}

function getProjectDropPlaceholder() {
    if (!projectDropPlaceholder) {
        const placeholder = document.createElement('div');
        placeholder.className = 'project-drop-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.innerHTML = '<div class="project-drop-hint"><i class="fas fa-long-arrow-alt-down"></i> Suelta el proyecto aquí</div>';
        projectDropPlaceholder = placeholder;
    }
    return projectDropPlaceholder;
}

function removeProjectDropPlaceholder() {
    if (projectDropPlaceholder && projectDropPlaceholder.parentElement) {
        projectDropPlaceholder.parentElement.removeChild(projectDropPlaceholder);
    }
    if (projectDropPlaceholder) {
        projectDropPlaceholder.dataset.groupName = '';
    }
}

function getGroupDropPlaceholder() {
    if (!groupDropPlaceholder) {
        const placeholder = document.createElement('div');
        placeholder.className = 'group-drop-placeholder project-group';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.innerHTML = `
            <div class="group-header">
                <div class="group-header-left">
                    <span class="group-toggle-icon"><i class="fas fa-layer-group"></i></span>
                    <div class="group-title">Suelta el grupo aquí</div>
                </div>
                <div class="group-count"></div>
            </div>
        `;
        placeholder.dataset.targetName = '';
        placeholder.dataset.position = 'after';
        groupDropPlaceholder = placeholder;
    }
    return groupDropPlaceholder;
}

function removeGroupDropPlaceholder() {
    if (groupDropPlaceholder && groupDropPlaceholder.parentElement) {
        groupDropPlaceholder.parentElement.removeChild(groupDropPlaceholder);
    }
    if (groupDropPlaceholder) {
        groupDropPlaceholder.dataset.targetName = '';
        groupDropPlaceholder.dataset.position = 'after';
    }
}

function collectUniqueGroups() {
    const fromProjects = savedProjectsCache
        .map((project) => normalizeGroupName(project.group))
        .filter((group) => group);

    const fromMetadata = Object.keys(groupMetadata || {}).map((key) => normalizeGroupName(key)).filter(Boolean);

    return Array.from(new Set([...fromProjects, ...fromMetadata]))
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

function updateGroupSuggestions(groups = collectUniqueGroups()) {
    const datalist = document.getElementById('project-group-options');
    if (!datalist) {
        return;
    }

    datalist.innerHTML = '';

    groups.forEach((group) => {
        const option = document.createElement('option');
        option.value = group;
        datalist.appendChild(option);
    });

    refreshGroupSuggestionDisplays(groups);
}

function refreshGroupSuggestionDisplays(groups = collectUniqueGroups()) {
    const containers = document.querySelectorAll('[data-role="group-suggestions"]');
    if (!containers.length) {
        return;
    }

    containers.forEach((container) => {
        const inputId = container.getAttribute('data-input-id');
        const targetInput = inputId ? document.getElementById(inputId) : null;

        if (!targetInput) {
            container.innerHTML = '';
            container.classList.remove('has-items');
            return;
        }

        const normalizedValue = (targetInput.value || '').trim().toLowerCase();

        if (!groups.length) {
            container.innerHTML = '';
            container.classList.remove('has-items');
        } else {
            container.innerHTML = '';
            container.classList.add('has-items');

            const suggestionValues = ['__clear__', ...groups];

            suggestionValues.forEach((value) => {
                const isClear = value === '__clear__';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'group-suggestion-pill';
                button.dataset.suggestionType = isClear ? 'clear' : 'value';
                button.textContent = isClear ? 'Quitar grupo' : value;

                const matches = isClear
                    ? normalizedValue === ''
                    : value.toLowerCase() === normalizedValue;
                if (matches) {
                    button.classList.add('active');
                }

                button.addEventListener('click', () => {
                    targetInput.value = isClear ? '' : value;
                    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
                    targetInput.focus();
                });

                container.appendChild(button);
            });
        }

        if (!targetInput.dataset.groupSuggestionsBound) {
            targetInput.addEventListener('input', () => refreshGroupSuggestionDisplays());
            targetInput.dataset.groupSuggestionsBound = 'true';
        }
    });
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapePathForOnclick(value = '') {
    return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '&quot;')
    .replace(/'/g, "\\'");
}

function stripProjectTransientFields(project) {
    if (!project || typeof project !== 'object') {
        return project;
    }

    const { status, statusIssues, ...rest } = project;
    return { ...rest };
}

function summarizeProjectStatuses(projects = []) {
    return projects.reduce((summary, project) => {
        const statusKey = project && project.status && ProjectStatusMeta[project.status]
            ? project.status
            : 'ok';
        summary[statusKey] = (summary[statusKey] || 0) + 1;
        return summary;
    }, { ok: 0, warning: 0, missing: 0 });
}

// Show toast notification
function showToast(message, type = 'success', duration = 3000) {
    const toastContainer = document.getElementById('toast-container');

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    // Remove the toast after duration
    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.5s forwards';
        setTimeout(() => {
            toastContainer.removeChild(toast);
        }, 500);
    }, duration);
}

// Open a project folder in the system file explorer
window.openProjectFolder = async (projectPath) => {
    try {
        const cleanPath = projectPath.replace(/['"]/g, '');
        const errorMessage = await shell.openPath(cleanPath);

        if (errorMessage) {
            showToast('No se pudo abrir la carpeta: ' + errorMessage, 'error');
        } else {
            showToast('Carpeta abierta en el explorador.', 'success');
        }
    } catch (error) {
        console.error('Error opening folder:', error);
        showToast('Error al abrir la carpeta: ' + error.message, 'error');
    }
};

// Open a project in Visual Studio Code
window.openInVSCode = async (projectPath) => {
    try {
        // Try opening directly with shell.openPath as a fallback
        if (shell && shell.openPath) {
            // Clean up path - remove quotes or special characters
            const cleanPath = projectPath.replace(/['"]/g, '');

            showToast('Abriendo proyecto...', 'success');

            // Try both the IPC method and shell.openPath
            ipcRenderer.invoke('open-in-vscode', cleanPath)
                .catch(err => {
                    console.error('IPC method failed, trying shell:', err);
                    shell.openPath(cleanPath);
                });

            return;
        }

        // Fall back to original method
        const result = await ipcRenderer.invoke('open-in-vscode', projectPath);
        if (result.success) {
            showToast('Proyecto abierto en VS Code', 'success');
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        console.error('Error opening in VS Code:', error);
        showToast('Error al abrir en VS Code: ' + error.message, 'error');
    }
};

// Handle tab switching and initial data load
document.addEventListener('DOMContentLoaded', async () => {
    initThemeToggle();
    initVersionBanner();

    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

            tab.classList.add('active');
            const tabName = tab.getAttribute('data-tab');
            const tabContent = document.getElementById(`${tabName}-tab`);
            if (tabContent) {
                tabContent.classList.add('active');
            }

            if (tabName === 'saved') {
                loadSavedProjects();
            }
        });
    });

    const projectSearchInput = document.getElementById('project-search');
    if (projectSearchInput) {
        projectSearchInput.addEventListener('input', (event) => {
            renderSavedProjects(event.target.value);
        });
    }

    const groupFilterSelect = document.getElementById('group-filter');
    if (groupFilterSelect) {
        groupFilterSelect.addEventListener('change', (event) => {
            const selectedValue = event.target.value;
            if (selectedValue === '__all__') {
                projectGroupFilter = null;
            } else if (selectedValue === '__ungrouped__') {
                projectGroupFilter = '';
            } else {
                projectGroupFilter = selectedValue;
            }
            renderSavedProjects(projectSearchTerm, projectGroupFilter);
        });
    }

    const manageGroupsButton = document.getElementById('manage-groups-button');
    if (manageGroupsButton) {
        manageGroupsButton.addEventListener('click', () => {
            openManageGroupsModal();
        });
    }

    const manageGroupsModal = document.getElementById('manage-groups-modal');
    if (manageGroupsModal) {
        manageGroupsModal.addEventListener('click', (event) => {
            if (event.target === manageGroupsModal) {
                closeManageGroupsModal();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && manageGroupsModal.style.display === 'flex') {
                closeManageGroupsModal();
            }
        });
    }

    await refreshConfigurationState();

    loadSavedProjects();
});

function updateGroupFilterOptions() {
    const groupFilterSelect = document.getElementById('group-filter');
    if (!groupFilterSelect) {
        return;
    }

    const uniqueGroups = collectUniqueGroups();
    updateGroupSuggestions(uniqueGroups);

    const hasUngrouped = savedProjectsCache.some((project) => !(project.group && project.group.trim()));
    const currentFilterValue = projectGroupFilter === null
        ? '__all__'
        : projectGroupFilter === ''
            ? '__ungrouped__'
            : projectGroupFilter;

    groupFilterSelect.innerHTML = '';

    const allOption = document.createElement('option');
    allOption.value = '__all__';
    allOption.textContent = 'Todos los grupos';
    groupFilterSelect.appendChild(allOption);

    if (hasUngrouped) {
        const ungroupedOption = document.createElement('option');
        ungroupedOption.value = '__ungrouped__';
        ungroupedOption.textContent = 'Sin grupo';
        groupFilterSelect.appendChild(ungroupedOption);
    }

    uniqueGroups.forEach((group) => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        groupFilterSelect.appendChild(option);
    });

    const hasOption = Array.from(groupFilterSelect.options).some((option) => option.value === currentFilterValue);
    groupFilterSelect.value = hasOption ? currentFilterValue : '__all__';
    if (!hasOption) {
        projectGroupFilter = null;
    }
}

function toggleGroupCollapse(groupKey) {
    const normalizedKey = normalizeGroupKeyForState(groupKey);

    if (collapsedGroups.has(normalizedKey)) {
        collapsedGroups.delete(normalizedKey);
    } else {
        collapsedGroups.add(normalizedKey);
    }

    renderSavedProjects(projectSearchTerm, projectGroupFilter);
}

async function refreshConfigurationState() {
    try {
        const result = await ipcRenderer.invoke('get-config');
        if (result.success && result.config) {
            const lastWampPath = result.config.lastWampPath || '';

            const wampInput = document.getElementById('wamp-path');
            if (wampInput) {
                wampInput.value = lastWampPath;
            }

            const modalWampPath = document.getElementById('modal-wamp-path');
            if (modalWampPath) {
                modalWampPath.value = lastWampPath;
            }

            groupMetadata = normalizeGroupMetadataMap(result.config.groupMetadata);
            groupOrder = sanitizeGroupOrderList(result.config.groupOrder);
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }
}

async function loadSavedProjects(showLoading = true) {
    if (savedProjectsLoadPromise) {
        return savedProjectsLoadPromise;
    }

    const projectsList = document.getElementById('projects-list');
    if (!projectsList) {
        return;
    }

    savedProjectsLoadPromise = (async () => {
        if (showLoading) {
            projectsList.innerHTML = '<p class="loading-text"><i class="fas fa-spinner fa-spin"></i> Cargando proyectos guardados...</p>';
        }

        try {
            const result = await ipcRenderer.invoke('get-saved-projects');
            savedProjectsCache = Array.isArray(result.projects) ? result.projects : [];
            hasLoadedSavedProjectsOnce = true;
            updateGroupFilterOptions();
            renderSavedProjects(projectSearchTerm, projectGroupFilter);
        } catch (error) {
            console.error('Error loading saved projects:', error);
            projectsList.innerHTML = `
                <div class="empty-projects">
                    <i class="fas fa-exclamation-triangle"></i>
                    <p>Error al cargar proyectos: ${escapeHtml(error.message)}</p>
                    <button onclick="loadSavedProjects()"><i class="fas fa-sync-alt"></i> Reintentar</button>
                </div>
            `;
        } finally {
            savedProjectsLoadPromise = null;
        }
    })();

    return savedProjectsLoadPromise;
}

async function ensureSavedProjectsLoaded() {
    if (hasLoadedSavedProjectsOnce) {
        return;
    }
    await loadSavedProjects(false);
}


function renderSavedProjects(term = projectSearchTerm, groupFilter = projectGroupFilter) {
    const projectsList = document.getElementById('projects-list');
    if (!projectsList) {
        return;
    }

    projectSearchTerm = term;
    let activeGroupFilter = groupFilter;
    if (typeof activeGroupFilter === 'undefined') {
        activeGroupFilter = projectGroupFilter;
    }
    if (activeGroupFilter !== null && activeGroupFilter !== '') {
        activeGroupFilter = String(activeGroupFilter).trim();
    }
    if (typeof activeGroupFilter === 'undefined') {
        activeGroupFilter = null;
    }
    projectGroupFilter = activeGroupFilter;

    if (activeGroupFilter !== null) {
        const normalizedFilterKey = normalizeGroupKeyForState(activeGroupFilter);
        collapsedGroups.delete(normalizedFilterKey);
    }

    const normalizedTerm = term.trim().toLowerCase();
    const filteredProjects = savedProjectsCache.filter((project) => {
        const name = (project.name || '').toLowerCase();
        const projectPath = (project.projectPath || '').toLowerCase();
        const matchesSearch = !normalizedTerm || name.includes(normalizedTerm) || projectPath.includes(normalizedTerm);

        let matchesGroup = true;
        if (activeGroupFilter !== null) {
            if (activeGroupFilter === '') {
                matchesGroup = !(project.group && project.group.trim());
            } else {
                matchesGroup = (project.group || '').trim() === activeGroupFilter;
            }
        }

        return matchesSearch && matchesGroup;
    });

    const searchInput = document.getElementById('project-search');
    if (searchInput && searchInput.value !== term) {
        searchInput.value = term;
    }

    const groupFilterSelect = document.getElementById('group-filter');
    if (groupFilterSelect) {
        const targetValue = projectGroupFilter === null ? '__all__' : projectGroupFilter === '' ? '__ungrouped__' : projectGroupFilter;
        if (groupFilterSelect.value !== targetValue) {
            const hasOption = Array.from(groupFilterSelect.options).some((option) => option.value === targetValue);
            groupFilterSelect.value = hasOption ? targetValue : '__all__';
        }
    }

    if (!filteredProjects.length) {
        const hasProjects = savedProjectsCache.length > 0;
        const hasSearch = Boolean(normalizedTerm);
        const hasGroupFilter = projectGroupFilter !== null;

        let iconClass = hasSearch ? 'fas fa-search' : 'far fa-folder-open';
        let message = 'No hay proyectos guardados.';

        if (!hasProjects) {
            iconClass = 'far fa-folder-open';
            message = 'No hay proyectos guardados.';
        } else if (hasSearch && hasGroupFilter) {
            const escapedTerm = escapeHtml(term);
            const groupLabel = projectGroupFilter === '' ? 'Sin grupo' : (projectGroupFilter || '');
            const escapedGroup = escapeHtml(groupLabel);
            message = `No se encontraron proyectos para "${escapedTerm}" en el grupo "${escapedGroup}".`;
        } else if (hasSearch) {
            const escapedTerm = escapeHtml(term);
            message = `No se encontraron proyectos para "${escapedTerm}".`;
        } else if (hasGroupFilter) {
            const groupLabel = projectGroupFilter === '' ? 'Sin grupo' : (projectGroupFilter || '');
            const escapedGroup = escapeHtml(groupLabel);
            message = `No hay proyectos en el grupo "${escapedGroup}".`;
        }

        let actionMarkup = '<button onclick="showAddProjectModal()"><i class="fas fa-plus"></i> Añadir Proyecto</button>';
        if (hasProjects && (hasSearch || hasGroupFilter)) {
            actionMarkup = '<button onclick="resetProjectFilters()"><i class="fas fa-times"></i> Limpiar filtros</button>';
        }

        projectsList.innerHTML = `
            <div class="empty-projects">
                <i class="${iconClass}"></i>
                <p>${message}</p>
                ${actionMarkup}
            </div>
        `;
        return;
    }

    const groupedProjects = new Map();
    filteredProjects.forEach((project) => {
        const groupKey = normalizeGroupName(project.group);
        if (!groupedProjects.has(groupKey)) {
            groupedProjects.set(groupKey, []);
        }
        groupedProjects.get(groupKey).push(project);
    });

    const orderedGroupKeys = getOrderedGroupKeys(Array.from(groupedProjects.keys()));

    const allExistingGroupKeys = new Set();
    savedProjectsCache.forEach((project) => {
        allExistingGroupKeys.add(normalizeGroupKeyForState(project.group || ''));
    });

    Array.from(collapsedGroups).forEach((key) => {
        if (!allExistingGroupKeys.has(key)) {
            collapsedGroups.delete(key);
        }
    });

    projectsList.innerHTML = '';

    orderedGroupKeys.forEach((groupKey) => {
        const projectsInGroup = groupedProjects.get(groupKey) || [];
        const groupSection = document.createElement('div');
        groupSection.className = 'project-group';

        const normalizedGroupKey = normalizeGroupKeyForState(groupKey);
        groupSection.dataset.groupKey = normalizedGroupKey;
        groupSection.dataset.groupName = groupKey;

        const isCollapsed = collapsedGroups.has(normalizedGroupKey);
        groupSection.classList.toggle('collapsed', isCollapsed);

        const displayName = groupKey ? escapeHtml(groupKey) : 'Sin grupo';
        const countLabel = projectsInGroup.length === 1 ? '1 proyecto' : `${projectsInGroup.length} proyectos`;
        const toggleIconClass = isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down';
        const groupColor = groupKey ? getGroupColor(groupKey) : null;

        if (groupColor) {
            groupSection.dataset.groupColor = groupColor;
            groupSection.style.setProperty('--group-color', groupColor);
            const headerBg = hexToRgba(groupColor, 0.12);
            const countBg = hexToRgba(groupColor, 0.18);
            const countColor = hexToRgba(groupColor, 0.95);
            const headerHover = hexToRgba(groupColor, 0.2);
            if (headerBg) {
                groupSection.style.setProperty('--group-color-bg', headerBg);
            } else {
                groupSection.style.removeProperty('--group-color-bg');
            }
            if (countBg) {
                groupSection.style.setProperty('--group-count-bg', countBg);
            } else {
                groupSection.style.removeProperty('--group-count-bg');
            }
            if (countColor) {
                groupSection.style.setProperty('--group-count-color', countColor);
            } else {
                groupSection.style.removeProperty('--group-count-color');
            }
            if (headerHover) {
                groupSection.style.setProperty('--group-color-bg-hover', headerHover);
            } else {
                groupSection.style.removeProperty('--group-color-bg-hover');
            }
        } else {
            delete groupSection.dataset.groupColor;
            groupSection.style.removeProperty('--group-color');
            groupSection.style.removeProperty('--group-color-bg');
            groupSection.style.removeProperty('--group-count-bg');
            groupSection.style.removeProperty('--group-count-color');
            groupSection.style.removeProperty('--group-color-bg-hover');
        }

        groupSection.innerHTML = `
            <div class="group-header" role="button" tabindex="0" aria-expanded="${isCollapsed ? 'false' : 'true'}">
                <div class="group-header-left">
                    <span class="group-toggle-icon"><i class="fas ${toggleIconClass}"></i></span>
                    <div class="group-title"><i class="fas fa-layer-group"></i> ${displayName}</div>
                </div>
                <div class="group-count">${countLabel}</div>
            </div>
        `;

        const header = groupSection.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', (event) => {
                if (draggedGroupName) {
                    event.preventDefault();
                    return;
                }
                toggleGroupCollapse(normalizedGroupKey);
            });
            header.addEventListener('keydown', (event) => {
                if (draggedGroupName) {
                    event.preventDefault();
                    return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggleGroupCollapse(normalizedGroupKey);
                }
            });
            if (groupKey) {
                header.setAttribute('draggable', 'true');
            } else {
                header.removeAttribute('draggable');
            }
        }

        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'group-items';
        itemsContainer.dataset.groupName = groupKey;

        projectsInGroup.forEach((project) => {
            itemsContainer.appendChild(createProjectElement(project));
        });

        groupSection.appendChild(itemsContainer);
        projectsList.appendChild(groupSection);
    });

    setupProjectDragAndDrop();
    setupGroupDragAndDrop();
    refreshGroupSuggestionDisplays();
}

async function persistProjectsState() {
    try {
        const payloadProjects = savedProjectsCache.map((project) => stripProjectTransientFields(project));
        const result = await ipcRenderer.invoke('set-saved-projects', { projects: payloadProjects });
        if (result && Array.isArray(result.projects)) {
            savedProjectsCache = result.projects;
        }
    } catch (error) {
        console.error('Error saving project order:', error);
        showToast('No se pudo guardar el orden de los proyectos.', 'error');
    }
}

async function persistGroupOrder() {
    try {
        groupOrder = sanitizeGroupOrderList(groupOrder);
        await ipcRenderer.invoke('update-group-order', { order: groupOrder });
    } catch (error) {
        console.error('Error saving group order:', error);
    }
}

function resolveProjectDropTarget(container) {
    if (!container) {
        return { groupName: '', targetIndex: 0 };
    }

    const groupName = container.dataset.groupName || '';
    let targetIndex = 0;

    const placeholder = projectDropPlaceholder;
    const itemsExcludingDrag = Array.from(container.querySelectorAll('.project-item')).filter((item) => item.dataset.projectId !== draggedProjectId);

    if (placeholder && placeholder.parentElement === container) {
        const siblings = Array.from(container.children);
        const placeholderIndex = siblings.indexOf(placeholder);
        if (placeholderIndex === -1) {
            targetIndex = itemsExcludingDrag.length;
        } else {
            targetIndex = siblings
                .slice(0, placeholderIndex)
                .filter((node) => node.classList && node.classList.contains('project-item') && node.dataset.projectId !== draggedProjectId)
                .length;
        }
    } else {
        targetIndex = itemsExcludingDrag.length;
    }

    return { groupName, targetIndex };
}

function reorderProject(projectId, targetGroupName, targetIndex) {
    const stringifiedId = String(projectId);
    const sourceIndex = savedProjectsCache.findIndex((project) => String(project.id) === stringifiedId);
    if (sourceIndex === -1) {
        return false;
    }

    const [project] = savedProjectsCache.splice(sourceIndex, 1);
    const normalizedTargetGroup = normalizeGroupName(targetGroupName);
    project.group = normalizedTargetGroup;

    const groups = new Map();
    savedProjectsCache.forEach((proj) => {
        const key = normalizeGroupName(proj.group);
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(proj);
    });

    if (!groups.has(normalizedTargetGroup)) {
        groups.set(normalizedTargetGroup, []);
    }

    const targetArray = groups.get(normalizedTargetGroup);
    const clampedIndex = Math.max(0, Math.min(targetIndex, targetArray.length));
    targetArray.splice(clampedIndex, 0, project);
    groups.set(normalizedTargetGroup, targetArray);

    const orderedKeys = getOrderedGroupKeys(Array.from(groups.keys()));
    const rebuilt = [];
    orderedKeys.forEach((key) => {
        const normalized = normalizeGroupName(key);
        const projects = groups.get(normalized) || [];
        projects.forEach((proj) => rebuilt.push(proj));
    });

    savedProjectsCache = rebuilt;
    collapsedGroups.delete(normalizeGroupKeyForState(normalizedTargetGroup));
    if (normalizedTargetGroup && !groupOrder.includes(normalizedTargetGroup)) {
        groupOrder.push(normalizedTargetGroup);
        groupOrder = sanitizeGroupOrderList(groupOrder);
        persistGroupOrder();
    }
    renderSavedProjects(projectSearchTerm, projectGroupFilter);
    persistProjectsState();
    return true;
}

function clearProjectDropIndicators() {
    document.querySelectorAll('.project-item').forEach((item) => {
        item.classList.remove('dragging', 'project-drop-before', 'project-drop-after');
        delete item.dataset.dropPosition;
    });
    document.querySelectorAll('.group-items').forEach((container) => {
        container.classList.remove('project-drop-container');
    });
    removeProjectDropPlaceholder();
}

function setupProjectDragAndDrop() {
    draggedProjectId = null;
    removeProjectDropPlaceholder();
    const projectItems = document.querySelectorAll('.project-item');
    projectItems.forEach((item) => {
        item.setAttribute('draggable', 'true');
        item.addEventListener('dragstart', handleProjectDragStart);
        item.addEventListener('dragend', handleProjectDragEnd);
        item.addEventListener('dragover', handleProjectDragOverItem);
        item.addEventListener('dragenter', handleProjectDragEnterItem);
        item.addEventListener('dragleave', handleProjectDragLeaveItem);
        item.addEventListener('drop', handleProjectDropOnItem);
        item.querySelectorAll('button').forEach((button) => button.setAttribute('draggable', 'false'));
    });

    const groupContainers = document.querySelectorAll('.group-items');
    groupContainers.forEach((container) => {
        container.addEventListener('dragover', handleProjectDragOverContainer);
        container.addEventListener('dragleave', handleProjectDragLeaveContainer);
        container.addEventListener('drop', handleProjectDropOnContainer);
    });

    const groupSections = document.querySelectorAll('.project-group');
    groupSections.forEach((section) => {
        section.addEventListener('dragover', handleProjectDragOverSection);
        section.addEventListener('dragleave', handleProjectDragLeaveSection);
        section.addEventListener('drop', handleProjectDropOnSection);
    });
}

function handleProjectDragStart(event) {
    if (draggedGroupName) {
        return;
    }
    const item = event.currentTarget;
    draggedProjectId = item.dataset.projectId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedProjectId || '');
    item.classList.add('dragging');
}

function handleProjectDragEnd() {
    draggedProjectId = null;
    clearProjectDropIndicators();
}

function handleProjectDragOverItem(event) {
    if (!draggedProjectId || draggedGroupName) {
        return;
    }
    const item = event.currentTarget;
    const targetId = item.dataset.projectId;
    if (!targetId || targetId === draggedProjectId) {
        return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const container = item.parentElement;
    if (!container) {
        return;
    }

    const rect = item.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    const after = offsetY > rect.height / 2;

    const placeholder = getProjectDropPlaceholder();
    if (placeholder.parentElement !== container) {
        container.appendChild(placeholder);
    }
    if (after) {
        container.insertBefore(placeholder, item.nextSibling);
    } else {
        container.insertBefore(placeholder, item);
    }

    document.querySelectorAll('.project-item').forEach((other) => {
        if (other !== item) {
            other.classList.remove('project-drop-before', 'project-drop-after');
            delete other.dataset.dropPosition;
        }
    });

    item.dataset.dropPosition = after ? 'after' : 'before';
    item.classList.toggle('project-drop-before', !after);
    item.classList.toggle('project-drop-after', after);

    const groupName = container.dataset.groupName || item.dataset.groupName || '';
    placeholder.dataset.groupName = groupName;
}

function handleProjectDragEnterItem(event) {
    handleProjectDragOverItem(event);
}

function handleProjectDragLeaveItem(event) {
    const item = event.currentTarget;
    item.classList.remove('project-drop-before', 'project-drop-after');
    delete item.dataset.dropPosition;
}

function handleProjectDropOnItem(event) {
    if (!draggedProjectId || draggedGroupName) {
        return;
    }
    const item = event.currentTarget;
    const targetId = item.dataset.projectId;
    if (!targetId || targetId === draggedProjectId) {
        return;
    }
    event.preventDefault();
    const container = item.parentElement;
    const { groupName, targetIndex } = resolveProjectDropTarget(container);
    clearProjectDropIndicators();
    reorderProject(draggedProjectId, groupName, targetIndex);
    draggedProjectId = null;
}

function handleProjectDragOverContainer(event) {
    if (!draggedProjectId || draggedGroupName) {
        return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const container = event.currentTarget;
    container.classList.add('project-drop-container');

    const placeholder = getProjectDropPlaceholder();
    if (placeholder.parentElement !== container) {
        container.appendChild(placeholder);
    } else if (container.lastElementChild !== placeholder) {
        container.appendChild(placeholder);
    }
    placeholder.dataset.groupName = container.dataset.groupName || '';
}

function handleProjectDragLeaveContainer(event) {
    const container = event.currentTarget;
    const nextElement = event.relatedTarget;
    if (nextElement && container.contains(nextElement)) {
        return;
    }
    container.classList.remove('project-drop-container');
    if (projectDropPlaceholder && projectDropPlaceholder.parentElement === container) {
        container.removeChild(projectDropPlaceholder);
    }
}

function handleProjectDropOnContainer(event) {
    if (!draggedProjectId || draggedGroupName) {
        return;
    }
    event.preventDefault();
    const container = event.currentTarget;
    const { groupName, targetIndex } = resolveProjectDropTarget(container);
    clearProjectDropIndicators();
    reorderProject(draggedProjectId, groupName, targetIndex);
    draggedProjectId = null;
}

function handleProjectDragOverSection(event) {
    if (!draggedProjectId || draggedGroupName) {
        return;
    }
    const section = event.currentTarget;
    const itemsContainer = section.querySelector('.group-items');
    if (!itemsContainer) {
        return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    itemsContainer.classList.add('project-drop-container');
    const placeholder = getProjectDropPlaceholder();
    if (placeholder.parentElement !== itemsContainer) {
        itemsContainer.appendChild(placeholder);
    }
    placeholder.dataset.groupName = itemsContainer.dataset.groupName || section.dataset.groupName || '';
}

function handleProjectDropOnSection(event) {
    if (!draggedProjectId || draggedGroupName) {
        return;
    }
    const section = event.currentTarget;
    const itemsContainer = section.querySelector('.group-items');
    if (!itemsContainer) {
        return;
    }
    event.preventDefault();
    const { groupName, targetIndex } = resolveProjectDropTarget(itemsContainer);
    clearProjectDropIndicators();
    reorderProject(draggedProjectId, groupName, targetIndex);
    draggedProjectId = null;
}

function handleProjectDragLeaveSection(event) {
    const section = event.currentTarget;
    const nextElement = event.relatedTarget;
    if (nextElement && section.contains(nextElement)) {
        return;
    }
    const itemsContainer = section.querySelector('.group-items');
    if (itemsContainer) {
        itemsContainer.classList.remove('project-drop-container');
        if (projectDropPlaceholder && projectDropPlaceholder.parentElement === itemsContainer) {
            itemsContainer.removeChild(projectDropPlaceholder);
        }
    }
}

function setupGroupDragAndDrop() {
    draggedGroupName = null;
    removeGroupDropPlaceholder();

    const sections = document.querySelectorAll('.project-group');
    sections.forEach((section) => {
        section.addEventListener('dragover', handleGroupDragOverSection);
        section.addEventListener('dragleave', handleGroupDragLeaveSection);
        section.addEventListener('drop', handleGroupDropOnSection);

        const groupName = section.dataset.groupName || '';
        const header = section.querySelector('.group-header');
        if (!header) {
            return;
        }

        if (groupName) {
            section.setAttribute('draggable', 'true');
            header.setAttribute('draggable', 'true');
            if (section.dataset.groupDragBound !== 'true') {
                section.addEventListener('dragstart', handleGroupDragStart);
                section.addEventListener('dragend', handleGroupDragEnd);
                section.dataset.groupDragBound = 'true';
            }
        } else {
            section.removeAttribute('draggable');
            delete section.dataset.groupDragBound;
            header.removeAttribute('draggable');
        }
    });

    const projectsList = document.getElementById('projects-list');
    if (projectsList && projectsList.dataset.groupDndBound !== 'true') {
        projectsList.addEventListener('dragover', handleGroupDragOverList);
        projectsList.addEventListener('dragleave', handleGroupDragLeaveList);
        projectsList.addEventListener('drop', handleGroupDropOnList);
        projectsList.dataset.groupDndBound = 'true';
    }
}

function handleGroupDragStart(event) {
    if (draggedProjectId) {
        return;
    }
    const handle = event.currentTarget;
    const section = handle.closest('.project-group');
    if (!section) {
        event.preventDefault();
        return;
    }
    const groupName = section.dataset.groupName || '';
    if (!groupName) {
        event.preventDefault();
        return;
    }
    event.stopPropagation();
    draggedGroupName = groupName;
    section.classList.add('dragging-group');
    removeGroupDropPlaceholder();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', groupName);
}

function handleGroupDragEnd() {
    clearGroupDragState();
}

function handleGroupDragOverSection(event) {
    if (!draggedGroupName || draggedProjectId) {
        return;
    }
    const section = event.currentTarget;
    const targetName = section.dataset.groupName || '';
    if (targetName === draggedGroupName) {
        return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const list = section.parentElement;
    if (!list) {
        return;
    }

    const rect = section.getBoundingClientRect();
    let after = event.clientY > rect.top + (rect.height / 2);
    const placeholder = getGroupDropPlaceholder();

    if (!targetName) {
        after = true;
    }

    placeholder.dataset.targetName = targetName;
    placeholder.dataset.position = after ? 'after' : 'before';

    if (placeholder.parentElement !== list) {
        list.appendChild(placeholder);
    }

    if (after) {
        list.insertBefore(placeholder, section.nextSibling);
    } else {
        list.insertBefore(placeholder, section);
    }

    section.dataset.dropPosition = after ? 'after' : 'before';
    section.classList.toggle('group-drop-before', !after && !!targetName);
    section.classList.toggle('group-drop-after', after);
}

function handleGroupDragLeaveSection(event) {
    const section = event.currentTarget;
    section.classList.remove('group-drop-before', 'group-drop-after');
    delete section.dataset.dropPosition;
    const nextElement = event.relatedTarget;
    const parent = section.parentElement;
    if (!nextElement || !parent || !parent.contains(nextElement)) {
        removeGroupDropPlaceholder();
    }
}

function handleGroupDropOnSection(event) {
    if (!draggedGroupName || draggedProjectId) {
        return;
    }
    const section = event.currentTarget;
    let targetName = section.dataset.groupName || '';
    if (targetName === draggedGroupName) {
        return;
    }
    event.preventDefault();

    let position = section.dataset.dropPosition === 'before' ? 'before' : 'after';
    const placeholder = groupDropPlaceholder;
    if (placeholder && placeholder.parentElement) {
        const placeholderTarget = placeholder.dataset.targetName;
        if (typeof placeholderTarget !== 'undefined') {
            if (placeholderTarget === '__end__') {
                targetName = null;
            } else {
                targetName = placeholderTarget;
            }
            position = placeholder.dataset.position === 'before' ? 'before' : 'after';
        }
    }

    if (!targetName && position === 'before') {
        position = 'after';
    }

    applyGroupReorder(draggedGroupName, targetName, position);
    clearGroupDragState();
}

function handleGroupDragOverList(event) {
    if (!draggedGroupName || draggedProjectId) {
        return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const list = event.currentTarget;
    const placeholder = getGroupDropPlaceholder();
    placeholder.dataset.targetName = '__end__';
    placeholder.dataset.position = 'after';
    if (placeholder.parentElement !== list) {
        list.appendChild(placeholder);
    } else if (list.lastElementChild !== placeholder) {
        list.appendChild(placeholder);
    }
}

function handleGroupDragLeaveList() {
    // No-op but keeps symmetry with drop handler
    const list = event.currentTarget;
    const nextElement = event.relatedTarget;
    if (!nextElement || !list.contains(nextElement)) {
        removeGroupDropPlaceholder();
    }
}

function handleGroupDropOnList(event) {
    if (!draggedGroupName || draggedProjectId) {
        return;
    }
    event.preventDefault();
    applyGroupReorder(draggedGroupName, null, 'after');
    clearGroupDragState();
}

function applyGroupReorder(draggedName, targetName, position = 'after') {
    const normalizedDragged = normalizeGroupName(draggedName);
    if (!normalizedDragged) {
        return;
    }

    let workingOrder = sanitizeGroupOrderList(groupOrder).filter((name) => name !== normalizedDragged);

    if (targetName === null || typeof targetName === 'undefined') {
        workingOrder.push(normalizedDragged);
    } else {
        const normalizedTarget = normalizeGroupName(targetName);
        if (!normalizedTarget) {
            workingOrder.splice(0, 0, normalizedDragged);
        } else {
            let targetIndex = workingOrder.indexOf(normalizedTarget);
            if (targetIndex === -1) {
                workingOrder.push(normalizedTarget);
                targetIndex = workingOrder.length - 1;
            }
            const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
            workingOrder.splice(insertIndex, 0, normalizedDragged);
        }
    }

    workingOrder = sanitizeGroupOrderList(workingOrder);
    if (!arraysEqual(workingOrder, groupOrder)) {
        groupOrder = workingOrder;
        persistGroupOrder();
        renderSavedProjects(projectSearchTerm, projectGroupFilter);
    }
}

function clearGroupDragState() {
    draggedGroupName = null;
    document.querySelectorAll('.project-group').forEach((section) => {
        section.classList.remove('dragging-group', 'group-drop-before', 'group-drop-after');
        delete section.dataset.dropPosition;
    });
    removeGroupDropPlaceholder();
}

function createProjectElement(project) {
    const projectId = String(project.id);
    const projectItem = document.createElement('div');
    projectItem.className = 'project-item';
    projectItem.id = `project-${projectId}`;
    const groupRaw = (project.group || '').trim();
    projectItem.dataset.projectId = projectId;
    projectItem.dataset.groupName = groupRaw;

    const escapedPath = escapePathForOnclick(project.projectPath || '');
    const nameValue = escapeHtml(project.name || '');
    const pathValue = escapeHtml(project.projectPath || '');
    const groupValue = escapeHtml(groupRaw);

    const statusKey = project && project.status && ProjectStatusMeta[project.status] ? project.status : 'ok';
    const statusMeta = ProjectStatusMeta[statusKey] || ProjectStatusMeta.ok;
    const statusIssues = Array.isArray(project.statusIssues) ? project.statusIssues.filter(Boolean) : [];
    const statusTooltipSource = statusIssues.length ? statusIssues.join(' • ') : statusMeta.defaultMessage;
    const statusTooltip = escapeHtml(statusTooltipSource);
    const statusLabel = escapeHtml(statusMeta.label);
    const statusIndicatorHtml = `
        <span class="project-status-indicator ${statusMeta.className}" title="${statusTooltip}">
            <i class="fas ${statusMeta.icon}" aria-hidden="true"></i>
            <span class="project-status-text">${statusLabel}</span>
        </span>
    `;

    let groupLabelHtml = '';
    if (groupRaw) {
        const chipColor = getGroupColor(groupRaw);
        const chipBg = chipColor ? hexToRgba(chipColor, 0.16) : null;
        const chipBorder = chipColor ? hexToRgba(chipColor, 0.4) : null;
        const chipStyleParts = [];
        if (chipBg) {
            chipStyleParts.push(`background-color: ${chipBg}`);
        }
        if (chipBorder) {
            chipStyleParts.push(`border-color: ${chipBorder}`);
        }
        if (chipColor) {
            chipStyleParts.push(`color: ${chipColor}`);
        }
        const chipStyle = chipStyleParts.length ? ` style="${chipStyleParts.join('; ')}"` : '';
        groupLabelHtml = `<div class="project-group-label"${chipStyle}><i class="fas fa-layer-group"></i> ${groupValue}</div>`;
    }

    let statusActionsHtml = '';
    if (statusKey === 'missing') {
        statusActionsHtml = `
            <div class="project-status-actions">
                <button class="status-action-btn" onclick="startRelocateProject('${projectId}')" title="Reubicar proyecto desaparecido">
                    <i class="fas fa-map-marker-alt"></i>
                </button>
                <button class="status-action-btn status-action-danger" onclick="deleteProject('${projectId}')" title="Eliminar proyecto">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </div>
        `;
    }

    projectItem.dataset.status = statusKey;
    projectItem.classList.add(`project-item-status-${statusKey}`);

    projectItem.innerHTML = `
        <!-- Normal view mode -->
        <div class="project-info" style="display: block;">
            <div class="project-name">
                <span class="project-title"><i class="fas fa-project-diagram"></i> ${nameValue}</span>
                ${statusIndicatorHtml}
            </div>
            <div class="project-path">
                <i class="fas fa-folder"></i> ${pathValue}
            </div>
            ${groupLabelHtml}
            ${statusActionsHtml}
        </div>
        
        <!-- Edit form (hidden by default) -->
        <div class="project-edit-form" style="display: none;">
            <input type="text" class="edit-field edit-name-input" value="${nameValue}" placeholder="Nombre del proyecto">
            <div class="edit-path-row">
                <input type="text" class="edit-field edit-path-input" value="${pathValue}" placeholder="Ruta del proyecto">
                <button class="edit-path-browse" onclick="selectProjectDirInline('${projectId}')"><i class="fas fa-folder-open"></i></button>
            </div>
            <input type="text" id="edit-group-${projectId}" class="edit-field edit-group-input" value="${groupValue}" placeholder="Grupo (opcional)" list="project-group-options">
            <div class="group-suggestions" data-role="group-suggestions" data-input-id="edit-group-${projectId}"></div>
        </div>
        
        <!-- Normal action buttons -->
        <div class="project-actions project-normal-controls" style="display: flex;">
            <button class="action-btn deploy-btn" onclick="deploySavedProject('${projectId}')" title="Desplegar proyecto">
                <i class="fas fa-upload"></i>
            </button>
            <button class="action-btn edit-btn" onclick="toggleEditMode('${projectId}')" title="Editar proyecto">
                <i class="fas fa-edit"></i>
            </button>
            <button class="action-btn group-btn" onclick="editProjectGroup('${projectId}')" title="Asignar grupo">
                <i class="fas fa-layer-group"></i>
            </button>
            <button class="action-btn vscode-btn" onclick="openInVSCode('${escapedPath}')" title="Abrir en VS Code">
                ${vscodeSvgIcon}
            </button>
            <button class="action-btn folder-btn" onclick="openProjectFolder('${escapedPath}')" title="Abrir carpeta">
                <i class="fas fa-folder-open"></i>
            </button>
            <button class="action-btn delete-btn" onclick="deleteProject('${projectId}')" title="Eliminar proyecto">
                <i class="fas fa-trash-alt"></i>
            </button>
        </div>
        
        <!-- Edit mode action buttons -->
        <div class="project-actions project-edit-controls" style="display: none;">
            <button class="action-btn confirm-btn" onclick="saveEditedProject('${projectId}')" title="Guardar cambios">
                <i class="fas fa-check"></i>
            </button>
            <button class="action-btn cancel-edit-btn" onclick="toggleEditMode('${projectId}')" title="Cancelar edición">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;

    return projectItem;
}

window.clearProjectSearch = () => {
    projectSearchTerm = '';
    const searchInput = document.getElementById('project-search');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    renderSavedProjects('', projectGroupFilter);
};

window.resetProjectFilters = () => {
    projectSearchTerm = '';
    projectGroupFilter = null;

    const searchInput = document.getElementById('project-search');
    if (searchInput) {
        searchInput.value = '';
    }

    const groupFilterSelect = document.getElementById('group-filter');
    if (groupFilterSelect) {
        groupFilterSelect.value = '__all__';
    }

    renderSavedProjects('', null);
};

window.revalidateAllProjects = async () => {
    try {
        await loadSavedProjects();
        const summary = summarizeProjectStatuses(savedProjectsCache);
        const toastType = summary.missing > 0 ? 'error' : summary.warning > 0 ? 'warning' : 'success';
        showToast(`Revisión completada: ${summary.ok} OK, ${summary.warning} con avisos, ${summary.missing} sin ruta.`, toastType, 5000);
    } catch (error) {
        console.error('Error revalidating projects:', error);
        showToast('No se pudieron revalidar los proyectos.', 'error');
    }
};

// Save XAMPP/WAMP path
window.saveXamppPath = async () => {
    const wampPath = document.getElementById('wamp-path').value;

    if (!wampPath) {
        showToast('Debes ingresar la ruta de XAMPP/WAMP.', 'warning');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('save-config', { wampPath });
        if (result.success) {
            showToast('Ruta guardada correctamente.', 'success');
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        console.error('Error saving XAMPP path:', error);
        showToast('Error al guardar la ruta: ' + error.message, 'error');
    }
};

window.exportConfiguration = async () => {
    try {
        const result = await ipcRenderer.invoke('export-config');
        if (!result) {
            showToast('No se pudo exportar la configuración.', 'error');
            return;
        }

        if (result.canceled) {
            showToast('Exportación cancelada.', 'warning');
            return;
        }

        if (result.success) {
            const projectCount = typeof result.projectCount === 'number' ? result.projectCount : 0;
            showToast(`Configuración exportada (${projectCount} proyectos).`, 'success');
        } else {
            showToast(result.message || 'No se pudo exportar la configuración.', 'error');
        }
    } catch (error) {
        console.error('Error exporting configuration:', error);
        showToast('Error al exportar la configuración: ' + error.message, 'error');
    }
};

window.importConfiguration = async () => {
    try {
        const result = await ipcRenderer.invoke('import-config');
        if (!result) {
            showToast('No se pudo importar la configuración.', 'error');
            return;
        }

        if (result.canceled) {
            showToast('Importación cancelada.', 'warning');
            return;
        }

        if (!result.success) {
            showToast(result.message || 'No se pudo importar la configuración.', 'error');
            return;
        }

        await refreshConfigurationState();

        if (Array.isArray(result.projects)) {
            savedProjectsCache = result.projects;
            hasLoadedSavedProjectsOnce = true;
            updateGroupFilterOptions();
            renderSavedProjects(projectSearchTerm, projectGroupFilter);
        } else {
            await loadSavedProjects(false);
        }

        const importedCount = typeof result.importedCount === 'number'
            ? result.importedCount
            : savedProjectsCache.length;
        const ignoredCount = typeof result.ignoredCount === 'number' ? result.ignoredCount : 0;

        showToast(`Importación finalizada: ${importedCount} proyectos importados, ${ignoredCount} duplicados ignorados.`, 'success', 5000);
    } catch (error) {
        console.error('Error importing configuration:', error);
        showToast('Error al importar la configuración: ' + error.message, 'error');
    }
};

// Backup XAMPP/WAMP projects
window.backupXamppProjects = async () => {
    const wampPath = document.getElementById('wamp-path').value;

    if (!wampPath) {
        showToast('Debes ingresar la ruta de XAMPP/WAMP.', 'warning');
        return;
    }

    try {
        showToast('Iniciando respaldo de proyectos...', 'success');
        const result = await ipcRenderer.invoke('backup-xampp-projects', { wampPath });
        if (result.success) {
            showToast(`Respaldo completado: ${result.backupPath}`, 'success');
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        console.error('Error backing up projects:', error);
        showToast('Error al respaldar proyectos: ' + error.message, 'error');
    }
};

// Show add project modal
window.showAddProjectModal = () => {
    const modal = document.getElementById('add-project-modal');
    modal.style.display = 'flex';

    document.getElementById('modal-project-path').value = '';
    document.getElementById('modal-project-name').value = '';

    const modalGroupInput = document.getElementById('modal-project-group');
    if (modalGroupInput) {
        modalGroupInput.value = projectGroupFilter && projectGroupFilter !== '' ? projectGroupFilter : '';
    }

    refreshGroupSuggestionDisplays();
};

function resetGroupManagerModalState() {
    const list = document.getElementById('group-manager-list');
    if (list) {
        list.innerHTML = '';
    }
    groupManagerRowCounter = 0;
}

function buildGroupManagerRows() {
    const modal = document.getElementById('manage-groups-modal');
    const list = document.getElementById('group-manager-list');
    if (!modal || !list) {
        return;
    }

    resetGroupManagerModalState();

    const groups = collectUniqueGroups();
    const counts = savedProjectsCache.reduce((acc, project) => {
        const normalized = normalizeGroupName(project.group);
        if (!normalized) {
            return acc;
        }
        acc[normalized] = (acc[normalized] || 0) + 1;
        return acc;
    }, {});

    if (!groups.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'group-manager-empty';
        emptyState.innerHTML = `
            <i class="fas fa-layer-group"></i>
            <p>Todavía no hay grupos. Puedes crear uno nuevo para organizar tus proyectos.</p>
        `;
        list.appendChild(emptyState);
        return;
    }

    groups.forEach((groupName) => {
        appendGroupManagerRow({
            originalName: groupName,
            name: groupName,
            color: getGroupColor(groupName),
            count: counts[groupName] || 0
        });
    });
}

function createGroupManagerRowElement({ originalName = '', name = '', color = '', count = 0 } = {}) {
    const list = document.getElementById('group-manager-list');
    if (!list) {
        return null;
    }

    const sanitizedColor = sanitizeHexColor(color) || deriveColorFromName(name || originalName || 'Nuevo grupo');
    const rowId = `group-row-${groupManagerRowCounter += 1}`;

    const row = document.createElement('div');
    row.className = 'group-manager-row';
    row.dataset.groupRowId = rowId;
    row.dataset.originalName = normalizeGroupName(originalName);
    row.dataset.deleted = 'false';

    row.innerHTML = `
        <div class="group-manager-row-main">
            <div class="group-manager-field">
                <label for="${rowId}-name">Nombre</label>
                <input type="text" id="${rowId}-name" class="group-manager-name" value="${escapeHtml(name)}" placeholder="Nombre del grupo">
            </div>
            <div class="group-manager-field color">
                <label for="${rowId}-color">Color</label>
                <input type="color" id="${rowId}-color" class="group-manager-color" value="${sanitizeHexColor(sanitizedColor) || '#0078D4'}">
            </div>
            <div class="group-manager-field count">
                <label>Proyectos</label>
                <span class="group-manager-count">${count}</span>
            </div>
        </div>
        <div class="group-manager-row-actions">
            <button type="button" class="group-row-delete" data-row-id="${rowId}"><i class="fas fa-trash"></i> Eliminar</button>
        </div>
    `;

    const deleteButton = row.querySelector('.group-row-delete');
    if (deleteButton) {
        deleteButton.addEventListener('click', () => toggleGroupRowDeletion(rowId));
    }

    const nameInput = row.querySelector('.group-manager-name');
    if (nameInput) {
        nameInput.addEventListener('input', () => {
            nameInput.classList.remove('invalid');
        });
    }

    return row;
}

function appendGroupManagerRow(data = {}) {
    const list = document.getElementById('group-manager-list');
    if (!list) {
        return;
    }

    const existingEmptyState = list.querySelector('.group-manager-empty');
    if (existingEmptyState) {
        existingEmptyState.remove();
    }

    const row = createGroupManagerRowElement(data);
    if (row) {
        list.appendChild(row);
        const nameInput = row.querySelector('.group-manager-name');
        if (nameInput && !data.originalName) {
            nameInput.focus();
        }
    }
}

function toggleGroupRowDeletion(rowId) {
    const row = document.querySelector(`[data-group-row-id="${rowId}"]`);
    if (!row) {
        return;
    }

    const isDeleted = row.dataset.deleted === 'true';
    row.dataset.deleted = isDeleted ? 'false' : 'true';
    const nowDeleted = row.dataset.deleted === 'true';
    row.classList.toggle('pending-delete', nowDeleted);

    const nameInput = row.querySelector('.group-manager-name');
    const colorInput = row.querySelector('.group-manager-color');
    if (nameInput) {
        nameInput.disabled = nowDeleted;
    }
    if (colorInput) {
        colorInput.disabled = nowDeleted;
    }

    const button = row.querySelector('.group-row-delete');
    if (button) {
        button.innerHTML = nowDeleted
            ? '<i class="fas fa-undo"></i> Restaurar'
            : '<i class="fas fa-trash"></i> Eliminar';
    }
}

function collectGroupManagerPayload() {
    const rows = Array.from(document.querySelectorAll('.group-manager-row'));
    const payload = {
        renameMap: {},
        metadata: {},
        removedGroups: []
    };

    const seenNames = new Set();

    rows.forEach((row) => {
        row.querySelectorAll('input').forEach((input) => input.classList.remove('invalid'));
    });

    for (const row of rows) {
        const isDeleted = row.dataset.deleted === 'true';
        const originalName = row.dataset.originalName ? normalizeGroupName(row.dataset.originalName) : '';
        const nameInput = row.querySelector('.group-manager-name');
        const colorInput = row.querySelector('.group-manager-color');

        const desiredName = nameInput ? normalizeGroupName(nameInput.value) : '';
        const desiredColor = colorInput ? sanitizeHexColor(colorInput.value) : null;

        if (isDeleted) {
            if (originalName) {
                payload.removedGroups.push(originalName);
            }
            continue;
        }

        if (!desiredName) {
            const input = nameInput || row;
            input.classList.add('invalid');
            if (typeof input.focus === 'function') {
                input.focus();
            }
            throw new Error('Todos los grupos deben tener un nombre.');
        }

        if (seenNames.has(desiredName)) {
            if (nameInput) {
                nameInput.classList.add('invalid');
                if (typeof nameInput.focus === 'function') {
                    nameInput.focus();
                }
            }
            throw new Error(`El grupo "${desiredName}" está duplicado. Usa un nombre diferente.`);
        }

        seenNames.add(desiredName);

        if (originalName && originalName !== desiredName) {
            payload.renameMap[originalName] = desiredName;
        }

        payload.metadata[desiredName] = {
            color: desiredColor || deriveColorFromName(desiredName)
        };
    }

    return payload;
}

async function persistGroupManagerChanges() {
    try {
        const { renameMap, metadata, removedGroups } = collectGroupManagerPayload();
        const result = await ipcRenderer.invoke('update-group-settings', {
            renameMap,
            metadata,
            removedGroups
        });

        if (!result || !result.success) {
            throw new Error(result && result.message ? result.message : 'No se pudieron guardar los cambios');
        }

        groupMetadata = normalizeGroupMetadataMap(result.groupMetadata);
        groupOrder = sanitizeGroupOrderList(result.groupOrder || groupOrder);

        savedProjectsCache = Array.isArray(result.projects) ? result.projects : savedProjectsCache;
        updateGroupFilterOptions();
        renderSavedProjects(projectSearchTerm, projectGroupFilter);
        refreshGroupSuggestionDisplays();
        showToast('Grupos actualizados correctamente.', 'success');
        closeManageGroupsModal();
    } catch (error) {
        console.error('Error updating groups:', error);
        showToast(error.message || 'No se pudieron guardar los cambios de grupo.', 'error');
    }
}

window.openManageGroupsModal = async () => {
    const modal = document.getElementById('manage-groups-modal');
    if (!modal) {
        return;
    }
    await ensureSavedProjectsLoaded();
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    buildGroupManagerRows();
    const firstInput = modal.querySelector('.group-manager-name:not([disabled])');
    if (firstInput && typeof firstInput.focus === 'function') {
        firstInput.focus();
    }
};

window.closeManageGroupsModal = () => {
    const modal = document.getElementById('manage-groups-modal');
    if (!modal) {
        return;
    }

    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    resetGroupManagerModalState();
};

window.addGroupManagerRow = () => {
    appendGroupManagerRow({
        originalName: '',
        name: '',
        color: '#0078D4',
        count: 0
    });
};

window.saveGroupManagerChanges = () => {
    persistGroupManagerChanges();
};

// Close add project modal
window.closeAddProjectModal = () => {
    const modal = document.getElementById('add-project-modal');
    modal.style.display = 'none';
};

// Select project directory in modal
window.selectModalProjectDir = async () => {
    try {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (!result.canceled) {
            document.getElementById('modal-project-path').value = result.filePaths[0];

            const projectName = document.getElementById('modal-project-name');
            if (projectName && !projectName.value) {
                projectName.value = path.basename(result.filePaths[0]);
            }
        }
    } catch (error) {
        console.error('Error selecting project directory:', error);
        showToast('Error al seleccionar directorio: ' + error.message, 'error');
    }
};

// Save new project from modal
window.saveNewProject = async () => {
    // Get WAMP path from main page
    const wampPath = document.getElementById('wamp-path').value;
    const projectPath = document.getElementById('modal-project-path').value;
    const projectName = document.getElementById('modal-project-name').value;
    const projectGroupInput = document.getElementById('modal-project-group');
    const projectGroup = projectGroupInput ? projectGroupInput.value.trim() : '';

    if (!wampPath) {
        showToast('No se ha configurado la ruta de XAMPP/WAMP en la página principal.', 'warning');
        return;
    }

    if (!projectPath) {
        showToast('Debes seleccionar el directorio del proyecto.', 'warning');
        return;
    }

    try {
        // Save to projects list
        const result = await ipcRenderer.invoke('save-project', {
            wampPath,
            projectPath,
            name: projectName || path.basename(projectPath),
            group: projectGroup
        });

        if (result.success) {
            showToast(result.message, 'success');
            closeAddProjectModal();
            await loadSavedProjects(false);
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        console.error('Error saving project:', error);
        showToast('Error al guardar proyecto: ' + error.message, 'error');
    }
};

// Show edit project modal
window.showEditProjectModal = async (projectId) => {
    try {
        // Get the project details
        const result = await ipcRenderer.invoke('get-saved-projects');
        const project = result.projects.find(p => p.id === projectId);

        if (!project) {
            showToast('Proyecto no encontrado.', 'error');
            return;
        }

        // Fill the form with project details
        document.getElementById('edit-project-id').value = project.id;
        document.getElementById('edit-project-path').value = project.projectPath;
        document.getElementById('edit-project-name').value = project.name;

        // Show the modal
        const modal = document.getElementById('edit-project-modal');
        modal.style.display = 'flex';
    } catch (error) {
        console.error('Error loading project for edit:', error);
        showToast('Error al cargar el proyecto: ' + error.message, 'error');
    }
};

// Close edit project modal
window.closeEditProjectModal = () => {
    const modal = document.getElementById('edit-project-modal');
    modal.style.display = 'none';
};

// Select project directory in edit modal
window.selectEditProjectDir = async () => {
    try {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (!result.canceled) {
            document.getElementById('edit-project-path').value = result.filePaths[0];
        }
    } catch (error) {
        console.error('Error selecting project directory:', error);
        showToast('Error al seleccionar directorio: ' + error.message, 'error');
    }
};

// Update project
window.updateProject = async () => {
    const projectId = document.getElementById('edit-project-id').value;
    const projectPath = document.getElementById('edit-project-path').value;
    const projectName = document.getElementById('edit-project-name').value;
    const wampPath = document.getElementById('wamp-path').value;

    if (!wampPath) {
        showToast('No se ha configurado la ruta de XAMPP/WAMP en la página principal.', 'warning');
        return;
    }

    if (!projectPath) {
        showToast('Debes seleccionar el directorio del proyecto.', 'warning');
        return;
    }

    if (!projectName) {
        showToast('Debes ingresar un nombre para el proyecto.', 'warning');
        return;
    }

    try {
        // Update the project
        const result = await ipcRenderer.invoke('update-project', {
            id: projectId,
            wampPath,
            projectPath,
            name: projectName
        });

        if (result.success) {
            showToast(result.message, 'success');
            closeEditProjectModal();
            await loadSavedProjects(false);
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        console.error('Error updating project:', error);
        showToast('Error al actualizar proyecto: ' + error.message, 'error');
    }
};

// Toggle edit mode for a project
window.toggleEditMode = (projectId) => {
    const projectItem = document.getElementById(`project-${projectId}`);
    if (!projectItem) {
        return;
    }

    if (projectItem.classList.contains('editing')) {
        // Cancel editing - revert to normal view
        projectItem.classList.remove('editing');

        // Show normal info and controls
        projectItem.querySelector('.project-info').style.display = 'block';
        projectItem.querySelector('.project-normal-controls').style.display = 'flex';

        // Hide edit form and controls
        projectItem.querySelector('.project-edit-form').style.display = 'none';
        projectItem.querySelector('.project-edit-controls').style.display = 'none';
    } else {
        // Enter edit mode
        projectItem.classList.add('editing');

        // Hide normal info and controls
        projectItem.querySelector('.project-info').style.display = 'none';
        projectItem.querySelector('.project-normal-controls').style.display = 'none';

        // Show edit form and controls
        projectItem.querySelector('.project-edit-form').style.display = 'flex';
        projectItem.querySelector('.project-edit-controls').style.display = 'flex';

        refreshGroupSuggestionDisplays();
    }
};

window.editProjectGroup = (projectId) => {
    const projectItem = document.getElementById(`project-${projectId}`);
    if (!projectItem) {
        showToast('Proyecto no encontrado.', 'error');
        return;
    }

    if (!projectItem.classList.contains('editing')) {
        window.toggleEditMode(projectId);
    }

    const groupInput = projectItem.querySelector('.edit-group-input');
    if (groupInput) {
        groupInput.focus();
        groupInput.select();
    }
};

window.startRelocateProject = async (projectId) => {
    const projectItem = document.getElementById(`project-${projectId}`);
    if (!projectItem) {
        showToast('Proyecto no encontrado.', 'error');
        return;
    }

    const pathInput = projectItem.querySelector('.edit-path-input');
    const previousValue = pathInput ? pathInput.value : '';

    if (!projectItem.classList.contains('editing')) {
        window.toggleEditMode(projectId);
    }

    try {
        await window.selectProjectDirInline(projectId);
    } catch (error) {
        console.error('Error reubicando el proyecto:', error);
    }

    const updatedPathInput = projectItem.querySelector('.edit-path-input');
    if (updatedPathInput) {
        updatedPathInput.focus();
        updatedPathInput.select();
        if (updatedPathInput.value !== previousValue) {
            showToast('Verifica la nueva ruta y guarda los cambios.', 'warning', 4000);
        }
    }
};

// The VS Code SVG icon as a string
const vscodeSvgIcon = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 100 100"><mask id="a" width="100" height="100" x="0" y="0" mask-type="alpha" maskUnits="userSpaceOnUse"><path fill="#fff" fill-rule="evenodd" d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z" clip-rule="evenodd"/></mask><g mask="url(#a)"><path fill="#0065A9" d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"/><g filter="url(#b)"><path fill="#007ACC" d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"/></g><g filter="url(#c)"><path fill="#1F9CF0" d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"/></g><path fill="url(#d)" fill-rule="evenodd" d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z" clip-rule="evenodd" opacity=".25" style="mix-blend-mode:overlay"/></g><defs><filter id="b" width="116.727" height="92.246" x="-8.394" y="15.829" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/><feOffset/><feGaussianBlur stdDeviation="4.167"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow"/><feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter><filter id="c" width="47.917" height="116.151" x="60.417" y="-8.076" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/><feOffset/><feGaussianBlur stdDeviation="4.167"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow"/><feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter><linearGradient id="d" x1="49.939" x2="49.939" y1=".258" y2="99.742" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>`;

window.selectProjectDirInline = async (projectId) => {
    try {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (!result.canceled) {
            const projectItem = document.getElementById(`project-${projectId}`);
            if (projectItem) {
                const pathInput = projectItem.querySelector('.edit-path-input');
                if (pathInput) {
                    pathInput.value = result.filePaths[0];
                }
            }
        }
    } catch (error) {
        console.error('Error selecting project directory:', error);
        showToast('Error al seleccionar directorio: ' + error.message, 'error');
    }
};

window.saveEditedProject = async (projectId) => {
    const projectItem = document.getElementById(`project-${projectId}`);
    if (!projectItem) {
        showToast('Proyecto no encontrado.', 'error');
        return;
    }

    const nameInput = projectItem.querySelector('.edit-name-input');
    const pathInput = projectItem.querySelector('.edit-path-input');
    const groupInput = projectItem.querySelector('.edit-group-input');
    const newName = nameInput ? nameInput.value.trim() : '';
    const newPath = pathInput ? pathInput.value.trim() : '';
    const newGroup = groupInput ? groupInput.value.trim() : '';

    if (!newName) {
        showToast('Debes ingresar un nombre para el proyecto.', 'warning');
        return;
    }

    if (!newPath) {
        showToast('Debes seleccionar el directorio del proyecto.', 'warning');
        return;
    }

    let currentProject = savedProjectsCache.find((project) => String(project.id) === String(projectId));
    if (!currentProject) {
        await loadSavedProjects();
        currentProject = savedProjectsCache.find((project) => String(project.id) === String(projectId));
    }

    const wampInput = document.getElementById('wamp-path');
    const wampFromInput = wampInput ? wampInput.value.trim() : '';
    const wampPath = wampFromInput || (currentProject ? currentProject.wampPath : '');

    if (!wampPath) {
        showToast('No se ha configurado la ruta de XAMPP/WAMP.', 'warning');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('update-project', {
            id: String(projectId),
            wampPath,
            projectPath: newPath,
            name: newName,
            group: newGroup
        });

        if (result.success) {
            showToast(result.message, 'success');
            await loadSavedProjects(false);
        } else {
            showToast(result.message || 'No se pudo actualizar el proyecto.', 'error');
        }
    } catch (error) {
        console.error('Error updating project:', error);
        showToast('Error al actualizar proyecto: ' + error.message, 'error');
    }
};

// Add a function to load recent projects with improved styling
function loadRecentProjects(recentProjects) {
    const recentProjectsList = document.getElementById('recent-projects-list');
    recentProjectsList.innerHTML = '';

    if (!recentProjects || recentProjects.length === 0) {
        recentProjectsList.innerHTML = `
            <div class="empty-projects">
                <i class="far fa-clock"></i>
                <p>No hay proyectos recientes.</p>
            </div>
        `;
        return;
    }

    recentProjects.forEach(project => {
        const projectItem = document.createElement('div');
        projectItem.className = 'project-item';

        // Ensure path is properly escaped for HTML attributes
        const escapedPath = project.path.replace(/\\/g, '\\\\').replace(/"/g, '&quot;');

        projectItem.innerHTML = `
            <div class="project-info">
                <div class="project-name">
                    <i class="fas fa-folder-open"></i> ${project.name}
                </div>
                <div class="project-path">
                    <i class="fas fa-code-branch"></i> ${project.path}
                </div>
            </div>
            <div class="project-actions">
                <button class="icon-button select-btn" onclick="selectRecentProject('${escapedPath}')" title="Seleccionar proyecto">
                    <i class="fas fa-check-circle"></i>
                </button>
                <button class="icon-button vscode-btn" onclick="openInVSCode('${escapedPath}')" title="Abrir en VS Code">
                    ${vscodeSvgIcon}
                </button>
                <button class="icon-button folder-btn" onclick="openProjectFolder('${escapedPath}')" title="Abrir carpeta">
                    <i class="fas fa-folder-open"></i>
                </button>
            </div>
        `;

        recentProjectsList.appendChild(projectItem);
    });
}

// Deploy a saved project
window.deploySavedProject = async (projectId) => {
    try {
        const result = await ipcRenderer.invoke('get-saved-projects');
        const project = result.projects.find(p => p.id === projectId);

        if (!project) {
            showToast('Proyecto no encontrado.', 'error');
            return;
        }

        const deployResult = await ipcRenderer.invoke('copy-project', {
            wampPath: project.wampPath,
            projectPath: project.projectPath
        });

        showToast(deployResult.message, deployResult.success ? 'success' : 'error');
    } catch (error) {
        console.error('Error deploying saved project:', error);
        showToast('Error al desplegar: ' + error.message, 'error');
    }
};

// Delete a saved project
window.deleteProject = async (projectId) => {
    try {
        const result = await ipcRenderer.invoke('delete-project', projectId);
        showToast(result.message, result.success ? 'success' : 'error');

        if (result.success && Array.isArray(result.projects)) {
            savedProjectsCache = result.projects;
            hasLoadedSavedProjectsOnce = true;
            updateGroupFilterOptions();
            renderSavedProjects(projectSearchTerm, projectGroupFilter);
        } else {
            await loadSavedProjects(false);
        }
    } catch (error) {
        console.error('Error deleting project:', error);
        showToast('Error al eliminar proyecto: ' + error.message, 'error');
    }
};

// Select WAMP directory
window.selectWampDir = async () => {
    try {
        console.log('Selecting WAMP directory...');
        // Check if dialog is properly initialized
        if (!dialog || typeof dialog.showOpenDialog !== 'function') {
            console.error('Dialog API not available, falling back to IPC');
            // Fallback to IPC
            const result = await ipcRenderer.invoke('show-open-dialog', {
                properties: ['openDirectory'],
                title: 'Seleccionar directorio de XAMPP/WAMP'
            });
            if (!result.canceled) {
                document.getElementById('wamp-path').value = result.filePaths[0];
                console.log('Selected path:', result.filePaths[0]);
            }
            return;
        }

        // Regular dialog approach
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Seleccionar directorio de XAMPP/WAMP'
        });
        if (!result.canceled) {
            document.getElementById('wamp-path').value = result.filePaths[0];
            console.log('Selected path:', result.filePaths[0]);
        }
    } catch (error) {
        console.error('Error selecting WAMP directory:', error);
        showToast('Error al seleccionar directorio: ' + error.message, 'error');

        // Try one more fallback method
        try {
            const { dialog } = require('@electron/remote');
            const result = await dialog.showOpenDialog({
                properties: ['openDirectory'],
                title: 'Seleccionar directorio de XAMPP/WAMP'
            });
            if (!result.canceled) {
                document.getElementById('wamp-path').value = result.filePaths[0];
            }
        } catch (secondError) {
            console.error('Second attempt failed:', secondError);
            showToast('No se pudo abrir el selector de directorios. Por favor ingrese la ruta manualmente.', 'error');
        }
    }
};

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');

let mainWindow;

ipcMain.handle('get-app-version', () => {
    try {
        return app.getVersion();
    } catch (error) {
        console.error('No se pudo obtener la versión de la aplicación:', error);
        return null;
    }
});

ipcMain.handle('fetch-remote-readme', async () => {
    const targetUrl = 'https://raw.githubusercontent.com/RubenOnsurbe/HTDOCSManager/main/README.md';

    return new Promise((resolve, reject) => {
        try {
            const request = https.get(targetUrl, {
                headers: {
                    'User-Agent': 'HTDocsManager/2.0 (+https://github.com/RubenOnsurbe/HTDOCSManager)'
                }
            }, (response) => {
                const { statusCode } = response;
                if (statusCode !== 200) {
                    response.resume();
                    reject(new Error(`Respuesta HTTP inesperada: ${statusCode}`));
                    return;
                }

                let rawData = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    rawData += chunk;
                });
                response.on('end', () => resolve(rawData));
            });

            request.on('error', (error) => {
                reject(error);
            });
        } catch (error) {
            reject(error);
        }
    });
});

const DEFAULT_CONFIG = Object.freeze({
    lastWampPath: '',
    recentProjects: [],
    groupMetadata: {},
    groupOrder: []
});

function getProjectsFilePath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'saved-projects.json');
}

function getConfigFilePath() {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'config.json');
}

function normalizeGroupName(value = '') {
    return typeof value === 'string' ? value.trim() : '';
}

function sanitizeHexColor(value = '') {
    const normalized = typeof value === 'string' ? value.trim() : '';
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

function deriveColorFromName(name = '') {
    const normalized = normalizeGroupName(name);
    if (!normalized) {
        return '#0078D4';
    }

    let hash = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
        hash &= hash;
    }

    const hue = Math.abs(hash) % 360;
    return hslToHex(hue, 65, 52);
}

function sanitizeGroupOrder(rawOrder = []) {
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

function sanitizeConfiguration(rawConfig = {}) {
    const sanitized = { ...DEFAULT_CONFIG };

    if (rawConfig && typeof rawConfig === 'object') {
        if (typeof rawConfig.lastWampPath === 'string') {
            sanitized.lastWampPath = rawConfig.lastWampPath.trim();
        }

        if (Array.isArray(rawConfig.recentProjects)) {
            sanitized.recentProjects = rawConfig.recentProjects
                .filter((entry) => entry && typeof entry === 'object')
                .map((entry) => {
                    const projectPath = typeof entry.path === 'string' ? entry.path : '';
                    if (!projectPath) {
                        return null;
                    }
                    const projectName = typeof entry.name === 'string' && entry.name.trim()
                        ? entry.name.trim()
                        : path.basename(projectPath);
                    return {
                        path: projectPath,
                        name: projectName,
                        lastAccessed: entry.lastAccessed || new Date().toISOString()
                    };
                })
                .filter(Boolean)
                .slice(0, 10);
        }

        if (rawConfig.groupMetadata && typeof rawConfig.groupMetadata === 'object') {
            sanitized.groupMetadata = {};
            Object.entries(rawConfig.groupMetadata).forEach(([groupName, meta]) => {
                const normalized = normalizeGroupName(groupName);
                if (!normalized) {
                    return;
                }
                const color = meta && typeof meta.color === 'string' ? sanitizeHexColor(meta.color) : null;
                sanitized.groupMetadata[normalized] = {
                    color: color || deriveColorFromName(normalized)
                };
            });
        }

        if (Array.isArray(rawConfig.groupOrder)) {
            sanitized.groupOrder = sanitizeGroupOrder(rawConfig.groupOrder);
        }
    }

    return sanitized;
}

async function readConfigurationFile() {
    const configFilePath = getConfigFilePath();
    if (!fs.existsSync(configFilePath)) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const configFileData = await fs.readFile(configFilePath, 'utf8');
        return sanitizeConfiguration(JSON.parse(configFileData));
    } catch (error) {
        console.error('No se pudo leer config.json, se usará configuración por defecto:', error);
        return { ...DEFAULT_CONFIG };
    }
}

async function writeConfigurationFile(config = DEFAULT_CONFIG) {
    const configFilePath = getConfigFilePath();
    const sanitized = sanitizeConfiguration(config);
    await fs.writeFile(configFilePath, JSON.stringify(sanitized, null, 2));
    return sanitized;
}

async function backupFileIfExists(filePath, timestampLabel) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    const label = timestampLabel || new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.${label}.bak`;
    await fs.copy(filePath, backupPath);
    return backupPath;
}

function sanitizeProjectRecord(project, index = 0, fallbackPrefix = `project-${Date.now()}`) {
    if (!project || typeof project !== 'object') {
        return null;
    }

    const sanitized = {
        id: project.id ? String(project.id) : `${fallbackPrefix}-${index}`,
        name: typeof project.name === 'string' ? project.name.trim() : '',
        projectPath: typeof project.projectPath === 'string' ? project.projectPath.trim() : '',
        wampPath: typeof project.wampPath === 'string' ? project.wampPath.trim() : '',
        group: typeof project.group === 'string' ? project.group.trim() : '',
        createdAt: project.createdAt || new Date().toISOString()
    };

    if (!sanitized.name && sanitized.projectPath) {
        sanitized.name = path.basename(sanitized.projectPath);
    }

    if (project.updatedAt) {
        sanitized.updatedAt = project.updatedAt;
    }

    return sanitized;
}

function evaluateProjectStatus(project) {
    if (!project || typeof project !== 'object') {
        return project;
    }

    const issues = [];
    let status = 'ok';

    const projectPathValue = typeof project.projectPath === 'string' ? project.projectPath : '';
    if (!projectPathValue || !fs.existsSync(projectPathValue)) {
        status = 'missing';
        issues.push('No se encontró la ruta del proyecto.');
    } else {
        try {
            const stats = fs.statSync(projectPathValue);
            if (!stats.isDirectory()) {
                status = 'missing';
                issues.push('La ruta del proyecto no es un directorio.');
            }
        } catch (error) {
            status = 'missing';
            issues.push(`Error al acceder al proyecto: ${error.message}`);
        }
    }

    const targetPathValue = typeof project.wampPath === 'string' ? project.wampPath : '';
    if (!targetPathValue || !fs.existsSync(targetPathValue)) {
        if (status === 'ok') {
            status = 'warning';
        }
        issues.push('No se encontró la ruta de destino configurada.');
    } else {
        try {
            const stats = fs.statSync(targetPathValue);
            if (!stats.isDirectory()) {
                if (status === 'ok') {
                    status = 'warning';
                }
                issues.push('La ruta de destino no es un directorio.');
            }
        } catch (error) {
            if (status === 'ok') {
                status = 'warning';
            }
            issues.push(`Error al acceder a la ruta de destino: ${error.message}`);
        }
    }

    return {
        ...project,
        status,
        statusIssues: issues
    };
}

function createWindow() {
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: "HTDocs Manager",
        icon: path.join(__dirname, 'HTDocsManager.ico'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        // Remove the menu bar
        autoHideMenuBar: true,
    });

    // Set the application name
    app.setName("HTDocs Manager");

    // Explicitly remove the menu bar
    mainWindow.setMenu(null);

    // Try to initialize @electron/remote
    try {
        const remoteMain = require('@electron/remote/main');
        remoteMain.initialize();
        remoteMain.enable(mainWindow.webContents);
    } catch (error) {
        console.error('Failed to initialize @electron/remote:', error);
        // Continue without remote if it's not available
    }

    // Load the index.html of the app
    mainWindow.loadFile('index.html');

    // Open DevTools in development mode
    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }
}

// This method will be called when Electron has finished initialization
app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// Make sure this handler is properly defined and not duplicated
ipcMain.handle('show-open-dialog', async (event, options) => {
    console.log('Show open dialog requested with options:', options);
    try {
        const result = await dialog.showOpenDialog(options);
        console.log('Dialog result:', result);
        return result;
    } catch (error) {
        console.error('Error showing open dialog:', error);
        return { canceled: true, error: error.message };
    }
});

// Helper function to save configuration - NOT an IPC handler
async function saveConfiguration(configData) {
    try {
        let config = await readConfigurationFile();

        // Update config with new data
        if (configData.wampPath) {
            config.lastWampPath = configData.wampPath;
        }

        if (configData.addRecentProject && configData.projectPath) {
            // Add to recent projects if not already there
            const existingIndex = config.recentProjects.findIndex((p) => p.path === configData.projectPath);

            const projectToAdd = {
                path: configData.projectPath,
                name: configData.projectName || path.basename(configData.projectPath),
                lastAccessed: new Date().toISOString()
            };

            if (existingIndex >= 0) {
                // Update existing entry
                config.recentProjects[existingIndex] = projectToAdd;
            } else {
                // Add new entry, maintain only last 10 projects
                config.recentProjects.unshift(projectToAdd);
                config.recentProjects = config.recentProjects.slice(0, 10);
            }
        }

        if (Array.isArray(configData.groupOrder)) {
            config.groupOrder = sanitizeGroupOrder(configData.groupOrder);
        }

        // Save updated config
        await writeConfigurationFile(config);

        return {
            success: true,
            message: 'Configuración guardada correctamente'
        };
    } catch (error) {
        console.error('Error al guardar configuración:', error);
        return {
            success: false,
            message: `Error al guardar configuración: ${error.message}`
        };
    }
}

async function loadSavedProjectsFromDisk() {
    const projectsFilePath = getProjectsFilePath();

    if (!fs.existsSync(projectsFilePath)) {
        return [];
    }

    try {
        const projectsData = await fs.readFile(projectsFilePath, 'utf8');
        const parsed = JSON.parse(projectsData);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .map((project, index) => sanitizeProjectRecord(project, index))
            .filter(Boolean);
    } catch (error) {
        console.error('Error al leer proyectos guardados:', error);
        return [];
    }
}

async function persistProjectsToDisk(projects) {
    const projectsFilePath = getProjectsFilePath();
    const fallbackPrefix = `project-${Date.now()}`;
    const sanitized = Array.isArray(projects)
        ? projects.map((project, index) => sanitizeProjectRecord(project, index, fallbackPrefix)).filter(Boolean)
        : [];

    await fs.writeFile(projectsFilePath, JSON.stringify(sanitized, null, 2));
    return sanitized;
}

// Add the IPC handlers
ipcMain.handle('save-config', async (event, configData) => {
    return await saveConfiguration(configData);
});

ipcMain.handle('get-config', async (event) => {
    try {
        const config = await readConfigurationFile();

        return {
            success: true,
            config
        };
    } catch (error) {
        console.error('Error al cargar configuración:', error);
        return {
            success: false,
            message: `Error al cargar configuración: ${error.message}`,
            config: { ...DEFAULT_CONFIG }
        };
    }
});

// Project deployment functionality
ipcMain.handle('copy-project', async (event, { wampPath, projectPath }) => {
    try {
        // First, empty the destination directory
        if (fs.existsSync(wampPath)) {
            // Read the directory first to avoid trying to remove system directories
            const existingItems = fs.readdirSync(wampPath);

            // Delete each item in the directory
            for (const item of existingItems) {
                const itemPath = path.join(wampPath, item);
                // Skip certain system folders for safety
                if (['system', 'windows', 'program files', 'users'].some(sys =>
                    item.toLowerCase().includes(sys))) {
                    continue;
                }
                await fs.remove(itemPath);
            }
        } else {
            // Create the directory if it doesn't exist
            await fs.mkdir(wampPath, { recursive: true });
        }

        // Get all items from the source directory
        const sourceItems = fs.readdirSync(projectPath);

        // Copy each item from source to destination
        for (const item of sourceItems) {
            const sourcePath = path.join(projectPath, item);
            const destPath = path.join(wampPath, item);
            await fs.copy(sourcePath, destPath);
        }

        // Save to config using helper function
        await saveConfiguration({
            wampPath,
            addRecentProject: true,
            projectPath,
            projectName: path.basename(projectPath)
        });

        return {
            success: true,
            message: `Contenido del proyecto copiado correctamente a la carpeta de destino.`
        };
    } catch (error) {
        console.error('Error al desplegar el proyecto:', error);
        return {
            success: false,
            message: `Error al desplegar: ${error.message}`
        };
    }
});

// Handle projects management
ipcMain.handle('save-project', async (event, projectData) => {
    try {
        const savedProjects = await loadSavedProjectsFromDisk();

        const newProjectBase = {
            id: Date.now().toString(),
            name: projectData.name || path.basename(projectData.projectPath),
            wampPath: projectData.wampPath,
            projectPath: projectData.projectPath,
            group: projectData.group ? projectData.group.trim() : '',
            createdAt: new Date().toISOString()
        };

        const newProject = sanitizeProjectRecord(newProjectBase, savedProjects.length);
        const updatedProjects = [...savedProjects, newProject];

        const persistedProjects = await persistProjectsToDisk(updatedProjects);
        const persistedNewProject = persistedProjects.find((project) => project.id === newProject.id) || newProject;

        // Also save to config using helper function
        await saveConfiguration({
            wampPath: projectData.wampPath,
            addRecentProject: true,
            projectPath: projectData.projectPath,
            projectName: projectData.name || path.basename(projectData.projectPath)
        });

        return {
            success: true,
            message: `Proyecto "${persistedNewProject.name}" guardado correctamente.`,
            project: evaluateProjectStatus(persistedNewProject)
        };
    } catch (error) {
        console.error('Error al guardar el proyecto:', error);
        return {
            success: false,
            message: `Error al guardar el proyecto: ${error.message}`
        };
    }
});

ipcMain.handle('get-saved-projects', async (event) => {
    try {
        const savedProjects = await loadSavedProjectsFromDisk();
        const projectsWithStatus = savedProjects.map((project) => evaluateProjectStatus(project));
        return {
            success: true,
            projects: projectsWithStatus
        };
    } catch (error) {
        console.error('Error al obtener proyectos guardados:', error);
        return {
            success: false,
            message: `Error al cargar proyectos: ${error.message}`,
            projects: []
        };
    }
});

ipcMain.handle('delete-project', async (event, projectId) => {
    try {
        const savedProjects = await loadSavedProjectsFromDisk();

        // Filter out the project to delete
        const filteredProjects = savedProjects.filter((project) => project.id !== projectId);
        const initialCount = savedProjects.length;

        if (filteredProjects.length === initialCount) {
            return {
                success: false,
                message: 'Proyecto no encontrado.'
            };
        }

        // Save the updated projects list
        const persistedProjects = await persistProjectsToDisk(filteredProjects);

        return {
            success: true,
            message: 'Proyecto eliminado correctamente.',
            projects: persistedProjects.map((project) => evaluateProjectStatus(project))
        };
    } catch (error) {
        console.error('Error al eliminar el proyecto:', error);
        return {
            success: false,
            message: `Error al eliminar el proyecto: ${error.message}`
        };
    }
});

ipcMain.handle('set-saved-projects', async (event, payload = {}) => {
    try {
        const incomingProjects = Array.isArray(payload.projects) ? payload.projects : [];
        const persistedProjects = await persistProjectsToDisk(incomingProjects);
        return {
            success: true,
            projects: persistedProjects.map((project) => evaluateProjectStatus(project))
        };
    } catch (error) {
        console.error('Error al actualizar el orden de proyectos:', error);
        return {
            success: false,
            message: `Error al guardar el orden de los proyectos: ${error.message}`
        };
    }
});

ipcMain.handle('update-group-order', async (event, payload = {}) => {
    try {
        const sanitizedOrder = sanitizeGroupOrder(payload.order || payload.groupOrder);
        await saveConfiguration({ groupOrder: sanitizedOrder });
        return {
            success: true,
            groupOrder: sanitizedOrder
        };
    } catch (error) {
        console.error('Error al actualizar el orden de grupos:', error);
        return {
            success: false,
            message: `Error al guardar el orden de los grupos: ${error.message}`
        };
    }
});

ipcMain.handle('update-group-settings', async (event, payload = {}) => {
    try {
        const renameMapRaw = payload.renameMap && typeof payload.renameMap === 'object' ? payload.renameMap : {};
        const metadataRaw = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
        const removedGroupsRaw = Array.isArray(payload.removedGroups) ? payload.removedGroups : [];

        const renameMap = {};
        Object.entries(renameMapRaw).forEach(([fromName, toName]) => {
            const fromNormalized = normalizeGroupName(fromName);
            const toNormalized = normalizeGroupName(toName);
            if (!fromNormalized || !toNormalized || fromNormalized === toNormalized) {
                return;
            }
            renameMap[fromNormalized] = toNormalized;
        });

        const removedGroups = removedGroupsRaw
            .map((groupName) => normalizeGroupName(groupName))
            .filter(Boolean);
        const removedSet = new Set(removedGroups);

        Object.keys(renameMap).forEach((key) => {
            if (removedSet.has(key)) {
                delete renameMap[key];
            }
        });

        const sanitizedMetadata = {};
        Object.entries(metadataRaw).forEach(([groupName, meta]) => {
            const normalized = normalizeGroupName(groupName);
            if (!normalized || removedSet.has(normalized)) {
                return;
            }
            const color = meta && meta.color ? sanitizeHexColor(meta.color) : null;
            sanitizedMetadata[normalized] = {
                color: color || deriveColorFromName(normalized)
            };
        });

        const duplicateCheck = new Set();
        Object.keys(sanitizedMetadata).forEach((groupName) => {
            if (duplicateCheck.has(groupName)) {
                throw new Error(`Nombre de grupo duplicado: ${groupName}`);
            }
            duplicateCheck.add(groupName);
        });

        let savedProjects = await loadSavedProjectsFromDisk();

        if (Object.keys(renameMap).length > 0) {
            savedProjects = savedProjects.map((project) => {
                const currentGroup = normalizeGroupName(project.group);
                if (currentGroup && renameMap[currentGroup]) {
                    return {
                        ...project,
                        group: renameMap[currentGroup]
                    };
                }
                return project;
            });
        }

        if (removedSet.size > 0) {
            savedProjects = savedProjects.map((project) => {
                const currentGroup = normalizeGroupName(project.group);
                if (currentGroup && removedSet.has(currentGroup)) {
                    return {
                        ...project,
                        group: ''
                    };
                }
                return project;
            });
        }

        const persistedProjects = await persistProjectsToDisk(savedProjects);
        let config = await readConfigurationFile();

        let currentOrder = sanitizeGroupOrder(config.groupOrder);
        if (removedSet.size > 0) {
            currentOrder = currentOrder.filter((name) => !removedSet.has(name));
        }

        Object.entries(renameMap).forEach(([fromName, toName]) => {
            const index = currentOrder.indexOf(fromName);
            if (index !== -1) {
                currentOrder[index] = toName;
            }
        });

        Object.keys(sanitizedMetadata)
            .map((groupName) => normalizeGroupName(groupName))
            .filter(Boolean)
            .forEach((normalized) => {
                if (!currentOrder.includes(normalized)) {
                    currentOrder.push(normalized);
                }
            });

        config.groupOrder = currentOrder;
        config.groupMetadata = sanitizedMetadata;
        config = await writeConfigurationFile(config);

        return {
            success: true,
            projects: persistedProjects.map((project) => evaluateProjectStatus(project)),
            groupMetadata: config.groupMetadata,
            groupOrder: config.groupOrder
        };
    } catch (error) {
        console.error('Error al actualizar los grupos:', error);
        return {
            success: false,
            message: error.message || 'Error al actualizar los grupos'
        };
    }
});

// Handle opening projects in VS Code
ipcMain.handle('open-in-vscode', async (event, projectPath) => {
    try {
        const { execFile, spawn } = require('child_process');
        const path = require('path');
        const appPath = app.getAppPath();

        // Try method 1: Use exec with code command
        try {
            require('child_process').exec(`code "${projectPath}"`, (err) => {
                if (err) {
                    console.error('Method 1 failed:', err);
                    throw err; // Try next method
                }
            });
            return { success: true, message: 'VS Code iniciado (método 1)' };
        } catch (error1) {
            console.error('Method 1 failed:', error1);

            // Try method 2: Use the VS Code executable directly
            try {
                const vscodePath = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
                execFile(vscodePath, [projectPath], (error) => {
                    if (error) {
                        console.error('Method 2 failed:', error);
                        throw error; // Try next method
                    }
                });
                return { success: true, message: 'VS Code iniciado (método 2)' };
            } catch (error2) {
                console.error('Method 2 failed:', error2);

                // Try method 3: Use our batch file
                try {
                    const batchPath = path.join(appPath, 'vscode-opener.bat');
                    spawn('cmd.exe', ['/c', batchPath, projectPath], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    return { success: true, message: 'VS Code iniciado (método 3)' };
                } catch (error3) {
                    console.error('Method 3 failed:', error3);
                    throw error3;
                }
            }
        }
    } catch (error) {
        console.error('All VS Code opening methods failed:', error);
        return {
            success: false,
            message: `Error al abrir VS Code: ${error.message}`
        };
    }
});

// Add backup functionality
ipcMain.handle('backup-xampp-projects', async (event, { wampPath }) => {
    try {
        const fs = require('fs-extra');
        const path = require('path');
        const os = require('os');

        // Verify the directory exists
        if (!fs.existsSync(wampPath)) {
            return {
                success: false,
                message: 'El directorio especificado no existe.'
            };
        }

        // Create backup folder in user documents
        const backupDir = path.join(os.homedir(), 'Documents', 'XAMPP_Backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Create timestamped backup folder
        const date = new Date();
        const timestamp = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}-${date.getMinutes().toString().padStart(2, '0')}`;
        const backupPath = path.join(backupDir, `backup_${timestamp}`);
        fs.mkdirSync(backupPath, { recursive: true });

        // Copy the entire content of the directory instead of individual folders
        await fs.copy(wampPath, backupPath);

        // Count the number of items that were copied
        const copiedItems = fs.readdirSync(backupPath);
        const copiedCount = copiedItems.length;

        return {
            success: true,
            message: `Se han respaldado ${copiedCount} elementos.`,
            backupPath: backupPath
        };
    } catch (error) {
        console.error('Error backing up projects:', error);
        return {
            success: false,
            message: `Error al respaldar proyectos: ${error.message}`
        };
    }
});

// Handle updating a project
ipcMain.handle('update-project', async (event, projectData) => {
    try {
        const savedProjects = await loadSavedProjectsFromDisk();

        // Find the project to update
        const projectIndex = savedProjects.findIndex((project) => project.id === projectData.id);

        if (projectIndex === -1) {
            return {
                success: false,
                message: 'Proyecto no encontrado.'
            };
        }

        const updatedGroup = typeof projectData.group === 'string'
            ? projectData.group.trim()
            : (savedProjects[projectIndex].group || '');

        // Update the project
        savedProjects[projectIndex] = sanitizeProjectRecord({
            ...savedProjects[projectIndex],
            name: projectData.name,
            projectPath: projectData.projectPath,
            wampPath: projectData.wampPath,
            group: updatedGroup,
            updatedAt: new Date().toISOString()
        }, projectIndex);

        // Save the updated projects list
        const persistedProjects = await persistProjectsToDisk(savedProjects);
        const updatedProject = persistedProjects.find((project) => project.id === projectData.id) || savedProjects[projectIndex];

        // Also update in config if needed
        try {
            await saveConfiguration({
                addRecentProject: true,
                projectPath: projectData.projectPath,
                projectName: projectData.name
            });
        } catch (configError) {
            console.error('Error updating config:', configError);
            // Continue even if config update fails
        }

        return {
            success: true,
            message: 'Proyecto actualizado correctamente.',
            project: evaluateProjectStatus(updatedProject)
        };
    } catch (error) {
        console.error('Error updating project:', error);
        return {
            success: false,
            message: `Error al actualizar el proyecto: ${error.message}`
        };
    }
});

ipcMain.handle('export-config', async () => {
    try {
        const config = await readConfigurationFile();
        const projects = await loadSavedProjectsFromDisk();

        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            config,
            projects
        };

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const defaultPath = path.join(app.getPath('documents'), `htdocs-manager-config-${timestamp}.json`);

        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Exportar configuración',
            defaultPath,
            filters: [{ name: 'Archivos JSON', extensions: ['json'] }]
        });

        if (result.canceled || !result.filePath) {
            return {
                success: false,
                canceled: true
            };
        }

        await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');

        return {
            success: true,
            filePath: result.filePath,
            projectCount: projects.length
        };
    } catch (error) {
        console.error('Error exporting configuration:', error);
        return {
            success: false,
            message: `No se pudo exportar la configuración: ${error.message}`
        };
    }
});

ipcMain.handle('import-config', async () => {
    try {
        const openResult = await dialog.showOpenDialog(mainWindow, {
            title: 'Importar configuración',
            filters: [{ name: 'Archivos JSON', extensions: ['json'] }],
            properties: ['openFile']
        });

        if (openResult.canceled || !openResult.filePaths || !openResult.filePaths.length) {
            return {
                success: false,
                canceled: true
            };
        }

        const sourcePath = openResult.filePaths[0];
        const fileContents = await fs.readFile(sourcePath, 'utf8');
        let parsed;

        try {
            parsed = JSON.parse(fileContents);
        } catch (parseError) {
            return {
                success: false,
                message: 'El archivo seleccionado no contiene un JSON válido.'
            };
        }

        const importedConfig = sanitizeConfiguration(parsed && parsed.config ? parsed.config : {});
        const rawProjects = parsed && Array.isArray(parsed.projects) ? parsed.projects : [];

        const importPrefix = `import-${Date.now()}`;
        const seenIds = new Set();
        const seenPaths = new Set();
        let ignoredCount = 0;

        const normalizedProjects = rawProjects
            .map((project, index) => sanitizeProjectRecord(project, index, importPrefix))
            .filter(Boolean)
            .filter((project) => {
                const idKey = project.id;
                const pathKey = project.projectPath ? project.projectPath.toLowerCase() : '';

                if (seenIds.has(idKey) || (pathKey && seenPaths.has(pathKey))) {
                    ignoredCount += 1;
                    return false;
                }

                seenIds.add(idKey);
                if (pathKey) {
                    seenPaths.add(pathKey);
                }

                return true;
            });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const configBackup = await backupFileIfExists(getConfigFilePath(), timestamp);
        const projectsBackup = await backupFileIfExists(getProjectsFilePath(), timestamp);

        const writtenConfig = await writeConfigurationFile(importedConfig);
        const persistedProjects = await persistProjectsToDisk(normalizedProjects);
        const projectsWithStatus = persistedProjects.map((project) => evaluateProjectStatus(project));

        return {
            success: true,
            importedCount: projectsWithStatus.length,
            ignoredCount,
            sourcePath,
            backups: {
                config: configBackup,
                projects: projectsBackup
            },
            config: writtenConfig,
            projects: projectsWithStatus
        };
    } catch (error) {
        console.error('Error importing configuration:', error);
        return {
            success: false,
            message: `No se pudo importar la configuración: ${error.message}`
        };
    }
});
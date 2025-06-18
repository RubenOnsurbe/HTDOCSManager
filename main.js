const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');

let mainWindow;

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
    const { dialog } = require('electron');
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
        const userDataPath = app.getPath('userData');
        const configFilePath = path.join(userDataPath, 'config.json');

        // Read existing config or initialize with defaults
        let config = {
            lastWampPath: '',
            recentProjects: []
        };

        if (fs.existsSync(configFilePath)) {
            const configFileData = await fs.readFile(configFilePath, 'utf8');
            config = JSON.parse(configFileData);
        }

        // Update config with new data
        if (configData.wampPath) {
            config.lastWampPath = configData.wampPath;
        }

        if (configData.addRecentProject && configData.projectPath) {
            // Add to recent projects if not already there
            const existingIndex = config.recentProjects.findIndex(p => p.path === configData.projectPath);

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

        // Save updated config
        await fs.writeFile(configFilePath, JSON.stringify(config, null, 2));

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

// Add the IPC handlers
ipcMain.handle('save-config', async (event, configData) => {
    return await saveConfiguration(configData);
});

ipcMain.handle('get-config', async (event) => {
    try {
        const userDataPath = app.getPath('userData');
        const configFilePath = path.join(userDataPath, 'config.json');

        // Default config
        let config = {
            lastWampPath: '',
            recentProjects: []
        };

        if (fs.existsSync(configFilePath)) {
            const configFileData = await fs.readFile(configFilePath, 'utf8');
            config = JSON.parse(configFileData);
        }

        return {
            success: true,
            config
        };
    } catch (error) {
        console.error('Error al cargar configuración:', error);
        return {
            success: false,
            message: `Error al cargar configuración: ${error.message}`,
            config: {
                lastWampPath: '',
                recentProjects: []
            }
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
        const userDataPath = app.getPath('userData');
        const projectsFilePath = path.join(userDataPath, 'saved-projects.json');

        // Read existing projects or initialize empty array
        let savedProjects = [];
        if (fs.existsSync(projectsFilePath)) {
            const projectsData = await fs.readFile(projectsFilePath, 'utf8');
            savedProjects = JSON.parse(projectsData);
        }

        // Add the new project with a unique ID
        const newProject = {
            id: Date.now().toString(),
            name: projectData.name || path.basename(projectData.projectPath),
            wampPath: projectData.wampPath,
            projectPath: projectData.projectPath,
            createdAt: new Date().toISOString()
        };

        savedProjects.push(newProject);

        // Save the updated projects list
        await fs.writeFile(projectsFilePath, JSON.stringify(savedProjects, null, 2));

        // Also save to config using helper function
        await saveConfiguration({
            wampPath: projectData.wampPath,
            addRecentProject: true,
            projectPath: projectData.projectPath,
            projectName: projectData.name || path.basename(projectData.projectPath)
        });

        return {
            success: true,
            message: `Proyecto "${newProject.name}" guardado correctamente.`,
            project: newProject
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
        const userDataPath = app.getPath('userData');
        const projectsFilePath = path.join(userDataPath, 'saved-projects.json');

        if (!fs.existsSync(projectsFilePath)) {
            return { projects: [] };
        }

        const projectsData = await fs.readFile(projectsFilePath, 'utf8');
        const savedProjects = JSON.parse(projectsData);

        return { projects: savedProjects };
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
        const userDataPath = app.getPath('userData');
        const projectsFilePath = path.join(userDataPath, 'saved-projects.json');

        if (!fs.existsSync(projectsFilePath)) {
            return {
                success: false,
                message: 'No hay proyectos guardados.'
            };
        }

        const projectsData = await fs.readFile(projectsFilePath, 'utf8');
        let savedProjects = JSON.parse(projectsData);

        // Filter out the project to delete
        const initialCount = savedProjects.length;
        savedProjects = savedProjects.filter(project => project.id !== projectId);

        if (savedProjects.length === initialCount) {
            return {
                success: false,
                message: 'Proyecto no encontrado.'
            };
        }

        // Save the updated projects list
        await fs.writeFile(projectsFilePath, JSON.stringify(savedProjects, null, 2));

        return {
            success: true,
            message: 'Proyecto eliminado correctamente.'
        };
    } catch (error) {
        console.error('Error al eliminar el proyecto:', error);
        return {
            success: false,
            message: `Error al eliminar el proyecto: ${error.message}`
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
        const userDataPath = app.getPath('userData');
        const projectsFilePath = path.join(userDataPath, 'saved-projects.json');

        if (!fs.existsSync(projectsFilePath)) {
            return {
                success: false,
                message: 'No hay proyectos guardados.'
            };
        }

        const projectsData = await fs.readFile(projectsFilePath, 'utf8');
        let savedProjects = JSON.parse(projectsData);

        // Find the project to update
        const projectIndex = savedProjects.findIndex(project => project.id === projectData.id);

        if (projectIndex === -1) {
            return {
                success: false,
                message: 'Proyecto no encontrado.'
            };
        }

        // Update the project
        savedProjects[projectIndex] = {
            ...savedProjects[projectIndex],
            name: projectData.name,
            projectPath: projectData.projectPath,
            wampPath: projectData.wampPath,
            updatedAt: new Date().toISOString()
        };

        // Save the updated projects list
        await fs.writeFile(projectsFilePath, JSON.stringify(savedProjects, null, 2));

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
            message: 'Proyecto actualizado correctamente.'
        };
    } catch (error) {
        console.error('Error updating project:', error);
        return {
            success: false,
            message: `Error al actualizar el proyecto: ${error.message}`
        };
    }
});
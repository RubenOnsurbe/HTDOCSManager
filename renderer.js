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

// Handle tab switching
document.addEventListener('DOMContentLoaded', async () => {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active class from all tabs and content
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            // Add active class to clicked tab and corresponding content
            tab.classList.add('active');
            const tabName = tab.getAttribute('data-tab');
            document.getElementById(`${tabName}-tab`).classList.add('active');

            // Load saved projects when switching to saved tab
            if (tabName === 'saved') {
                loadSavedProjects();
            }
        });
    });

    // Load configuration
    try {
        const result = await ipcRenderer.invoke('get-config');
        if (result.success && result.config) {
            // Set the last used WAMP path
            if (result.config.lastWampPath) {
                document.getElementById('wamp-path').value = result.config.lastWampPath;

                // Also set it in the modal if it exists
                const modalWampPath = document.getElementById('modal-wamp-path');
                if (modalWampPath) {
                    modalWampPath.value = result.config.lastWampPath;
                }
            }
        }
    } catch (error) {
        console.error('Error loading config:', error);
    }

    // Load saved projects initially
    loadSavedProjects();
});

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

    // Clear project fields
    document.getElementById('modal-project-path').value = '';
    document.getElementById('modal-project-name').value = '';
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

            // Auto-fill project name from folder name if field is empty
            const projectName = document.getElementById('modal-project-name');
            if (!projectName.value) {
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
            name: projectName || path.basename(projectPath)
        });

        if (result.success) {
            showToast(result.message, 'success');
            closeAddProjectModal();
            loadSavedProjects();
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
            loadSavedProjects();
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
        projectItem.querySelector('.project-edit-form').style.display = 'block';
        projectItem.querySelector('.project-edit-controls').style.display = 'flex';
    }
};

// The VS Code SVG icon as a string
const vscodeSvgIcon = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 100 100"><mask id="a" width="100" height="100" x="0" y="0" mask-type="alpha" maskUnits="userSpaceOnUse"><path fill="#fff" fill-rule="evenodd" d="M70.912 99.317a6.223 6.223 0 0 0 4.96-.19l20.589-9.907A6.25 6.25 0 0 0 100 83.587V16.413a6.25 6.25 0 0 0-3.54-5.632L75.874.874a6.226 6.226 0 0 0-7.104 1.21L29.355 38.04 12.187 25.01a4.162 4.162 0 0 0-5.318.236l-5.506 5.009a4.168 4.168 0 0 0-.004 6.162L16.247 50 1.36 63.583a4.168 4.168 0 0 0 .004 6.162l5.506 5.01a4.162 4.162 0 0 0 5.318.236l17.168-13.032L68.77 97.917a6.217 6.217 0 0 0 2.143 1.4ZM75.015 27.3 45.11 50l29.906 22.701V27.3Z" clip-rule="evenodd"/></mask><g mask="url(#a)"><path fill="#0065A9" d="M96.461 10.796 75.857.876a6.23 6.23 0 0 0-7.107 1.207l-67.451 61.5a4.167 4.167 0 0 0 .004 6.162l5.51 5.009a4.167 4.167 0 0 0 5.32.236l81.228-61.62c2.725-2.067 6.639-.124 6.639 3.297v-.24a6.25 6.25 0 0 0-3.539-5.63Z"/><g filter="url(#b)"><path fill="#007ACC" d="m96.461 89.204-20.604 9.92a6.229 6.229 0 0 1-7.107-1.207l-67.451-61.5a4.167 4.167 0 0 1 .004-6.162l5.51-5.009a4.167 4.167 0 0 1 5.32-.236l81.228 61.62c2.725 2.067 6.639.124 6.639-3.297v.24a6.25 6.25 0 0 1-3.539 5.63Z"/></g><g filter="url(#c)"><path fill="#1F9CF0" d="M75.858 99.126a6.232 6.232 0 0 1-7.108-1.21c2.306 2.307 6.25.674 6.25-2.588V4.672c0-3.262-3.944-4.895-6.25-2.589a6.232 6.232 0 0 1 7.108-1.21l20.6 9.908A6.25 6.25 0 0 1 100 16.413v67.174a6.25 6.25 0 0 1-3.541 5.633l-20.601 9.906Z"/></g><path fill="url(#d)" fill-rule="evenodd" d="M70.851 99.317a6.224 6.224 0 0 0 4.96-.19L96.4 89.22a6.25 6.25 0 0 0 3.54-5.633V16.413a6.25 6.25 0 0 0-3.54-5.632L75.812.874a6.226 6.226 0 0 0-7.104 1.21L29.294 38.04 12.126 25.01a4.162 4.162 0 0 0-5.317.236l-5.507 5.009a4.168 4.168 0 0 0-.004 6.162L16.186 50 1.298 63.583a4.168 4.168 0 0 0 .004 6.162l5.507 5.009a4.162 4.162 0 0 0 5.317.236L29.294 61.96l39.414 35.958a6.218 6.218 0 0 0 2.143 1.4ZM74.954 27.3 45.048 50l29.906 22.701V27.3Z" clip-rule="evenodd" opacity=".25" style="mix-blend-mode:overlay"/></g><defs><filter id="b" width="116.727" height="92.246" x="-8.394" y="15.829" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/><feOffset/><feGaussianBlur stdDeviation="4.167"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow"/><feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter><filter id="c" width="47.917" height="116.151" x="60.417" y="-8.076" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/><feOffset/><feGaussianBlur stdDeviation="4.167"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend in2="BackgroundImageFix" mode="overlay" result="effect1_dropShadow"/><feBlend in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter><linearGradient id="d" x1="49.939" x2="49.939" y1=".258" y2="99.742" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs></svg>`;

// Load saved projects with improved inline editing
async function loadSavedProjects() {
    const projectsList = document.getElementById('projects-list');
    projectsList.innerHTML = '<p class="loading-text"><i class="fas fa-spinner fa-spin"></i> Cargando proyectos guardados...</p>';

    try {
        const result = await ipcRenderer.invoke('get-saved-projects');

        if (!result.projects || result.projects.length === 0) {
            projectsList.innerHTML = `
                <div class="empty-projects">
                    <i class="far fa-folder-open"></i>
                    <p>No hay proyectos guardados.</p>
                    <button onclick="showAddProjectModal()"><i class="fas fa-plus"></i> Añadir Proyecto</button>
                </div>
            `;
            return;
        }

        // Render projects list
        projectsList.innerHTML = '';
        result.projects.forEach(project => {
            const projectItem = document.createElement('div');
            projectItem.className = 'project-item';
            projectItem.id = `project-${project.id}`;

            // Ensure path is properly escaped for HTML attributes
            const escapedPath = project.projectPath.replace(/\\/g, '\\\\').replace(/"/g, '&quot;');

            projectItem.innerHTML = `
                <!-- Normal view mode -->
                <div class="project-info" style="display: block;">
                    <div class="project-name">
                        <i class="fas fa-project-diagram"></i> ${project.name}
                    </div>
                    <div class="project-path">
                        <i class="fas fa-folder"></i> ${project.projectPath}
                    </div>
                </div>
                
                <!-- Edit form (hidden by default) -->
                <div class="project-edit-form" style="display: none;">
                    <input type="text" class="edit-field edit-name-input" value="${project.name}" placeholder="Nombre del proyecto">
                    <div style="display: flex; margin-bottom: 8px;">
                        <input type="text" class="edit-field edit-path-input" value="${project.projectPath}" placeholder="Ruta del proyecto" style="flex: 1; margin-bottom: 0;">
                        <button onclick="selectProjectDirInline('${project.id}')" style="margin-top: 0; margin-left: 5px;"><i class="fas fa-folder-open"></i></button>
                    </div>
                </div>
                
                <!-- Normal action buttons -->
                <div class="project-actions project-normal-controls" style="display: flex;">
                    <button class="action-btn deploy-btn" onclick="deploySavedProject('${project.id}')" title="Desplegar proyecto">
                        <i class="fas fa-upload"></i>
                    </button>
                    <button class="action-btn edit-btn" onclick="toggleEditMode('${project.id}')" title="Editar proyecto">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="action-btn vscode-btn" onclick="openInVSCode('${escapedPath}')" title="Abrir en VS Code">
                        ${vscodeSvgIcon}
                    </button>
                    <button class="action-btn delete-btn" onclick="deleteProject('${project.id}')" title="Eliminar proyecto">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
                
                <!-- Edit mode action buttons -->
                <div class="project-actions project-edit-controls" style="display: none;">
                    <button class="action-btn confirm-btn" onclick="saveEditedProject('${project.id}')" title="Guardar cambios">
                        <i class="fas fa-check"></i>
                    </button>
                    <button class="action-btn cancel-edit-btn" onclick="toggleEditMode('${project.id}')" title="Cancelar edición">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
            projectsList.appendChild(projectItem);
        });
    } catch (error) {
        console.error('Error loading saved projects:', error);
        projectsList.innerHTML = `
            <div class="empty-projects">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Error al cargar proyectos: ${error.message}</p>
                <button onclick="loadSavedProjects()"><i class="fas fa-sync-alt"></i> Reintentar</button>
            </div>
        `;
    }
}

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

        // Reload projects list
        loadSavedProjects();
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

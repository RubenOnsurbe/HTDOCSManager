const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

// Clean electron-builder cache
const cachePath = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
if (fs.existsSync(cachePath)) {
    try {
        console.log('Cleaning electron-builder cache...');
        fs.removeSync(cachePath);
    } catch (err) {
        console.warn('Warning: Could not clean cache:', err.message);
    }
}

// Create a temporary package.json with minimal settings
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tempConfig = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    author: packageJson.author,
    appId: "com.yourname.htdocsmanager",
    productName: "HTDocs Manager",
    directories: {
        output: "dist"
    },
    win: {
        target: [{
            target: "nsis",
            arch: ["x64"]
        }],
        icon: "HTDocsManager.ico"
    },
    nsis: {
        oneClick: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        installerIcon: "HTDocsManager.ico",
        uninstallerIcon: "HTDocsManager.ico",
        createDesktopShortcut: true,
        createStartMenuShortcut: true
    }
};

// Write temporary config
fs.writeFileSync('temp-package.json', JSON.stringify(tempConfig, null, 2));

try {
    // Run build with simplified config
    console.log('Building installer with simplified configuration...');
    execSync('electron-builder --win --x64 --config temp-package.json', { stdio: 'inherit' });
    console.log('Build completed successfully!');
} catch (error) {
    console.error('Build failed:', error.message);
} finally {
    // Clean up
    fs.removeSync('temp-package.json');
}

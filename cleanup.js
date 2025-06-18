const fs = require('fs-extra');
const path = require('path');

// Path to electron-builder cache
const cacheDir = path.join(process.env.APPDATA, '..', 'Local', 'electron-builder', 'Cache');

console.log('Cleaning electron-builder cache...');

if (fs.existsSync(cacheDir)) {
    // Delete the winCodeSign folder specifically
    const winCodeSignDir = path.join(cacheDir, 'winCodeSign');

    if (fs.existsSync(winCodeSignDir)) {
        try {
            fs.removeSync(winCodeSignDir);
            console.log('Deleted winCodeSign cache folder');
        } catch (err) {
            console.error('Error deleting cache folder:', err.message);
        }
    }

    console.log('Cache cleanup complete');
} else {
    console.log('Cache directory not found');
}

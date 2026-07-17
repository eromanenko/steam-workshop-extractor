/**
 * fix-ext.js
 * 
 * This script scans a directory for files downloaded from Tabletop Simulator mods
 * (or Steam Workshop) and fixes their file extensions based on their actual "magic bytes"
 * (file signatures). 
 * 
 * Since Steam Workshop URLs often lack proper extensions (defaulting to .jpg), many files 
 * such as PNGs, MP3s, PDFs, OBJs, and Unity AssetBundles get saved with the wrong extension.
 * This script reads the first few bytes of each file to determine its true format and 
 * renames it automatically.
 * 
 * Usage:
 *   node fix-ext.js "C:\path\to\your\downloaded\mod\folder"
 */

const fs = require('fs');
const path = require('path');

function detectExtension(buffer, originalExt) {
  if (buffer.length < 8) return originalExt;

  // Magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return '.png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return '.jpg';
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return '.pdf'; // %PDF
  
  // MP3 (ID3)
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return '.mp3';
  
  // Unity AssetBundle
  if (buffer[0] === 0x55 && buffer[1] === 0x6E && buffer[2] === 0x69 && buffer[3] === 0x74 && buffer[4] === 0x79 && buffer[5] === 0x46 && buffer[6] === 0x53) return '.unity3d'; // UnityFS
  
  // OBJ (starts with 'v ' or 'vt ' or 'vn ' or '# ')
  const startStr = buffer.slice(0, 10).toString('utf8');
  if (startStr.startsWith('v ') || startStr.startsWith('# ') || startStr.startsWith('vt ') || startStr.startsWith('vn ') || startStr.includes('mtllib')) return '.obj';

  // OGG
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return '.ogg';

  // WAV
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return '.wav';

  return originalExt;
}

function processDirectory(dirPath) {
  const files = fs.readdirSync(dirPath);
  let renamedCount = 0;

  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) return;

    // Ignore known non-data files
    if (file === 'WorkshopUpload' || file.endsWith('.json') || file.endsWith('.bson')) return;

    try {
      const fd = fs.openSync(fullPath, 'r');
      const buffer = Buffer.alloc(10);
      fs.readSync(fd, buffer, 0, 10, 0);
      fs.closeSync(fd);

      const currentExt = path.extname(file).toLowerCase();
      const realExt = detectExtension(buffer, currentExt);

      if (realExt !== currentExt) {
        const newName = file.substring(0, file.length - currentExt.length) + realExt;
        const newFullPath = path.join(dirPath, newName);
        fs.renameSync(fullPath, newFullPath);
        console.log(`Renamed: ${file} -> ${newName}`);
        renamedCount++;
      }
    } catch (err) {
      console.error(`Error reading ${file}: ${err.message}`);
    }
  });

  console.log(`\nFinished! Renamed ${renamedCount} files.`);
}

const targetDir = process.argv[2];
if (!targetDir) {
  console.log('Usage: node fix-ext.js "C:\\path\\to\\directory"');
  process.exit(1);
}

console.log(`Scanning directory: ${targetDir}`);
processDirectory(targetDir);

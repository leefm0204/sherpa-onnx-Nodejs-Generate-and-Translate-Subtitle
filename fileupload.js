// fileupload.js - Module for handling file uploads with original names (revised)
// - fixes mojibake for non-ASCII filenames (decode latin1 -> utf8)
// - sanitizes filenames and truncates to safe byte length
// - saves uploaded file using the same (normalized) filename and OVERWRITES if exists
// - preserves existing stream-based saving and cleanup logic

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import chokidar from 'chokidar';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, 'uploads');
const downloadDir = process.env.DOWNLOAD_DIR || '/sdcard/Download';

// ensure uploads dir exists
await fs.promises.mkdir(uploadsDir, { recursive: true });

// Use disk storage for multer to reduce memory usage
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: function (req, file, cb) {
    // We'll override this in the middleware, but provide a fallback
    cb(null, file.originalname);
  }
});
const upload = multer({ storage });

/**
 * Map original base name (without ext) => uploaded info
 * e.g. "myfile" => { uploadedPath: "/.../uploads/myfile.mp4", uploadedFilename: "myfile.mp4", originalName: "原始名.mp4" }
 */
const uploadMap = new Map();

/* ---------- Helpers: encoding, sanitize, truncate ---------- */

/**
 * Convert multer originalname from latin1 -> utf8 to fix mojibake for non-ascii filenames.
 * Many browsers send UTF-8 but multer sometimes returns latin1 bytes in originalname.
 */
function fixEncoding(name) {
  if (!name || typeof name !== 'string') return name;
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

/**
 * Very small sanitize function: removes path separators, control chars, and trims.
 * Keeps Unicode chars but removes problematic characters.
 */
function sanitizeName(name) {
  if (!name) return 'file';
  // remove null bytes and control chars
  let out = name.replaceAll(/[\0-\u001F\u007F]/g, '');
  // replace path separators and other problematic chars
  out = out.replaceAll(/[\/\\<>:"|?*]/g, '_');
  // collapse repeated spaces
  out = out.replaceAll(/\s+/g, ' ').trim();
  if (out.length === 0) return 'file';
  return out;
}

/**
 * Truncate filename to ensure UTF-8 byte length <= maxBytes.
 * Keeps the extension intact.
 */
function truncateToBytes(filename, maxBytes = 200) {
  if (!filename) return filename;
  const extension = path.extname(filename);
  let base = path.basename(filename, extension);
  let candidate = base + extension;
  // quick accept
  if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate;
  // gradually trim base
  // remove characters from the end until it fits
  while (base.length > 0) {
    base = base.slice(0, -1);
    candidate = base + extension;
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate;
  }
  // fallback: use a short hashed-ish name (timestamp)
  const fallback = `file_${Date.now()}${extension}`;
  return fallback.length > 0 ? fallback : `file${extension}`;
}

/**
 * Full normalization pipeline for an uploaded filename.
 * - fix encoding
 * - sanitize
 * - truncate to safe byte length
 */
function normalizeFilename(originalName, maxBytes = 200) {
  const fixed = fixEncoding(originalName || '');
  const sanitized = sanitizeName(fixed);
  return truncateToBytes(sanitized, maxBytes);
}

/* ---------- Saving logic: keep same filename (overwrite if exists) ---------- */

/**
 * Save file buffer to uploadsDir using provided filename.
 * Overwrites existing file with the same name (as requested).
 * Returns { path, filename }.
 */
// This function is no longer used since we're using disk storage directly
// async function saveFileWithStream(buffer, filename) {
//   const finalPath = path.join(uploadsDir, filename);
// 
//   // If file exists, remove it first so we overwrite cleanly.
//   try {
//     await fs.promises.access(finalPath);
//     // file exists — remove it to overwrite
//     try {
//       await fs.promises.unlink(finalPath);
//       // proceed to write new file
//     } catch (error) {
//       // If we can't unlink, still attempt to write (may fail)
//       console.warn(`Could not unlink existing file ${finalPath}: ${error.message}`);
//     }
//   } catch {
//     // does not exist — fine
//   }
// 
//   return new Promise((resolve, reject) => {
//     const writeStream = fs.createWriteStream(finalPath, { flags: 'w' });
//     const readStream = Readable.from(buffer);
//     readStream.pipe(writeStream);
//     writeStream.on('finish', () => {
//       console.log(`File saved (overwrite mode): ${filename}`);
//       resolve({ path: finalPath, filename });
//     });
//     writeStream.on('error', (error) => {
//       console.error(`Error saving file ${filename}:`, error);
//       reject(error);
//     });
//   });
// }

/* ---------- SRT rename/move: keep behavior but ensure safe filenames ---------- */

/**
 * Move SRT to downloadDir, prefer using same name (but sanitized/truncated for safety).
 * If target exists, it will be overwritten (like uploads) to preserve "same filename" behavior.
 */
async function renameSrtToOriginal(srtPath) {
  const srtFilenameRaw = path.basename(srtPath);
  // sanitize/truncate the srt filename too (to avoid too-long names in Download)
  const safeSrtFilename = normalizeFilename(srtFilenameRaw, 200);
  const targetPath = path.join(downloadDir, safeSrtFilename);

  try {
    // Try rename (fast) then fallback to streaming copy if rename fails across devices.
    // fs.promises.rename will overwrite the destination file if it already exists.
    try {
      await fs.promises.rename(srtPath, targetPath);
    } catch {
      // fallback copy+unlink
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(srtPath);
        const ws = fs.createWriteStream(targetPath);
        rs.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        rs.on('error', reject);
      });
      try { await fs.promises.unlink(srtPath); } catch {}
    }

    console.log(`Moved SRT to Downloads: ${safeSrtFilename}`);
    return { success: true, finalPath: targetPath, finalName: safeSrtFilename };
  } catch (error) {
    console.warn(`Failed to move SRT ${srtPath}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/* ---------- Uploaded-file deletion helpers ---------- */

async function deleteUploadedFile(base) {
  const info = uploadMap.get(base);
  if (!info) {
    console.log(`No upload mapping found for base: ${base}`);
    return false;
  }

  try {
    await fs.promises.unlink(info.uploadedPath);
    console.log(`Deleted uploaded file: ${info.uploadedFilename}`);
    uploadMap.delete(base);
    // delete any other keys pointing to the same info (originalBase/uploadedBase)
    if (info.originalBase && info.originalBase !== base) uploadMap.delete(info.originalBase);
    if (info.uploadedBase && info.uploadedBase !== base) uploadMap.delete(info.uploadedBase);
    return true;
  } catch (error) {
    console.warn(`Failed to delete uploaded file ${info.uploadedPath}: ${error.message}`);
    // still remove mapping to avoid leaking it
    uploadMap.delete(base);
    if (info.originalBase) uploadMap.delete(info.originalBase);
    if (info.uploadedBase) uploadMap.delete(info.uploadedBase);
    return false;
  }
}

async function deleteUploadedFileByMatch(srtBase) {
  // Fallback: iterate through the map to find a match if direct lookup fails.
  for (const [key, info] of uploadMap.entries()) {
    if (info.uploadedBase === srtBase || info.originalBase === srtBase) {
      console.log(`Found matching file in map for SRT base: ${srtBase}`);
      return await deleteUploadedFile(key); // Use the key to delete
    }
  }
  console.log(`No matching uploaded file found in map for SRT base: ${srtBase}`);
  return false;
}

/* ---------- Combined cleanup ---------- */

async function cleanupAfterSrt(srtPath) {
  const renameResult = await renameSrtToOriginal(srtPath);
  if (!renameResult.success) {
    console.error(`Failed to move/rename SRT: ${renameResult.error}`);
    return;
  }

  const srtBase = path.basename(renameResult.finalName, '.srt');
  const deletedFromMap = await deleteUploadedFile(srtBase);
  if (!deletedFromMap) {
    await deleteUploadedFileByMatch(srtBase);
  }

  console.log(`Cleanup completed for SRT: ${renameResult.finalName}`);
}

/* ---------- Cleanup helpers for explicit cleanup ---------- */

async function cleanupUploadedFiles(filePaths) {
  if (!filePaths) {
    try {
      const uploadedFiles = await fs.promises.readdir(uploadsDir);
      for (const file of uploadedFiles) {
        const filePath = path.join(uploadsDir, file);
        try {
          await fs.promises.unlink(filePath);
          console.log(`Cleaned up uploaded file: ${file}`);
        } catch (error) {
          console.warn(`Failed to clean up ${file}: ${error.message}`);
        }
      }
      uploadMap.clear();
      console.log('All uploaded files cleaned up');
    } catch (error) {
      console.warn('Error during cleanup:', error.message);
    }
    return;
  }

  for (const filePath of filePaths) {
    try {
      if (filePath.startsWith(uploadsDir)) {
        await fs.promises.unlink(filePath);
        console.log(`Cleaned up uploaded file: ${path.basename(filePath)}`);
        const fileName = path.basename(filePath);
        const extension = path.extname(fileName);
        const base = path.basename(fileName, extension);
        uploadMap.delete(base);
      }
    } catch (error) {
      console.warn(`Failed to clean up ${filePath}: ${error.message}`);
    }
  }
}

/* ---------- Multer middleware wrapper: use normalized filename and save to disk ---------- */

function uploadSingleFile(fieldName = 'file') {
  return (request, res, next) => {
    const middleware = upload.single(fieldName);
    middleware(request, res, async (error) => {
      if (error) {
        console.error('Upload middleware error:', error);
        return next(error);
      }

      // For disk storage, the file is already saved, but we need to rename it to our normalized name
      if (request.file && request.file.path) {
        try {
          // Normalize original filename (fix encoding, sanitize, truncate)
          const safeName = normalizeFilename(request.file.originalname, 200);
          
          // Rename the file to our normalized name
          const newPath = path.join(uploadsDir, safeName);
          
          // Only rename if the paths are different
          if (request.file.path !== newPath) {
            // Rename the temporary file to our normalized name. This will overwrite if the file exists.
            await fs.promises.rename(request.file.path, newPath);
          }

          // Update req.file to match our normalized format
          request.file = {
            ...request.file,
            path: newPath,
            filename: safeName,
            destination: uploadsDir,
            originalname: fixEncoding(request.file.originalname) // keep coherent original name (decoded)
          };

          // Track uploaded file in map using base derived from saved filename
          const extension = path.extname(request.file.filename);
          const uploadedBase = path.basename(request.file.filename, extension);
          const originalBase = path.basename(request.file.originalname || request.file.filename, extension);

          const info = {
            uploadedPath: request.file.path,
            uploadedFilename: request.file.filename,
            originalName: request.file.originalname, // This is already fixed
            originalBase,
            uploadedBase,
            uploadedAt: Date.now()
          };

          // Store under both keys for robust lookup
          uploadMap.set(uploadedBase, info);
          if (originalBase !== uploadedBase) uploadMap.set(originalBase, info);

          console.log(`Tracked uploaded file: ${request.file.filename} (original: ${request.file.originalname}, uploadedBase=${uploadedBase}, originalBase=${originalBase})`);
        } catch (error) {
          console.error('Error saving uploaded file:', error);
          return next(error);
        }
      }

      next();
    });
  };
}

/* ---------- Watcher: detect new .srt files in Downloads ---------- */
// Disabled since SRT files are now saved directly to /sdcard/Download
// function startDownloadWatcher() {
//   try {
//     const watcher = chokidar.watch(downloadDir, { ignored: /^\./, persistent: true, depth: 0 });
// 
//     watcher.on('add', async (filePath) => {
//       const file = path.basename(filePath);
//       if (!file.toLowerCase().endsWith('.srt')) return;
//       console.log(`Detected new .srt: ${file}`);
//       await cleanupAfterSrt(filePath);
//     });
// 
//     watcher.on('error', (error) => {
//       console.error('Watcher error:', error);
//     });
// 
//     console.log(`Watching ${downloadDir} for new .srt files...`);
//   } catch (error) {
//     console.error('Failed to start watcher — check permissions and that path exists:', error.message);
//   }
// }
// startDownloadWatcher();

/* ---------- Exports ---------- */

export {
  uploadSingleFile,
  cleanupUploadedFiles,
  cleanupAfterSrt,
  deleteUploadedFile,
  deleteUploadedFileByMatch,
  renameSrtToOriginal,
  uploadMap,
  uploadsDir,
  downloadDir
};

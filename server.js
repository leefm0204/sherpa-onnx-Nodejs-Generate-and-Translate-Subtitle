// server.js
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { WebSocketServer } from 'ws';

import { uploadSingleFile, cleanupUploadedFiles } from './fileupload.js';
import { getCachedSystemInfo } from './cache-optimization.js';

// Enable explicit garbage collection
if (global.gc) {
  console.log('Garbage collection is enabled');
} else {
  console.warn('Garbage collection is not enabled. Start with --expose-gc flag for better memory management');
}

// active process refs - changed to support multiple processes
let activeTranscriptionProcesses = new Map(); // Map to track multiple processes
let activeTranslationProcess = null;

// Track uploaded files for cleanup and to determine SRT output location
let uploadedFiles = new Set();

// cancel flags to stop whole batch processing
let cancelTranscription = false;
let cancelTranslation = false;

// global cancel flags to stop all processes
let cancelAllTranscription = false;
let cancelAllTranslation = false;

// __dirname helper for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.static('.'));
app.use(express.json());

// File upload endpoint
app.post('/api/upload', uploadSingleFile('file'), async (request, res) => {
  if (!request.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    // Track uploaded file for cleanup
    uploadedFiles.add(request.file.path);
    console.log('File uploaded:', request.file);
    
    // Immediately start transcription for the uploaded file
    const filePath = request.file.path;
    const filename = request.file.originalname || path.basename(filePath);
    
    // Add file to transcription state
    transcriptionState.filesList.push({ name: filename, status: 'pending' });
    broadcast({ type: 'state_update', state: transcriptionState });
    broadcast({ type: 'files_detected', files: [filename] });
    
    res.json({ 
      message: 'File uploaded successfully. Transcription started.',
      filePath: filePath 
    });
    
    // Start transcription process
    setTimeout(async () => {
      try {
        // Mark processing
        const index = transcriptionState.filesList.findIndex(x => x.name === filename);
        if (index !== -1) {
          transcriptionState.filesList[index].status = 'processing';
          broadcast({ type: 'state_update', state: transcriptionState });
        }
        
        broadcast({ type: 'file_start', filename });
        logMemoryUsage(`Starting transcription for ${filename}`);
        
        const transcriberPath = path.join(__dirname, 'gensrt.js');
        // This is an uploaded file
        // Get the current concurrency setting from the UI
        const concurrency = transcriptionState.currentConcurrency || 1;
        const transcriberArguments = [transcriberPath, filePath, '--model', 'senseVoice'];
        
        const transcriber = spawnDetached('node', transcriberArguments, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
          }
        });
        
        console.log('Spawned transcriber pid=', transcriber.pid);
        activeTranscriptionProcesses.set(transcriber.pid, transcriber);
        
        // capture stdout/stderr
        const startTime = Date.now();
        let lastProgress = -1;
        
        // Add error event listener to prevent process crashes
        transcriber.on('error', (error) => {
          console.error('Transcriber process error for', filename, error);
          const index_ = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (index_ !== -1) transcriptionState.filesList[index_].status = 'error';
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${error.message}` });
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
        });
        
        if (transcriber.stdout) {
          transcriber.stdout.on('data', (chunk) => {
            const s = chunk.toString();
            broadcast({ type: 'debug_output', output: s });
            
            if (s.includes('Progress:')) {
              const m = s.match(/Progress:\s*(\d+)%.*?(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)[sS]/);
              if (m) {
                const progress = Number(m[1]);
                const processed = Number(m[2]);
                const total = Number(m[3]);
                if (progress !== lastProgress) {
                  lastProgress = progress;
                  const elapsed = (Date.now() - startTime) / 1000;
                  const speed = elapsed > 0 ? processed / elapsed : 0;
                  const remaining = speed > 0 ? (total - processed) / speed : 0;
                  broadcast({ type: 'transcription_progress', filename, progress, processed, duration: total, elapsed, remaining, speed });
                }
              }
            }
          });
          
          // Handle stdout error events
          transcriber.stdout.on('error', (error) => {
            console.error('Transcriber stdout error for', filename, error);
          });
        }
        
        if (transcriber.stderr) {
          transcriber.stderr.on('data', (chunk) => {
            broadcast({ type: 'debug_output', output: chunk.toString() });
          });
          
          // Handle stderr error events
          transcriber.stderr.on('error', (error) => {
            console.error('Transcriber stderr error for', filename, error);
          });
        }
        
        // wait for completion
        transcriber.on('close', (code, signal) => {
          console.log(`Transcriber closed for ${filename} code=${code} signal=${signal}`);
          const index = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (code === 0) {
            if (index !== -1) transcriptionState.filesList[index].status = 'completed';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_complete', filename, srtPath: path.join('/sdcard/Download', path.basename(filePath).replace(/\.[^/.]+$/, ".srt")) });
          } else {
            if (index !== -1) transcriptionState.filesList[index].status = 'error';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_error', filename, error: `Transcription failed with code ${code} signal ${signal}` });
          }
          // Clear active process reference only after it truly closed
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
          
          // Clean up uploaded file after transcription completes
          if (uploadedFiles.has(filePath)) {
            uploadedFiles.delete(filePath);
            // Call cleanup function to delete the actual file
            cleanupUploadedFiles([filePath]).catch(error => {
              console.warn(`Failed to clean up uploaded file ${filePath}:`, error.message);
            });
          }
        });
        
        transcriber.on('error', (error) => {
          console.error('Transcriber start error for', filename, error);
          const index_ = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (index_ !== -1) transcriptionState.filesList[index_].status = 'error';
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${error.message}` });
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
        });
      } catch (error) {
        console.error('Error starting transcription for uploaded file:', error);
        const index = transcriptionState.filesList.findIndex(x => x.name === filename);
        if (index !== -1) transcriptionState.filesList[index].status = 'error';
        broadcast({ type: 'state_update', state: transcriptionState });
        broadcast({ type: 'file_error', filename, error: `Failed to start transcription: ${error.message}` });
      }
    }, 100); // Small delay to ensure response is sent first
  } catch (error) {
    console.error('Error processing uploaded file:', error);
    res.status(500).json({ error: 'Failed to process uploaded file' });
  }
});

// SRT file upload endpoint for translation
app.post('/api/upload-srt', uploadSingleFile('file'), async (request, res) => {
  if (!request.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  // Check if file is SRT
  if (!request.file.originalname.toLowerCase().endsWith('.srt')) {
    return res.status(400).json({ error: 'Only SRT files are allowed for translation' });
  }
  
  try {
    // Track uploaded file for cleanup
    uploadedFiles.add(request.file.path);
    console.log('SRT file uploaded:', request.file);
    
    // Immediately start translation for the uploaded SRT file
    const filePath = request.file.path;
    const filename = request.file.originalname || path.basename(filePath);
    
    // Add file to translation state
    translationState.translationQueue.push({ filename: filename, status: 'pending' });
    broadcast({ type: 'translation_state', state: translationState });
    
    res.json({ 
      message: 'SRT file uploaded successfully. Translation started.',
      filePath: filePath 
    });
    
    // Start translation process
    setTimeout(async () => {
      try {
        // Mark processing
        const index = translationState.translationQueue.findIndex(x => x.filename === filename);
        if (index !== -1) {
          translationState.translationQueue[index].status = 'processing';
          broadcast({ type: 'translation_state', state: translationState });
        }
        
        broadcast({ type: 'translation_start', filename });
        logMemoryUsage(`Starting translation for ${filename}`);
        
        const translatorPath = path.join(__dirname, 'srt-gtk.js');
        console.log(`Starting translator for ${filename}`);
        const translator = spawnDetached('node', [translatorPath, filePath, 'auto', 'en'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
          }
        });
        
        console.log('Spawned translator pid=', translator.pid);
        activeTranslationProcess = translator;
        
        if (translator.stdout) translator.stdout.on('data', d => broadcast({ type: 'debug_output', output: d.toString() }));
        if (translator.stderr) translator.stderr.on('data', d => broadcast({ type: 'debug_output', output: d.toString() }));
        
        translator.on('close', (code, signal) => {
          console.log(`Translator closed for ${filename} code=${code} signal=${signal}`);
          const index = translationState.translationQueue.findIndex(x => x.filename === filename);
          if (code === 0) {
            if (index !== -1) translationState.translationQueue[index].status = 'completed';
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_complete', filename, outPath: filePath.replace(/\.srt$/i, `-en.srt`) });
          } else {
            if (index !== -1) translationState.translationQueue[index].status = 'error';
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_error', filename, error: `Translation failed with code ${code} signal ${signal}` });
          }
          if (activeTranslationProcess && activeTranslationProcess.pid === translator.pid) {
            activeTranslationProcess = null;
          }
          
          // Remove uploaded file from tracking
          if (uploadedFiles.has(filePath)) {
            uploadedFiles.delete(filePath);
          }
        });
        
        translator.on('error', (error) => {
          console.error('Translation process error for', filename, error);
          const index_ = translationState.translationQueue.findIndex(x => x.filename === filename);
          if (index_ !== -1) translationState.translationQueue[index_].status = 'error';
          broadcast({ type: 'translation_state', state: translationState });
          broadcast({ type: 'translation_error', filename, error: `Failed to start translator: ${error.message}` });
          if (activeTranslationProcess && activeTranslationProcess.pid === translator.pid) {
            activeTranslationProcess = null;
          }
          
          // Remove uploaded file from tracking
          if (uploadedFiles.has(filePath)) {
            uploadedFiles.delete(filePath);
          }
        });
      } catch (error) {
        console.error('Error starting translation for uploaded SRT file:', error);
        const index = translationState.translationQueue.findIndex(x => x.filename === filename);
        if (index !== -1) translationState.translationQueue[index].status = 'error';
        broadcast({ type: 'translation_state', state: translationState });
        broadcast({ type: 'translation_error', filename, error: `Failed to start translation: ${error.message}` });
      }
    }, 100); // Small delay to ensure response is sent first
  } catch (error) {
    console.error('Error processing uploaded SRT file:', error);
    res.status(500).json({ error: 'Failed to process uploaded SRT file' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  logMemoryUsage('Server started');
});
const wss = new WebSocketServer({ server });

// ---- in-memory state ----
let transcriptionState = { filesList: [], currentConcurrency: 1 };          // { name, status: 'pending'|'processing'|'completed'|'error' }
let translationState = { translationQueue: [] };     // { filename, status: 'queued'|'processing'|'completed'|'error' }

// ---- helpers ----
function broadcast(object) {
  const payload = JSON.stringify(object);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

/**
 * Spawn a process detached into its own process group so we can kill the whole tree later.
 * stdio is ['ignore','pipe','pipe'] so we still capture stdout/stderr.
 */
function spawnDetached(command, arguments_ = [], options = {}) {
  const spawnOptions = {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  };

  const child = spawn(command, arguments_, spawnOptions);
  // Do NOT unref() here — keep child's lifetime tied to server so we can manage it and capture output.
  return child;
}

/** * Try to kill a process tree reliably on POSIX and Windows.
 * - proc must be a ChildProcess with a valid pid.
 * - returns true if kill was initiated, false if nothing to kill.
 */
function tryKillProcessTree(proc) {
  if (!proc || !proc.pid) {
    return false;
  }
  const pid = proc.pid;
  console.log(`Attempting to kill process tree for pid=${pid} (platform=${process.platform})`);

  if (process.platform === 'win32') {
    // On Windows use taskkill to kill the PID tree
    try {
      // spawn detached so taskkill runs independently
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { detached: true, stdio: 'ignore', shell: false }).unref();
      return true;
    } catch (error) {
      console.error('taskkill failed:', error);
      try {
        proc.kill('SIGKILL');
        return true;
      } catch (error) {
        console.error('Fallback kill failed:', error);
        return false;
      }
    }
  }

  // POSIX: kill the process group by sending signal to -pid
  try {
    // First try graceful termination of the entire process group
    process.kill(-pid, 'SIGTERM');
  } catch {
    // If group kill fails, try single pid
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // nothing else we can do
    }
  }

  // escalate to SIGKILL after short timeout if processes still exist
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // nothing else we can do
      }
    }
  }, 2000);

  return true;
}

/**
 * Log memory usage for monitoring purposes
 */
function logMemoryUsage(label) {
  if (process.env.NODE_ENV === 'development') {
    const used = process.memoryUsage();
    const usage = {
      rss: Math.round(used.rss / 1024 / 1024 * 100) / 100, // MB
      heapTotal: Math.round(used.heapTotal / 1024 / 1024 * 100) / 100, // MB
      heapUsed: Math.round(used.heapUsed / 1024 / 1024 * 100) / 100, // MB
      external: Math.round(used.external / 1024 / 1024 * 100) / 100 // MB
    };
    console.log(`${label} - Memory Usage:`, usage);
  }
}

// ---- language.json endpoint ----
app.get('/language.json', async (request, res) => {
  try {
    const data = await fs.readFile(path.join(__dirname, 'language.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.status(500).json({ error: 'Failed to load languages' });
  }
});

// -------------------- Transcription endpoint --------------------
app.post('/api/start', async (request, res) => {
  console.log('Transcription endpoint called with:', request.body);
  const { inputPath, model = 'senseVoice', concurrency = 1 } = request.body;

  const validModels = ['senseVoice', 'transducer'];
  if (!inputPath) return res.status(400).json({ error: 'File path is required' });
  if (!validModels.includes(model)) return res.status(400).json({ error: `Invalid model: ${validModels.join(', ')}` });

  try {
    const stats = await fs.stat(inputPath);
    const audioExtension = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.mp4', '.mkv', '.mov', '.avi', '.webm']);
    let files = [];

    if (stats.isDirectory()) {
      const all = await fs.readdir(inputPath);
      files = all.filter(f => audioExtension.has(path.extname(f).toLowerCase())).map(f => path.join(inputPath, f));
    } else if (stats.isFile()) {
      if (!audioExtension.has(path.extname(inputPath).toLowerCase())) {
        return res.status(400).json({ error: 'Not a supported audio/video file' });
      }
      files = [inputPath];
    } else {
      return res.status(400).json({ error: 'Path is neither file nor directory' });
    }

    transcriptionState.filesList = files.map(f => ({ name: path.basename(f), status: 'pending' }));
    // Store current concurrency setting for uploaded files
    transcriptionState.currentConcurrency = concurrency;
    // Reset cancellation flags when starting new transcription
    cancelAllTranscription = false;
    cancelTranscription = false;
    broadcast({ type: 'state_update', state: transcriptionState });
    broadcast({ type: 'files_detected', files: transcriptionState.filesList.map(x => x.name) });

    // Process all files sequentially (original behavior)
    for (const file of files) {
      // Check if all transcription should be cancelled
      if (cancelAllTranscription) {
        // Mark remaining files as cancelled
        for (const f of transcriptionState.filesList) {
          if (f.status === 'pending') {
            f.status = 'error';
          }
        }
        broadcast({ type: 'state_update', state: transcriptionState });
        broadcast({ type: 'file_error', filename: 'process', error: 'Transcription manually stopped by user' });
        break;
      }

      const filename = path.basename(file);

      // If user cleared the list mid-run, skip files not found in state
      if (!transcriptionState.filesList.find(x => x.name === filename)) {
        console.log(`Skipping ${filename} (removed from list)`);
        continue;
      }

      // mark processing
      const index = transcriptionState.filesList.findIndex(x => x.name === filename);
      if (index !== -1) {
        transcriptionState.filesList[index].status = 'processing';
        broadcast({ type: 'state_update', state: transcriptionState });
      }

      broadcast({ type: 'file_start', filename });

      const transcriberPath = path.join(__dirname, 'gensrt.js');
      // Check if this is an uploaded file
      const isUploadedFile = uploadedFiles.has(file);
      const transcriberArguments = [transcriberPath, file, '--model', model];
      
      const transcriber = spawnDetached('node', transcriberArguments, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
        }
      });

      console.log('Spawned transcriber pid=', transcriber.pid);
      activeTranscriptionProcesses.set(transcriber.pid, transcriber);

      // capture stdout/stderr
      const startTime = Date.now();
      
      // Add error event listener to prevent process crashes
      transcriber.on('error', (error) => {
        console.error('Transcriber process error for', filename, error);
        const index = transcriptionState.filesList.findIndex(x => x.name === filename);
        if (index !== -1) transcriptionState.filesList[index].status = 'error';
        broadcast({ type: 'state_update', state: transcriptionState });
        broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${error.message}` });
        if (activeTranscriptionProcesses.has(transcriber.pid)) {
          activeTranscriptionProcesses.delete(transcriber.pid);
        }
      });
      
      if (transcriber.stdout) {
        let lastProgress = -1;
        transcriber.stdout.on('data', (chunk) => {
          const s = chunk.toString();
          broadcast({ type: 'debug_output', output: s });

          if (s.includes('Progress:')) {
            const m = s.match(/Progress:\s*(\d+)%.*?(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)[sS]/);
            if (m) {
              const progress = Number(m[1]);
              const processed = Number(m[2]);
              const total = Number(m[3]);
              if (progress !== lastProgress) {
                lastProgress = progress;
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = elapsed > 0 ? processed / elapsed : 0;
                const remaining = speed > 0 ? (total - processed) / speed : 0;
                broadcast({ type: 'transcription_progress', filename, progress, processed, duration: total, elapsed, remaining, speed });
                
                // Periodic garbage collection during long processes
                if (progress % 10 === 0 && global.gc) {
                  global.gc();
                }
              }
            }
          }
        });
        
        // Handle stdout error events
        transcriber.stdout.on('error', (error) => {
          console.error('Transcriber stdout error for', filename, error);
        });
      }
      
      if (transcriber.stderr) {
        transcriber.stderr.on('data', (chunk) => {
          broadcast({ type: 'debug_output', output: chunk.toString() });
        });
        
        // Handle stderr error events
        transcriber.stderr.on('error', (error) => {
          console.error('Transcriber stderr error for', filename, error);
        });
      }

      // wait for completion
      await new Promise((resolve) => {
        const handleClose = (code, signal) => {
          console.log(`Transcriber closed for ${filename} code=${code} signal=${signal}`);
          const index = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (code === 0) {
            if (index !== -1) transcriptionState.filesList[index].status = 'completed';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_complete', filename, srtPath: path.join('/sdcard/Download', path.basename(file).replace(/\.[^/.]+$/, ".srt")) });
            logMemoryUsage(`Completed transcription for ${filename}`);
          } else {
            if (index !== -1) transcriptionState.filesList[index].status = 'error';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_error', filename, error: `Transcription failed with code ${code} signal ${signal}` });
          }
          // Clear active process reference only after it truly closed
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
          
          // If this was an uploaded file, clean it up after transcription completes
          if (isUploadedFile && uploadedFiles.has(file)) {
            uploadedFiles.delete(file);
            // Call cleanup function to delete the actual file
            cleanupUploadedFiles([file]).catch(error => {
              console.warn(`Failed to clean up uploaded file ${file}:`, error.message);
            });
          }
          
          // Explicitly remove listeners to prevent memory leaks
          transcriber.removeListener('close', handleClose);
          transcriber.removeListener('error', handleError);
          
          resolve();
        };

        const handleError = (error) => {
          console.error('Transcriber start error for', filename, error);
          const index_ = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (index_ !== -1) transcriptionState.filesList[index_].status = 'error';
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${error.message}` });
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
          
          // Explicitly remove listeners to prevent memory leaks
          transcriber.removeListener('close', handleClose);
          transcriber.removeListener('error', handleError);
          
          resolve();
        };

        transcriber.on('close', handleClose);
        transcriber.on('error', handleError);
      });
    }

    // Clean up uploaded files after transcription completes
    cleanupUploadedFilesHandler();
    
    broadcast({ type: 'all_complete', totalTime: 0 });
    res.json({ success: true, message: 'Transcription process started successfully' });
  } catch (error) {
    console.error('Failed to start transcription:', error);
    broadcast({ type: 'error', message: `Failed to start transcription: ${error.message}` });
    res.status(500).json({ success: false, error: `Failed to start transcription: ${error.message}` });
  }
});



// -------------------- Translation endpoint --------------------
app.post('/api/translate', async (request, res) => {
  const { srtPath, sourceLang, targetLang } = request.body;
  if (!srtPath || !sourceLang || !targetLang) return res.status(400).json({ error: 'SRT path, source language, and target language are required' });

  try {
    const stats = await fs.stat(srtPath);
    let files = [];
    if (stats.isDirectory()) {
      const all = await fs.readdir(srtPath);
      files = all.filter(f => path.extname(f).toLowerCase() === '.srt').map(f => path.join(srtPath, f));
    } else if (stats.isFile()) {
      if (path.extname(srtPath).toLowerCase() !== '.srt') return res.status(400).json({ error: 'File is not an SRT file' });
      files = [srtPath];
    } else {
      return res.status(400).json({ error: 'Path is neither a file nor a directory' });
    }

    translationState.translationQueue = files.map(f => ({ filename: path.basename(f), status: 'queued' }));
    // Reset cancellation flags when starting new translation
    cancelAllTranslation = false;
    cancelTranslation = false;
    broadcast({ type: 'translation_state', state: translationState });

    for (const file of files) {
      // Check if all translation should be cancelled
      if (cancelAllTranslation) {
        // Mark remaining files as cancelled
        for (const f of translationState.translationQueue) {
          if (f.status === 'queued') {
            f.status = 'error';
          }
        }
        broadcast({ type: 'translation_state', state: translationState });
        broadcast({ type: 'translation_error', filename: 'translation', error: 'Translation manually stopped by user' });
        break;
      }

      const filename = path.basename(file);

      // skip if cleared mid-run
      if (!translationState.translationQueue.find(x => x.filename === filename)) {
        console.log(`Skipping translation ${filename} (removed from queue)`);
        continue;
      }

      const index = translationState.translationQueue.findIndex(x => x.filename === filename);
      if (index !== -1) {
        translationState.translationQueue[index].status = 'processing';
        broadcast({ type: 'translation_state', state: translationState });
      }

      broadcast({ type: 'translation_start', filename });

      const translatorPath = path.join(__dirname, 'srt-gtk.js');
      console.log(`Starting translator for ${filename}`);
      const translator = spawnDetached('node', [translatorPath, file, sourceLang, targetLang], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
        }
      });

      console.log('Spawned translator pid=', translator.pid);
      activeTranslationProcess = translator;

      if (translator.stdout) {
        let progressCounter = 0;
        translator.stdout.on('data', (d) => {
          broadcast({ type: 'debug_output', output: d.toString() });
          
          // Periodic garbage collection during translation
          progressCounter++;
          if (progressCounter % 50 === 0 && global.gc) {
            global.gc();
          }
        });
      }
      if (translator.stderr) translator.stderr.on('data', d => broadcast({ type: 'debug_output', output: d.toString() }));

      await new Promise((resolve) => {
        const handleClose = (code, signal) => {
          console.log(`Translator closed for ${filename} code=${code} signal=${signal}`);
          const index = translationState.translationQueue.findIndex(x => x.filename === filename);
          if (code === 0) {
            if (index !== -1) translationState.translationQueue[index].status = 'completed';
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_complete', filename, outPath: file.replace(/\.srt$/i, `-${targetLang}.srt`) });
            logMemoryUsage(`Completed translation for ${filename}`);
          } else {
            if (index !== -1) translationState.translationQueue[index].status = 'error';
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_error', filename, error: `Translation failed with code ${code} signal ${signal}` });
          }
          if (activeTranslationProcess && activeTranslationProcess.pid === translator.pid) {
            activeTranslationProcess = null;
          }
          
          // Explicitly remove listeners to prevent memory leaks
          translator.removeListener('close', handleClose);
          translator.removeListener('error', handleError);
          
          resolve();
        };

        const handleError = (error) => {
          console.error('Translation process error for', filename, error);
          const index_ = translationState.translationQueue.findIndex(x => x.filename === filename);
          if (index_ !== -1) translationState.translationQueue[index_].status = 'error';
          broadcast({ type: 'translation_state', state: translationState });
          broadcast({ type: 'translation_error', filename, error: `Failed to start translator: ${error.message}` });
          if (activeTranslationProcess && activeTranslationProcess.pid === translator.pid) {
            activeTranslationProcess = null;
          }
          
          // Explicitly remove listeners to prevent memory leaks
          translator.removeListener('close', handleClose);
          translator.removeListener('error', handleError);
          
          resolve();
        };

        translator.on('close', handleClose);
        translator.on('error', handleError);
      });
    }

    res.json({ success: true, message: 'Translation started successfully' });
  } catch (error) {
    console.error('Failed to start translation:', error);
    broadcast({ type: 'error', message: `Failed to start translation: ${error.message}` });
    res.status(500).json({ success: false, error: `Failed to start translation: ${error.message}` });
  }
});

// Function to clean up uploaded files
async function cleanupUploadedFilesHandler() {
  await cleanupUploadedFiles(uploadedFiles);
  // Clear the set after cleanup
  uploadedFiles.clear();
}

// -------------------- system-info --------------------
app.get('/system-info', async (request, res) => {
  try {
    const systemInfo = await getCachedSystemInfo();
    
    // Add Node.js memory usage information
    const memoryUsage = process.memoryUsage();
    
    res.json({
      ram: systemInfo.ram,
      swap: systemInfo.swap,
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        external: Math.round(memoryUsage.external / 1024 / 1024) // MB
      }
    });
  } catch {
    res.status(500).json({ error: 'Failed to get system info' });
  }
});

// -------------------- WebSocket control handlers --------------------
wss.on('connection', ws => {
  console.log('WS client connected');
  // send initial states
  ws.send(JSON.stringify({ type: 'state_update', state: transcriptionState }));
  ws.send(JSON.stringify({ type: 'translation_state', state: translationState }));

  ws.on('message', raw => {
    try {
      const data = JSON.parse(raw.toString());

      // STOP transcription: kill process tree and set flag to stop all future processing
      switch (data.type) {
      case 'stop_process': {
        console.log('WS: stop_process received. activeTranscriptionProcesses size=', activeTranscriptionProcesses.size);
        // Set the global cancellation flag
        cancelAllTranscription = true;
        
        // Kill all active processes
        let killedCount = 0;
        for (const [pid, process] of activeTranscriptionProcesses) {
          const ok = tryKillProcessTree(process);
          if (ok) killedCount++;
        }
        
        if (killedCount > 0) {
          ws.send(JSON.stringify({ type: 'info', message: `Stopping ${killedCount} transcription process(es)...` }));
          // mark processing items as error (but do not clear the list)
          for (const f of transcriptionState.filesList) { if (f.status === 'processing') f.status = 'error'; }
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename: 'process', error: 'Transcription manually stopped by user' });
        } else {
          ws.send(JSON.stringify({ type: 'info', message: 'No active transcription process to stop' }));
        }
        
        // Clear the map of active processes
        activeTranscriptionProcesses.clear();
      
      break;
      }
      case 'stop_translation': {
        console.log('WS: stop_translation received. activeTranslationProcess pid=', activeTranslationProcess && activeTranslationProcess.pid);
        // Set the global cancellation flag
        cancelAllTranslation = true;
        
        // Kill the active process if it exists
        let killed = false;
        if (activeTranslationProcess) {
          const ok = tryKillProcessTree(activeTranslationProcess);
          ws.send(JSON.stringify({ type: 'info', message: ok ? 'Stopping translation process...' : 'Failed to stop translation' }));
          if (ok) {
            for (const index of translationState.translationQueue) { if (index.status === 'processing') index.status = 'error'; }
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_error', filename: 'translation', error: 'Translation manually stopped by user' });
            killed = true;
          }
        } else {
          ws.send(JSON.stringify({ type: 'info', message: 'No active translation process to stop' }));
        }
        
        // If we didn't kill an active process but there are queued files, mark them as cancelled
        if (!killed) {
          for (const index of translationState.translationQueue) { 
            if (index.status === 'queued') index.status = 'error'; 
          }
          broadcast({ type: 'translation_state', state: translationState });
          broadcast({ type: 'translation_error', filename: 'translation', error: 'Translation manually stopped by user' });
        }
      
      break;
      }
      case 'clear_translation': {
        console.log('WS: clear_translation received');
        translationState.translationQueue = [];
        // Reset cancellation flags when clearing
        cancelAllTranslation = false;
        cancelTranslation = false;
        broadcast({ type: 'info', message: 'Translation queue cleared' });
        broadcast({ type: 'translation_state', state: translationState });
      
      break;
      }
      case 'clear_files': 
      case 'clear_file_list': {
        console.log('WS: clear_files received');
        transcriptionState.filesList = [];
        // Reset cancellation flags when clearing
        cancelAllTranscription = false;
        cancelTranscription = false;
        broadcast({ type: 'info', message: 'File list cleared' });
        broadcast({ type: 'state_update', state: transcriptionState });
      
      break;
      }
      case 'request_state': 
      case 'query_status': {
        // Reset cancellation flags when requesting new state (new transcription/translation starting)
        cancelAllTranscription = false;
        cancelAllTranslation = false;
        
        ws.send(JSON.stringify({
          type: 'status',
          transcription: { 
            running: activeTranscriptionProcesses.size > 0, 
            processCount: activeTranscriptionProcesses.size,
            pids: [...activeTranscriptionProcesses.keys()]
          },
          translation: { running: !!activeTranslationProcess, pid: activeTranslationProcess && activeTranslationProcess.pid }
        }));
        // also send full states
        ws.send(JSON.stringify({ type: 'state_update', state: transcriptionState }));
        ws.send(JSON.stringify({ type: 'translation_state', state: translationState }));
      
      break;
      }
      default: {
        // unrecognized control type
        console.log('WS: unknown message type', data.type);
      }
      }
    } catch (error) {
      console.error('WS parse error', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid WS message' }));
    }
  });

  ws.on('close', () => console.log('WS client disconnected'));
});

// server.js
import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

// active process refs - changed to support multiple processes
let activeTranscriptionProcesses = new Map(); // Map to track multiple processes
let activeTranslationProcess = null;

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

const server = app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
const wss = new WebSocketServer({ server });

// ---- in-memory state ----
let transcriptionState = { filesList: [] };          // { name, status: 'pending'|'processing'|'completed'|'error' }
let translationState = { translationQueue: [] };     // { filename, status: 'queued'|'processing'|'completed'|'error' }

// ---- helpers ----
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}

/**
 * Spawn a process detached into its own process group so we can kill the whole tree later.
 * stdio is ['ignore','pipe','pipe'] so we still capture stdout/stderr.
 */
function spawnDetached(command, args = [], opts = {}) {
  const spawnOpts = {
    ...opts,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  };

  const child = spawn(command, args, spawnOpts);
  // Do NOT unref() here — keep child's lifetime tied to server so we can manage it and capture output.
  return child;
}

/**
 * Try to kill a process tree reliably on POSIX and Windows.
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
    } catch (err) {
      console.error('taskkill failed:', err);
      try {
        proc.kill('SIGKILL');
        return true;
      } catch (e) {
        console.error('Fallback kill failed:', e);
        return false;
      }
    }
  }

  // POSIX: kill the process group by sending signal to -pid
  try {
    // First try graceful termination of the entire process group
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    // If group kill fails, try single pid
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      console.warn('Graceful kill failed:', e);
    }
  }

  // escalate to SIGKILL after short timeout if processes still exist
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        // nothing else we can do
      }
    }
  }, 2000);

  return true;
}

// ---- language.json endpoint ----
app.get('/language.json', async (req, res) => {
  try {
    const data = await fs.readFile(path.join(__dirname, 'language.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load languages' });
  }
});

// -------------------- Transcription endpoint --------------------
app.post('/api/start', async (req, res) => {
  console.log('Transcription endpoint called with:', req.body);
  const { inputPath, model = 'senseVoice', concurrency = 1 } = req.body;

  const validModels = ['senseVoice', 'transducer'];
  if (!inputPath) return res.status(400).json({ error: 'File path is required' });
  if (!validModels.includes(model)) return res.status(400).json({ error: `Invalid model: ${validModels.join(', ')}` });

  try {
    const stats = await fs.stat(inputPath);
    const audioExt = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.mp4', '.mkv', '.mov', '.avi', '.webm']);
    let files = [];

    if (stats.isDirectory()) {
      const all = await fs.readdir(inputPath);
      files = all.filter(f => audioExt.has(path.extname(f).toLowerCase())).map(f => path.join(inputPath, f));
    } else if (stats.isFile()) {
      if (!audioExt.has(path.extname(inputPath).toLowerCase())) {
        return res.status(400).json({ error: 'Not a supported audio/video file' });
      }
      files = [inputPath];
    } else {
      return res.status(400).json({ error: 'Path is neither file nor directory' });
    }

    transcriptionState.filesList = files.map(f => ({ name: path.basename(f), status: 'pending' }));
    // Reset cancellation flags when starting new transcription
    cancelAllTranscription = false;
    cancelTranscription = false;
    broadcast({ type: 'state_update', state: transcriptionState });
    broadcast({ type: 'files_detected', files: transcriptionState.filesList.map(x => x.name) });

    // Handle based on concurrency level
    if (concurrency > 1) {
      // Parallel processing
      await processFilesInParallel(files, model, concurrency);
    } else {
      // Sequential processing (original behavior)
      for (const file of files) {
        // Check if all transcription should be cancelled
        if (cancelAllTranscription) {
          // Mark remaining files as cancelled
          transcriptionState.filesList.forEach(f => {
            if (f.status === 'pending') {
              f.status = 'error';
            }
          });
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
        const idx = transcriptionState.filesList.findIndex(x => x.name === filename);
        if (idx !== -1) {
          transcriptionState.filesList[idx].status = 'processing';
          broadcast({ type: 'state_update', state: transcriptionState });
        }

        broadcast({ type: 'file_start', filename });

        const transcriberPath = path.join(__dirname, 'transcriber.js');
        const transcriber = spawnDetached('node', [transcriberPath, '--model', model, file, concurrency.toString()], {
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
        transcriber.on('error', (err) => {
          console.error('Transcriber process error for', filename, err);
          const i = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (i !== -1) transcriptionState.filesList[i].status = 'error';
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${err.message}` });
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
          transcriber.stdout.on('error', (err) => {
            console.error('Transcriber stdout error for', filename, err);
          });
        }
        
        if (transcriber.stderr) {
          transcriber.stderr.on('data', (chunk) => {
            broadcast({ type: 'debug_output', output: chunk.toString() });
          });
          
          // Handle stderr error events
          transcriber.stderr.on('error', (err) => {
            console.error('Transcriber stderr error for', filename, err);
          });
        }

        // wait for completion
        await new Promise((resolve) => {
          transcriber.on('close', (code, signal) => {
            console.log(`Transcriber closed for ${filename} code=${code} signal=${signal}`);
            const i = transcriptionState.filesList.findIndex(x => x.name === filename);
            if (code === 0) {
              if (i !== -1) transcriptionState.filesList[i].status = 'completed';
              broadcast({ type: 'state_update', state: transcriptionState });
              broadcast({ type: 'file_complete', filename, srtPath: file.replace(/\.[^/.]+$/, ".srt") });
            } else {
              if (i !== -1) transcriptionState.filesList[i].status = 'error';
              broadcast({ type: 'state_update', state: transcriptionState });
              broadcast({ type: 'file_error', filename, error: `Transcription failed with code ${code} signal ${signal}` });
            }
            // Clear active process reference only after it truly closed
            if (activeTranscriptionProcesses.has(transcriber.pid)) {
              activeTranscriptionProcesses.delete(transcriber.pid);
            }
            resolve();
          });

          transcriber.on('error', (err) => {
            console.error('Transcriber start error for', filename, err);
            const i = transcriptionState.filesList.findIndex(x => x.name === filename);
            if (i !== -1) transcriptionState.filesList[i].status = 'error';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${err.message}` });
            if (activeTranscriptionProcesses.has(transcriber.pid)) {
              activeTranscriptionProcesses.delete(transcriber.pid);
            }
            resolve();
          });
        });
      }
    }

    broadcast({ type: 'all_complete', totalTime: 0 });
    res.json({ success: true, message: 'Transcription process started successfully' });
  } catch (err) {
    console.error('Failed to start transcription:', err);
    broadcast({ type: 'error', message: `Failed to start transcription: ${err.message}` });
    res.status(500).json({ success: false, error: `Failed to start transcription: ${err.message}` });
  }
});

// Process files in parallel
async function processFilesInParallel(files, model, concurrency) {
  const transcriberPath = path.join(__dirname, 'transcriber.js');
  const maxConcurrency = Math.min(concurrency, files.length);
  
  // Process files in batches based on concurrency
  for (let i = 0; i < files.length; i += maxConcurrency) {
    const batch = files.slice(i, i + maxConcurrency);
    const promises = [];
    
    // Check for cancellation before starting each batch
    if (cancelAllTranscription) {
      // Mark remaining files as cancelled
      transcriptionState.filesList.forEach(f => {
        if (f.status === 'pending') {
          f.status = 'error';
        }
      });
      broadcast({ type: 'state_update', state: transcriptionState });
      broadcast({ type: 'file_error', filename: 'process', error: 'Transcription manually stopped by user' });
      break;
    }
    
    // Start all processes in the batch
    for (const file of batch) {
      const filename = path.basename(file);
      
      // Update UI to show file is processing
      const idx = transcriptionState.filesList.findIndex(x => x.name === filename);
      if (idx !== -1) {
        transcriptionState.filesList[idx].status = 'processing';
        broadcast({ type: 'state_update', state: transcriptionState });
        broadcast({ type: 'file_start', filename });
      }
      
      // Create promise for this process
      const promise = new Promise((resolve) => {
        const transcriber = spawnDetached('node', [transcriberPath, '--model', model, file, '1'], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LD_LIBRARY_PATH: path.join(__dirname, 'node_modules', 'sherpa-onnx-linux-arm64') + ':' + (process.env.LD_LIBRARY_PATH || '')
          }
        });

        console.log('Spawned transcriber pid=', transcriber.pid);
        activeTranscriptionProcesses.set(transcriber.pid, transcriber);
        
        const startTime = Date.now();
        let lastProgress = -1;
        
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
        }
        
        if (transcriber.stderr) {
          transcriber.stderr.on('data', (chunk) => {
            broadcast({ type: 'debug_output', output: chunk.toString() });
          });
        }
        
        transcriber.on('close', (code, signal) => {
          console.log(`Transcriber closed for ${filename} code=${code} signal=${signal}`);
          const i = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (code === 0) {
            if (i !== -1) transcriptionState.filesList[i].status = 'completed';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_complete', filename, srtPath: file.replace(/\.[^/.]+$/, ".srt") });
          } else {
            if (i !== -1) transcriptionState.filesList[i].status = 'error';
            broadcast({ type: 'state_update', state: transcriptionState });
            broadcast({ type: 'file_error', filename, error: `Transcription failed with code ${code} signal ${signal}` });
          }
          
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
          resolve();
        });
        
        transcriber.on('error', (err) => {
          console.error('Transcriber start error for', filename, err);
          const i = transcriptionState.filesList.findIndex(x => x.name === filename);
          if (i !== -1) transcriptionState.filesList[i].status = 'error';
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename, error: `Failed to start transcriber: ${err.message}` });
          
          if (activeTranscriptionProcesses.has(transcriber.pid)) {
            activeTranscriptionProcesses.delete(transcriber.pid);
          }
          resolve();
        });
      });
      
      promises.push(promise);
    }
    
    // Wait for all processes in this batch to complete
    await Promise.all(promises);
  }
}

// -------------------- Translation endpoint --------------------
app.post('/api/translate', async (req, res) => {
  const { srtPath, sourceLang, targetLang } = req.body;
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
        translationState.translationQueue.forEach(f => {
          if (f.status === 'queued') {
            f.status = 'error';
          }
        });
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

      const idx = translationState.translationQueue.findIndex(x => x.filename === filename);
      if (idx !== -1) {
        translationState.translationQueue[idx].status = 'processing';
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

      if (translator.stdout) translator.stdout.on('data', d => broadcast({ type: 'debug_output', output: d.toString() }));
      if (translator.stderr) translator.stderr.on('data', d => broadcast({ type: 'debug_output', output: d.toString() }));

      await new Promise((resolve) => {
        translator.on('close', (code, signal) => {
          console.log(`Translator closed for ${filename} code=${code} signal=${signal}`);
          const j = translationState.translationQueue.findIndex(x => x.filename === filename);
          if (code === 0) {
            if (j !== -1) translationState.translationQueue[j].status = 'completed';
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_complete', filename, outPath: file.replace(/\.srt$/i, `-${targetLang}.srt`) });
          } else {
            if (j !== -1) translationState.translationQueue[j].status = 'error';
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_error', filename, error: `Translation failed with code ${code} signal ${signal}` });
          }
          if (activeTranslationProcess && activeTranslationProcess.pid === translator.pid) {
            activeTranslationProcess = null;
          }
          resolve();
        });

        translator.on('error', (err) => {
          console.error('Translation process error for', filename, err);
          const j = translationState.translationQueue.findIndex(x => x.filename === filename);
          if (j !== -1) translationState.translationQueue[j].status = 'error';
          broadcast({ type: 'translation_state', state: translationState });
          broadcast({ type: 'translation_error', filename, error: `Failed to start translator: ${err.message}` });
          if (activeTranslationProcess && activeTranslationProcess.pid === translator.pid) {
            activeTranslationProcess = null;
          }
          resolve();
        });
      });
    }

    res.json({ success: true, message: 'Translation started successfully' });
  } catch (err) {
    console.error('Failed to start translation:', err);
    broadcast({ type: 'error', message: `Failed to start translation: ${err.message}` });
    res.status(500).json({ success: false, error: `Failed to start translation: ${err.message}` });
  }
});

// -------------------- system-info --------------------
app.get('/system-info', async (req, res) => {
  try {
    const memInfo = await fs.readFile('/proc/meminfo', 'utf8');
    const lines = memInfo.split('\n');
    const obj = {};
    lines.forEach(line => {
      const [k, v] = line.split(':');
      if (k && v) obj[k.trim()] = parseInt(v.trim().replace(' kB', ''), 10);
    });
    const ramTotal = obj['MemTotal'] || 0;
    const ramAvailable = obj['MemAvailable'] || 0;
    const ramUsed = ramTotal - ramAvailable;
    const swapTotal = obj['SwapTotal'] || 0;
    const swapFree = obj['SwapFree'] || 0;
    const swapUsed = swapTotal - swapFree;
    res.json({
      ram: { total: ramTotal, used: ramUsed, available: ramAvailable, usagePercent: ramTotal ? Math.round((ramUsed / ramTotal) * 100) : 0 },
      swap: { total: swapTotal, used: swapUsed, usagePercent: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0 }
    });
  } catch (err) {
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
      if (data.type === 'stop_process') {
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
          transcriptionState.filesList.forEach(f => { if (f.status === 'processing') f.status = 'error'; });
          broadcast({ type: 'state_update', state: transcriptionState });
          broadcast({ type: 'file_error', filename: 'process', error: 'Transcription manually stopped by user' });
        } else {
          ws.send(JSON.stringify({ type: 'info', message: 'No active transcription process to stop' }));
        }
        
        // Clear the map of active processes
        activeTranscriptionProcesses.clear();
      }

      // STOP translation: kill process tree and set flag to stop all future processing
      else if (data.type === 'stop_translation') {
        console.log('WS: stop_translation received. activeTranslationProcess pid=', activeTranslationProcess && activeTranslationProcess.pid);
        // Set the global cancellation flag
        cancelAllTranslation = true;
        
        // Kill the active process if it exists
        let killed = false;
        if (activeTranslationProcess) {
          const ok = tryKillProcessTree(activeTranslationProcess);
          ws.send(JSON.stringify({ type: 'info', message: ok ? 'Stopping translation process...' : 'Failed to stop translation' }));
          if (ok) {
            translationState.translationQueue.forEach(j => { if (j.status === 'processing') j.status = 'error'; });
            broadcast({ type: 'translation_state', state: translationState });
            broadcast({ type: 'translation_error', filename: 'translation', error: 'Translation manually stopped by user' });
            killed = true;
          }
        } else {
          ws.send(JSON.stringify({ type: 'info', message: 'No active translation process to stop' }));
        }
        
        // If we didn't kill an active process but there are queued files, mark them as cancelled
        if (!killed) {
          translationState.translationQueue.forEach(j => { 
            if (j.status === 'queued') j.status = 'error'; 
          });
          broadcast({ type: 'translation_state', state: translationState });
          broadcast({ type: 'translation_error', filename: 'translation', error: 'Translation manually stopped by user' });
        }
      }

      // CLEAR translation queue (does NOT stop active translator by default)
      else if (data.type === 'clear_translation') {
        console.log('WS: clear_translation received');
        translationState.translationQueue = [];
        // Reset cancellation flags when clearing
        cancelAllTranslation = false;
        cancelTranslation = false;
        broadcast({ type: 'info', message: 'Translation queue cleared' });
        broadcast({ type: 'translation_state', state: translationState });
      }

      // CLEAR file list (does NOT stop active transcriber by default)
      else if (data.type === 'clear_files' || data.type === 'clear_file_list') {
        console.log('WS: clear_files received');
        transcriptionState.filesList = [];
        // Reset cancellation flags when clearing
        cancelAllTranscription = false;
        cancelTranscription = false;
        broadcast({ type: 'info', message: 'File list cleared' });
        broadcast({ type: 'state_update', state: transcriptionState });
      }

      // request current status/state
      else if (data.type === 'request_state' || data.type === 'query_status') {
        // Reset cancellation flags when requesting new state (new transcription/translation starting)
        cancelAllTranscription = false;
        cancelAllTranslation = false;
        
        ws.send(JSON.stringify({
          type: 'status',
          transcription: { 
            running: activeTranscriptionProcesses.size > 0, 
            processCount: activeTranscriptionProcesses.size,
            pids: Array.from(activeTranscriptionProcesses.keys())
          },
          translation: { running: !!activeTranslationProcess, pid: activeTranslationProcess && activeTranslationProcess.pid }
        }));
        // also send full states
        ws.send(JSON.stringify({ type: 'state_update', state: transcriptionState }));
        ws.send(JSON.stringify({ type: 'translation_state', state: translationState }));
      }

      else {
        // unrecognized control type
        console.log('WS: unknown message type', data.type);
      }
    } catch (err) {
      console.error('WS parse error', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid WS message' }));
    }
  });

  ws.on('close', () => console.log('WS client disconnected'));
});

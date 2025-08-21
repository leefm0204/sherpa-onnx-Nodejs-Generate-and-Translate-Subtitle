// transcriber.js
import fs from "fs/promises";
import path from "path";
import os from "os";
import tmp from "tmp";
import { spawn } from "child_process";
import sherpa_onnx from "sherpa-onnx-node";
import cliProgress from "cli-progress";
import chalk from "chalk";
import ffmpegPathObj from "@ffmpeg-installer/ffmpeg";
import ffprobePathObj from "@ffprobe-installer/ffprobe";

const ffmpegPath = ffmpegPathObj.path;
const ffprobePath = ffprobePathObj.path;

// ---------------- CONFIG ----------------
const CFG = {
  sampleRate: 16000,
  featDim: 80,
  bufferSec: 10,  // Reduced from 30 to 10 to reduce RAM usage
  maxSegmentDur: 15,
  maxPause: 0.5,
  modelDir: "./sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
};

// ---------------- HELPERS ----------------
const AUDIO_EXT = new Set([
  ".wav", ".mp3", ".flac", ".m4a", ".ogg",
  ".mp4", ".mkv", ".mov", ".avi", ".webm"
]);

function safeFree(o) { try { o?.free?.(); } catch {} }

function formatTime(t) {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  const ms = String(Math.floor((t % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

class Segment {
  constructor(start, dur, text) {
    this.start = start;
    this.dur = dur;
    this.text = text;
  }
  get end() { return this.start + this.dur; }
  toString() {
    return `${formatTime(this.start)} --> ${formatTime(this.end)}
${this.text}`;
  }
}

function mergeSegments(segs, maxDur = CFG.maxSegmentDur, maxPause = CFG.maxPause) {
  if (!segs.length) return [];
  const out = [];
  let cur = new Segment(segs[0].start, segs[0].dur, segs[0].text);
  for (let i = 1; i < segs.length; i++) {
    const next = segs[i];
    const pause = next.start - cur.end;
    if (cur.dur + next.dur <= maxDur && pause < maxPause) {
      cur.dur = next.end - cur.start;
      cur.text += " " + next.text;
    } else {
      out.push(cur);
      cur = new Segment(next.start, next.dur, next.text);
    }
  }
  out.push(cur);
  return out;
}

async function saveSrt(segs, outFile) {
  const merged = mergeSegments(segs.sort((a, b) => a.start - b.start));
  const body = merged.map((s, i) => `${i + 1}\n${s.toString()}`).join("\n\n");
  // Use /tmp for temporary files
  const tmp = path.join('/tmp', `${path.basename(outFile)}.tmp.${Date.now()}.${process.pid}`);
  
  try {
    // ensure dir exists for output file
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    // write to temp file first
    await fs.writeFile(tmp, body, "utf8");
    // attempt to fsync the tmp file (best-effort)
    try {
      const fh = await fs.open(tmp, 'r+');
      if (typeof fh.sync === 'function') {
        fh.sync();
      }
      else if (typeof fh.datasync === 'function') {
        fh.datasync();
      }
      await fh.close();
    }
    catch (err) {
      console.warn(`[saveSrt] fsync warning for ${tmp}: ${err.message || err}`);
    }
    // Copy from /tmp to destination (instead of rename)
    const tmpContent = await fs.readFile(tmp);
    await fs.writeFile(outFile, tmpContent);
  }
  finally {
    // Ensure temp file is cleaned up even if copy fails
    try {
      await fs.unlink(tmp);
    }
    catch { }
  }
}

// ---------------- FACTORIES ----------------
import { getModel } from "./modelConfig.js";

let SELECTED_MODEL;   // will be set in main()

function createRecognizer() {
  return SELECTED_MODEL.createRecognizer(CFG);
}

function createVad() {
  // VAD file is always the same
  return new sherpa_onnx.Vad({
    sileroVad: {
      model: path.join(CFG.modelDir, "silero_vad.onnx"),
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      maxspeechduration: 5.0,
      windowSize: 512,
    },
    sampleRate: CFG.sampleRate,
    debug: false,
    numThreads: 1,
  }, CFG.bufferSec);
}
// ---------------- PROCESS ONE FILE ----------------
async function processFile(inputFile, idx, total, quiet = false) {
  const outFile = inputFile.replace(/\.[^.]+$/, ".srt");
  try {
    await fs.access(outFile);
    // Always skip files with existing SRT silently by default
    return;
  } catch {}

  if (!quiet) console.log(`
[${idx}/${total}] Processing: ${inputFile}`);

  const recognizer = createRecognizer();
  const vad = createVad();
  const buffer = new sherpa_onnx.CircularBuffer(CFG.bufferSec * CFG.sampleRate);

  return new Promise((resolve, reject) => {
    let duration = 0;
    let processed = 0;
    let startTime = 0;
    let ffmpeg = null;
    let bar = null;
    let lastProgress = 0;
    let isCancelled = false;

    const ffprobe = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputFile
    ]);
    ffprobe.stdout.on("data", d => {
      duration = parseFloat(d.toString()) || 0;
      if (duration > 0) {
        bar = new cliProgress.SingleBar({
          format: 'Progress: {percentage}% |' + chalk.yellow('{bar}') + '|  | {value}/{total}s |[{duration_formatted}<{eta_formatted}, {speed}x]',
          barCompleteChar: '\u2588',
          barIncompleteChar: '\u2591',
        });
        bar.start(Math.floor(duration), 0, { speed: "N/A" });
        startTime = Date.now();
      }
    });

    ffmpeg = spawn(ffmpegPath, [
      "-i", inputFile,
      "-f", "s16le", "-ac", "1", "-ar", String(CFG.sampleRate), "-"
    ]);
    
    // Store reference for graceful shutdown
    global.currentFfmpegProcess = ffmpeg;

    ffmpeg.stdout.on("data", data => {
      if (isCancelled) return;
      
      const samples = new Int16Array(data.buffer, data.byteOffset, data.length / 2);
      const floatSamples = Float32Array.from(samples, s => s / 32768);
      buffer.push(floatSamples);
      while (buffer.size() >= 512) {
        const frame = buffer.get(buffer.head(), 512);
        buffer.pop(512);
        vad.acceptWaveform(frame);
      }
      processed += floatSamples.length / CFG.sampleRate;
      if (bar && duration) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? processed / elapsed : 0;
        // Use Math.floor to ensure integer values without decimal points
        const progressValue = Math.floor(Math.min(processed, duration));
        bar.update(progressValue, { speed: speed.toFixed(2) });
        
        // Output progress information to stdout for the server to parse
        const progressPercent = Math.min(100, Math.floor((processed / duration) * 100));
        const barLength = 50;
        const filledLength = Math.floor((progressPercent / 100) * barLength);
        const emptyLength = barLength - filledLength;
        const progressBar = '#'.repeat(filledLength) + ' '.repeat(emptyLength);
        console.log(`Progress: ${progressPercent}% |${progressBar}| | ${processed.toFixed(1)}/${duration.toFixed(1)}s`); // Send progress to server
      }
    });

    ffmpeg.on("close", async (code) => {
      // Clean up reference
      if (global.currentFfmpegProcess === ffmpeg) {
        global.currentFfmpegProcess = null;
      }
      
      // Explicitly kill the ffmpeg process if it's still running
      try {
        if (ffmpeg && !ffmpeg.killed) {
          ffmpeg.kill('SIGKILL');
        }
      } catch (err) {
        // Ignore errors when killing the process
      }
      
      if (bar) bar.stop();
      
      if (isCancelled) {
        console.log(`
[PROGRESS] Process cancelled for ${inputFile}`);
        return reject(new Error('Process cancelled by user'));
      }
      
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }

      vad.flush();
      const segs = [];
      let flushCount = 0;
      while (!vad.isEmpty()) {
        if (isCancelled) {
          console.log(`
[PROGRESS] Process cancelled during VAD flush for ${inputFile}`);
          return reject(new Error('Process cancelled by user'));
        }
        
        flushCount++;
        if (flushCount > 100000) {
          console.error("⚠️ VAD flush infinite loop detected, breaking.");
          break;
        }
        const seg = vad.front();
        vad.pop();
        if (!seg) break;

        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples: seg.samples, sampleRate: CFG.sampleRate });
        recognizer.decode(stream);
        const { text } = recognizer.getResult(stream);
        safeFree(stream);
        if (text?.trim()) {
          segs.push(new Segment(seg.start / CFG.sampleRate, seg.samples.length / CFG.sampleRate, text.trim()));
        }
      }

      try {
        await saveSrt(segs, outFile);
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`
✓ ${chalk.green("Done!")} ${outFile}`);
        console.log(`  Segments: ${segs.length}, Audio: ${duration.toFixed(1)}s`);
        console.log(`  Time: ${elapsed.toFixed(1)}s, Speed: ${(duration / elapsed).toFixed(2)}x`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        // Explicitly clear the segments array to help with garbage collection
        segs.length = 0;
        // Note: segs is const, so we can't assign null to it
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
      }
    });

    ffmpeg.on("error", err => {
      // Clean up reference
      if (global.currentFfmpegProcess === ffmpeg) {
        global.currentFfmpegProcess = null;
      }
      
      // Explicitly kill the ffmpeg process if it's still running
      try {
        if (ffmpeg && !ffmpeg.killed) {
          ffmpeg.kill('SIGKILL');
        }
      } catch (killErr) {
        // Ignore errors when killing the process
      }
      
      if (bar) bar.stop();
      if (isCancelled) {
        console.log(`\n[PROGRESS] Process cancelled with error for ${inputFile}`);
        return reject(new Error('Process cancelled by user'));
      }
      reject(err);
    });
    
    // Handle cancellation
    const cancelHandler = () => {
      isCancelled = true;
      if (ffmpeg) {
        try {
          if (!ffmpeg.killed) {
            ffmpeg.kill('SIGKILL');
          }
        } catch (err) {
          // Ignore errors when killing the process
        }
      }
      if (bar) bar.stop();
    };
    
    // Store cancel handler
    global.cancelCurrentProcess = cancelHandler;
  });
}

// ---------------- MAIN ----------------
import minimist from "minimist";       // small helper; optional

// Process files in parallel
async function processFilesInParallel(files, concurrency) {
  const results = [];
  const pendingFiles = [...files]; // Working copy of the files array
  const activePromises = new Map(); // To track active promises

  // Initial batch
  while (pendingFiles.length > 0 && activePromises.size < concurrency) {
    const file = pendingFiles.shift();
    const index = files.indexOf(file) + 1;
    const promise = processFile(file, index, files.length)
      .then(result => {
        activePromises.delete(promise);
        return { file, result, success: true };
      })
      .catch(error => {
        activePromises.delete(promise);
        return { file, error, success: false };
      });
    
    activePromises.set(promise, file);
  }

  // Process remaining files
  while (activePromises.size > 0) {
    const completedPromise = await Promise.race(activePromises.keys());
    const result = await completedPromise;
    results.push(result);

    // Log completion
    if (result.success) {
      // Silent completion in quiet mode
    } else {
      console.error(`\n✗ Failed: ${path.basename(result.file)} - ${result.error.message}`);
    }

    // Start next file if available
    if (pendingFiles.length > 0) {
      const file = pendingFiles.shift();
      const index = files.indexOf(file) + 1;
      const promise = processFile(file, index, files.length)
        .then(result => {
          activePromises.delete(promise);
          return { file, result, success: true };
        })
        .catch(error => {
          activePromises.delete(promise);
          return { file, error, success: false };
        });
      
      activePromises.set(promise, file);
    }
  }

  return results;
}

(async () => {
  const argv = minimist(process.argv.slice(2), {
    string: ["model"],
    default: { model: "senseVoice" }
  });

  const target = argv._[0];
  const concurrency = Math.max(1, Math.min(2, parseInt(argv._[1]) || 1)); // Default to 1, max 2 (reduced from 4)
  // Quiet mode is now default behavior for skipping files with existing SRT files

  if (!target) {
    console.error("Usage: node transcriber.js [--model senseVoice|transducer] <file_or_dir> [concurrency]");
    console.error("Example: node transcriber.js --model senseVoice /path/to/files 2");
    process.exit(1);
  }

  const modelMeta = getModel(argv.model);
  SELECTED_MODEL = modelMeta;
  CFG.modelDir   = modelMeta.modelDir;

  const input = target;
  const stats = await fs.stat(input);
  let files = [];
  if (stats.isDirectory()) {
    const items = await fs.readdir(input);
    for (const f of items) {
      const full = path.join(input, f);
      if (AUDIO_EXT.has(path.extname(f).toLowerCase())) files.push(full);
    }
  } else if (AUDIO_EXT.has(path.extname(input).toLowerCase())) {
    files.push(input);
  }

  // Filter out files that already have SRT files (skip them silently)
  const filesToProcess = [];
  for (const file of files) {
    const outFile = file.replace(/\.[^.]+$/, ".srt");
    try {
      await fs.access(outFile);
      // File already has SRT, skip it silently
    } catch {
      // No SRT file exists, add to processing list
      filesToProcess.push(file);
    }
  }

  if (!filesToProcess.length) {
    console.error("No files to process (all files already have SRT).");
    process.exit(0);
  }

  console.log(`

Transcribing ${filesToProcess.length} file(s) with ${argv.model} model...`);
  console.log(`Concurrency level: ${concurrency}`);
  
  if (concurrency === 1) {
    // Sequential processing (original behavior)
    for (let i = 0; i < filesToProcess.length; i++) {
      try {
        await processFile(filesToProcess[i], i + 1, filesToProcess.length);
      } catch (err) {
        console.error(chalk.red(`Error processing ${filesToProcess[i]}:`), err.message || err);
      }
    }
    console.log(`${chalk.green("All files processed.")}`);
  } else {
    // Parallel processing
    try {
      const results = await processFilesInParallel(filesToProcess, concurrency);
      const successful = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      
      console.log(`${chalk.green("All files processed.")}`);
      console.log(`Successful: ${successful}, Failed: ${failed}`);
    } catch (err) {
      console.error(chalk.red("Error in parallel processing:"), err.message || err);
      process.exit(1);
    }
  }
})();

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Graceful shutdown function
async function gracefulShutdown(signal) {
  console.log(`\n[PROGRESS] Received ${signal}, shutting down gracefully...`);
  
  // If there's an active ffmpeg process, terminate it
  if (global.currentFfmpegProcess) {
    console.log('[PROGRESS] Terminating ffmpeg process...');
    try {
      // Use SIGKILL for more forceful termination
      global.currentFfmpegProcess.kill('SIGKILL');
    } catch (err) {
      console.error('Error terminating ffmpeg:', err.message);
    }
  }
  
  // If there's a cancel handler, call it
  if (global.cancelCurrentProcess) {
    console.log('[PROGRESS] Cancelling current process...');
    try {
      global.cancelCurrentProcess();
    } catch (err) {
      console.error('Error cancelling process:', err.message);
    }
  }
  
  console.log('[PROGRESS] Shutdown complete');
  process.exit(0);
}
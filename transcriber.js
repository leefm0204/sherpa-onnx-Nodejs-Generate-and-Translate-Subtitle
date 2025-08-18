// transcriber.js
import fs from "fs/promises";
import path from "path";
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
  bufferSec: 30,
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
    return `${formatTime(this.start)} --> ${formatTime(this.end)}\n${this.text}`;
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
  await fs.writeFile(outFile, body, "utf8");
}

// ---------------- FACTORIES ----------------
function createRecognizer() {
  return new sherpa_onnx.OfflineRecognizer({
    featConfig: { sampleRate: CFG.sampleRate, featureDim: CFG.featDim },
    modelConfig: {
      senseVoice: {
        model: `${CFG.modelDir}/model.int8.onnx`,
        useInverseTextNormalization: 1,
      },
      tokens: `${CFG.modelDir}/tokens.txt`,
      numThreads: 4,
      provider: "cpu",
      debug: false,
    },
  });
}

function createVad() {
  return new sherpa_onnx.Vad({
    sileroVad: {
      model: `${CFG.modelDir}/silero_vad.onnx`,
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
async function processFile(inputFile, idx, total) {
  const outFile = inputFile.replace(/\.[^.]+$/, ".srt");
  try {
    await fs.access(outFile);
    console.log(`[${idx}/${total}] Skipping ${inputFile} (SRT exists)`);
    return;
  } catch {}

  console.log(`\n[${idx}/${total}] Processing: ${inputFile}`);

  const recognizer = createRecognizer();
  const vad = createVad();
  const buffer = new sherpa_onnx.CircularBuffer(CFG.bufferSec * CFG.sampleRate);

  return new Promise((resolve, reject) => {
    let duration = 0;
    let processed = 0;
    let startTime = 0;
    let ffmpeg = null;
    let bar = null;

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

    ffmpeg.stdout.on("data", data => {
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
        bar.update(Math.floor(Math.min(processed, duration)), { speed: speed.toFixed(2) });
      }
    });

    ffmpeg.on("close", async (code) => {
      if (bar) bar.stop();
      if (code !== 0) return reject(new Error(`ffmpeg exited with code ${code}`));

      vad.flush();
      const segs = [];
      let flushCount = 0;
      while (!vad.isEmpty()) {
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
        console.log(`\n✓ ${chalk.green("Done!")} ${outFile}`);
        console.log(`  Segments: ${segs.length}, Audio: ${duration.toFixed(1)}s`);
        console.log(`  Time: ${elapsed.toFixed(1)}s, Speed: ${(duration / elapsed).toFixed(2)}x`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
      }
    });

    ffmpeg.on("error", err => {
      if (bar) bar.stop();
      reject(err);
    });
  });
}

// ---------------- MAIN ----------------
(async () => {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node transcriber.js <file_or_dir>");
    process.exit(1);
  }

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

  if (!files.length) {
    console.error("No supported audio/video files.");
    process.exit(1);
  }

  console.log(`\nTranscribing ${files.length} file(s)…`);
  for (let i = 0; i < files.length; i++) {
    try {
      await processFile(files[i], i + 1, files.length);
    } catch (err) {
      console.error(chalk.red(`Error processing ${files[i]}:`), err.message || err);
    }
  }
  console.log(`\n${chalk.green("All files processed.")}`);
})();

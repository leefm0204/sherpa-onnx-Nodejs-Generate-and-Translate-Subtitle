import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { Worker, isMainThread, parentPort } from 'worker_threads';
import sherpa_onnx from 'sherpa-onnx-node';
import chalk from 'chalk';
import ffmpegPathObj from '@ffmpeg-installer/ffmpeg';
import ffprobePathObj from '@ffprobe-installer/ffprobe';
const ffmpegPath = ffmpegPathObj.path;
const ffprobePath = ffprobePathObj.path;
// ---------------- CONFIG ----------------
const CFG = {
    sampleRate: 16000,
    featDim: 80,
    bufferSec: 60,
    maxSegmentDur: 15,
    maxPause: 0.5,
    modelDir: './sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    // max workers (if null => auto = cpus - 1)
    maxWorkers: 2,
};
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.mp4', '.mkv', '.mov', '.avi', '.webm']);
/**
* @description Press Your { Function safeFree } Description
* @param {any} o
* @returns {void}
*/
function safeFree(o) {
    try {
        o?.free?.();
    }
    catch { }
}
/**
* @description Press Your { Function formatTime } Description
* @param {any} t
* @returns {void}
*/
function formatTime(t) {
    const h = String(Math.floor(t / 3600)).padStart(2, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.floor((t % 1) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
}
class Segment {
    constructor(start, dur, text) {
        this.start = start;
        this.dur = dur;
        this.text = text;
    }
    get end() { return this.start + this.dur; }
    toString() { return `${formatTime(this.start)} --> ${formatTime(this.end)}\n${this.text}`; }
}
/**
* @description Press Your { Function mergeSegments } Description
* @param {any} segs
* @param {any} maxDur
* @param {any} maxPause
* @returns {void}
*/
function mergeSegments(segs, maxDur = CFG.maxSegmentDur, maxPause = CFG.maxPause) {
    if (!segs.length)
        return [];
    const out = [];
    let cur = new Segment(segs[0].start, segs[0].dur, segs[0].text);
    for (let i = 1; i < segs.length; i++) {
        const next = segs[i];
        const pause = next.start - cur.end;
        if (cur.dur + next.dur <= maxDur && pause < maxPause) {
            cur.dur = next.end - cur.start;
            cur.text += ' ' + next.text;
        }
        else {
            out.push(cur);
            cur = new Segment(next.start, next.dur, next.text);
        }
    }
    out.push(cur);
    return out;
}
// Robust atomic save: write tmp, fsync if possible, then rename.
/**
* @description Press Your { Function saveSrtAtomic } Description
* @param {any} segs
* @param {any} outFile
* @returns {void}
*/
async function saveSrtAtomic(segs, outFile) {
    const merged = mergeSegments(segs.sort((a, b) => a.start - b.start));
    const body = merged.map((s, i) => `${i + 1}\n${s.toString()}`).join('\n\n');
    const tmp = outFile + '.tmp';
    // ensure dir exists
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    // write tmp
    await fs.writeFile(tmp, body, 'utf8');
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
        console.warn(`[saveSrtAtomic] fsync warning for ${tmp}: ${err.message || err}`);
    }
    await fs.rename(tmp, outFile);
}
// ---------------- factories (worker-local) ----------------
/**
* @description Press Your { Function createRecognizer } Description
* @returns {void}
*/
function createRecognizer() {
    return new sherpa_onnx.OfflineRecognizer({
        featConfig: { sampleRate: CFG.sampleRate, featureDim: CFG.featDim },
        modelConfig: {
            senseVoice: {
                model: `${CFG.modelDir}/model.int8.onnx`,
                useInverseTextNormalization: 1,
            },
            tokens: `${CFG.modelDir}/tokens.txt`,
            numThreads: Math.max(1, Math.floor((os.cpus().length || 2) / 2)),
            provider: 'cpu',
            debug: false,
        },
    });
}
/**
* @description Press Your { Function createVad } Description
* @returns {void}
*/
function createVad() {
    return new sherpa_onnx.Vad({
        sileroVad: {
            model: `${CFG.modelDir}/silero_vad.onnx`,
            threshold: 0.5,
            minSpeechDuration: 0.25,
            minSilenceDuration: 0.5,
            windowSize: 512,
        },
        sampleRate: CFG.sampleRate,
        debug: false,
        numThreads: 1,
    }, CFG.bufferSec);
}
// ---------------- worker-side processing ----------------
/**
* @description Press Your { Function workerProcessFile } Description
* @param {any} inputFile
* @returns {void}
*/
async function workerProcessFile(inputFile) {
    const outFile = inputFile.replace(/\.[^.]+$/, '.srt');
    const recognizer = createRecognizer();
    const vad = createVad();
    const buffer = new sherpa_onnx.CircularBuffer(CFG.bufferSec * CFG.sampleRate);
    let ffmpeg = null;
    let duration = 0;
    let processed = 0;
    const segments = [];
    const startTime = Date.now();
    try {
        // get duration (non-blocking)
        duration = await new Promise((res) => {
            const ffp = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputFile]);
            let out = '';
            ffp.stdout.on('data', d => out += d.toString());
            ffp.on('close', () => res(parseFloat(out) || 0));
            ffp.on('error', () => res(0));
        });
        parentPort?.postMessage({ type: 'start', file: inputFile, duration });
        ffmpeg = spawn(ffmpegPath, ['-i', inputFile, '-f', 's16le', '-ac', '1', '-ar', String(CFG.sampleRate), '-']);
        ffmpeg.stdout.on('data', (data) => {
            const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
            const floatSamples = new Float32Array(samples.length);
            for (let i = 0; i < samples.length; i++)
                floatSamples[i] = samples[i] / 32768;
            buffer.push(floatSamples);
            while (buffer.size() >= 512) {
                const frame = buffer.get(buffer.head(), 512);
                buffer.pop(512);
                vad.acceptWaveform(frame);
            }
            processed += floatSamples.length / CFG.sampleRate;
            // throttle progress messages (approx every 0.5s of audio processed)
            if (processed % 0.5 < 0.02) {
                parentPort?.postMessage({ type: 'progress', file: inputFile, processed, duration });
            }
        });
        const code = await new Promise((res) => {
            ffmpeg.on('close', (c) => res(c));
            ffmpeg.on('error', () => res(1));
        });
        if (code !== 0)
            throw new Error(`ffmpeg exited with code ${code}`);
        // flush vad -> produce segments
        vad.flush();
        let flushCount = 0;
        while (!vad.isEmpty()) {
            flushCount++;
            if (flushCount > 100000) {
                parentPort?.postMessage({ type: 'warn', msg: 'VAD flush loop broken' });
                break;
            }
            const seg = vad.front();
            vad.pop();
            if (!seg)
                break;
            const stream = recognizer.createStream();
            try {
                stream.acceptWaveform({ samples: seg.samples, sampleRate: CFG.sampleRate });
                recognizer.decode(stream);
                const r = recognizer.getResult(stream);
                const text = r?.text?.trim() || '';
                if (text) {
                    segments.push(new Segment(seg.start / CFG.sampleRate, seg.samples.length / CFG.sampleRate, text));
                }
            }
            finally {
                safeFree(stream);
            }
        }
        // atomic save with logs — return result (do not post 'done' here)
        try {
            parentPort?.postMessage({ type: 'saving', file: inputFile, outFile });
            console.log(`[worker:${process.pid}] saving ${outFile} (segments=${segments.length})`);
            await saveSrtAtomic(segments, outFile);
            console.log(`[worker:${process.pid}] saved ${outFile}`);
            return { success: true, file: inputFile, outFile, segments: segments.length, duration, elapsed: (Date.now() - startTime) / 1000 };
        }
        catch (saveErr) {
            console.error(`[worker:${process.pid}] save error for ${outFile}:`, saveErr);
            return { success: false, file: inputFile, outFile, error: saveErr.message || String(saveErr) };
        }
    }
    finally {
        try {
            if (ffmpeg && !ffmpeg.killed)
                ffmpeg.kill('SIGKILL');
        }
        catch { }
        safeFree(vad);
        safeFree(recognizer);
        safeFree(buffer);
    }
}
// ---------------- main (pool) ----------------
/**
* @description Press Your { Function mainThread } Description
* @returns {void}
*/
async function mainThread() {
    const input = process.argv[2];
    if (!input) {
        console.error('Usage: node transcriber_parallel.js <file_or_dir>');
        process.exit(1);
    }
    const stat = await fs.stat(input);
    let files = [];
    if (stat.isDirectory()) {
        const items = await fs.readdir(input);
        for (const f of items) {
            const full = path.join(input, f);
            try {
                const s = await fs.stat(full);
                if (s.isFile() && AUDIO_EXT.has(path.extname(f).toLowerCase()))
                    files.push(full);
            }
            catch (e) { }
        }
    }
    else if (AUDIO_EXT.has(path.extname(input).toLowerCase())) {
        files.push(input);
    }
    if (!files.length) {
        console.error('No supported audio/video files.');
        process.exit(1);
    }
    // filter out files that already have .srt
    const pending = [];
    for (const f of files) {
        const out = f.replace(/\.[^.]+$/, '.srt');
        try {
            await fs.access(out);
            console.log(`Skipping ${path.basename(f)} — ${path.basename(out)} already exists`);
        }
        catch {
            pending.push(f);
        }
    }
    if (!pending.length) {
        console.log('Nothing to do.');
        return;
    }
    const cpus = os.cpus().length || 2;
    const maxWorkers = CFG.maxWorkers ? Math.max(1, CFG.maxWorkers) : Math.max(1, cpus - 1);
    const concurrency = Math.min(maxWorkers, pending.length);
    console.log(`Transcribing ${pending.length} file(s) with concurrency ${concurrency} (cpus=${cpus})`);
    // create workers
    const workers = [];
    const workerState = new Map(); // threadId => { worker, busy }
    for (let i = 0; i < concurrency; i++) {
        const w = new Worker(new URL(import.meta.url));
        workers.push(w);
        workerState.set(w.threadId, { worker: w, busy: false });
    }
    // Assign/dedup tracking to avoid double-assign
    const assignedFiles = new Set();
    let idx = 0;
    let finished = 0;
    /**
    * @description Press Your { Function assignTaskToWorker } Description
    * @param {any} worker
    * @returns {void}
    */
    function assignTaskToWorker(worker) {
        // find next unassigned file
        while (idx < pending.length && assignedFiles.has(pending[idx]))
            idx++;
        if (idx >= pending.length)
            return;
        // ensure worker is free
        const st = workerState.get(worker.threadId);
        if (!st || st.busy)
            return;
        const file = pending[idx++];
        assignedFiles.add(file);
        st.busy = true;
        console.log(`[assign] worker:${worker.threadId} -> ${path.basename(file)}`);
        worker.postMessage({ cmd: 'process', file });
    }
    const finishedPromise = new Promise((resolve) => {
        for (const w of workers) {
            w.on('message', (msg) => {
                if (msg.type === 'ready') {
                    if (idx < pending.length)
                        assignTaskToWorker(w);
                }
                else if (msg.type === 'start') {
                    console.log(`\n[worker:${w.threadId}] start ${path.basename(msg.file)} (${(msg.duration || 0).toFixed(1)}s)`);
                }
                else if (msg.type === 'progress') {
                    process.stderr.write(`\r[worker:${w.threadId}] ${path.basename(msg.file)} ${msg.processed.toFixed(1)}/${(msg.duration || 0).toFixed(1)}s`);
                }
                else if (msg.type === 'saving') {
                    console.log(`\n[worker:${w.threadId}] saving ${path.basename(msg.file)} -> ${path.basename(msg.outFile)}`);
                }
                else if (msg.type === 'warn') {
                    console.error(`\n[worker:${w.threadId}] WARN: ${msg.msg}`);
                }
                else if (msg.type === 'done') {
                    // mark worker free
                    const st = workerState.get(w.threadId);
                    if (st)
                        st.busy = false;
                    finished++;
                    if (msg.success) {
                        console.log(`\n[worker:${w.threadId}] done ${path.basename(msg.file)} -> ${msg.outFile} (${msg.segments} segs, ${(msg.elapsed || 0).toFixed(1)}s)`);
                    }
                    else {
                        console.error(`\n[worker:${w.threadId}] FAILED ${path.basename(msg.file)}. Error: ${msg.error || 'unknown'}`);
                    }
                    // assign next job if any
                    if (idx < pending.length) {
                        assignTaskToWorker(w);
                    }
                    else {
                        if (finished === pending.length) {
                            resolve();
                        }
                    }
                }
            });
            w.on('error', (err) => {
                console.error(`Worker ${w.threadId} error:`, err);
                const st = workerState.get(w.threadId);
                if (st)
                    st.busy = false;
                // assign next if any
                if (idx < pending.length)
                    assignTaskToWorker(w);
            });
            w.on('exit', (code) => {
                if (code !== 0)
                    console.error(`Worker ${w.threadId} exited with ${code}`);
            });
            // signal worker to start listening
            w.postMessage({ cmd: 'init' });
        }
    });
    await finishedPromise;
    // cleanup
    for (const w of workers)
        w.terminate();
    console.log(`\n${chalk.green('All files processed.')}`);
}
// ---------------- worker message handling ----------------
if (isMainThread) {
    mainThread().catch(err => { console.error(chalk.red('Fatal:'), err); process.exit(1); });
}
else {
    parentPort.on('message', async (msg) => {
        try {
            if (msg.cmd === 'init') {
                parentPort.postMessage({ type: 'ready' });
            }
            else if (msg.cmd === 'process') {
                const file = msg.file;
                parentPort.postMessage({ type: 'start', file });
                try {
                    const res = await workerProcessFile(file);
                    // post a single 'done' message here (outer handler)
                    parentPort.postMessage({ type: 'done', ...res });
                }
                catch (err) {
                    parentPort.postMessage({ type: 'done', success: false, file, outFile: file.replace(/\.[^.]+$/, '.srt'), error: err.message || String(err) });
                }
            }
        }
        catch (e) {
            parentPort.postMessage({ type: 'warn', msg: `worker internal error: ${e.message || e}` });
        }
    });
}

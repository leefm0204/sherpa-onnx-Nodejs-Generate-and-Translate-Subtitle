#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import https from "https";
import { URLSearchParams } from "url";

const CHUNK_SZ = 1000;
const REQ_GAP = 1200;
const CACHE_F = path.join(process.cwd(), "cache.json");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_F, "utf8");
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function saveCache(c) {
    await fs.writeFile(CACHE_F, JSON.stringify(c, null, 2), "utf8");
}

let cache = await loadCache();

async function parseSrt(file) {
    const content = await fs.readFile(file, "utf8");
    const blocks = content.split(/\r?\n\r?\n/);
    return blocks.map(b => {
        const [idx, time, ...textLines] = b.split(/\r?\n/);
        return { idx, time, text: textLines.join("\n") };
    });
}

function buildSrt(entries) {
    return entries.map(e => `${e.idx}\n${e.time}\n${e.text}`).join("\n\n") + "\n";
}

function generateTk(text) {
    const b = 406644;
    const b1 = 3293161072;
    let e = [], f = 0;
    for (let g = 0; g < text.length; g++) {
        let l = text.charCodeAt(g);
        if (l < 128) e[f++] = l;
        else {
            if (l < 2048) e[f++] = l >> 6 | 192;
            else {
                if ((l & 0xFC00) === 0xD800 && g + 1 < text.length &&
                    (text.charCodeAt(g + 1) & 0xFC00) === 0xDC00) {
                    l = 0x10000 + (((l & 0x3FF) << 10) | (text.charCodeAt(++g) & 0x3FF));
                    e[f++] = l >> 18 | 240;
                    e[f++] = l >> 12 & 63 | 128;
                } else e[f++] = l >> 12 | 224;
                e[f++] = l >> 6 & 63 | 128;
            }
            e[f++] = l & 63 | 128;
        }
    }
    let a = b;
    for (f = 0; f < e.length; f++) {
        a += e[f];
        a = (a + b1) >>> 0;
    }
    return (a >>> 0).toString();
}

async function gtxTranslate(text, targetLang, sourceLang = "auto") {
    const key = `${text}_${sourceLang}_${targetLang}`;
    if (cache[key]) return cache[key];

    const tk = generateTk(text);
    const params = new URLSearchParams({
        client: "gtx",
        sl: sourceLang,
        tl: targetLang,
        hl: targetLang,
        dt: "t",
        ie: "UTF-8",
        oe: "UTF-8",
        q: text,
        tk
    });

    const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
            let body = "";
            res.on("data", chunk => body += chunk);
            res.on("end", () => {
                try {
                    const json = JSON.parse(body);
                    const translated = json[0].map(x => x[0]).join("");
                    cache[key] = translated;
                    resolve(translated);
                } catch {
                    reject("GTX parse error");
                }
            });
        }).on("error", reject);
    });
}

async function translateFile(filePath, srcLang, tgtLang, index, total) {
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    // output file follows media base name + lang
    const outFile = path.join(path.dirname(filePath), `${baseName}.${tgtLang}.srt`);

    try {
        await fs.access(outFile);
        console.log(`(${index}/${total}) ⏭ Skipped: ${path.basename(outFile)} (already exists)`);
        return { skipped: true };
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }

    console.log(`(${index}/${total}) 📄 Translating: ${path.basename(filePath)}`);
    const entries = await parseSrt(filePath);
    let i = 0;
    while (i < entries.length) {
        let chunk = "";
        const indices = [];
        while (i < entries.length && (chunk + entries[i].text).length <= CHUNK_SZ) {
            chunk += entries[i].text + "\n";
            indices.push(i++);
        }
        if (indices.length === 0) indices.push(i++);

        try {
            const res = await gtxTranslate(chunk.trim(), tgtLang, srcLang);
            res.split("\n").forEach((t, k) => {
                if (indices[k] !== undefined) entries[indices[k]].text = t;
            });
        } catch (e) {
            console.error(`⚠️  ${e}`);
        }

        await sleep(REQ_GAP);
    }

    try {
        await fs.writeFile(outFile, buildSrt(entries), "utf8");
        await saveCache(cache);
        console.log(`✅ Saved: ${path.basename(outFile)}`);
    } catch (err) {
        console.error(`❌ Failed to write ${outFile}:`, err.message);
    }

    return { skipped: false, outPath: outFile };
}
async function main() {
    const [, , pathArg, srcLang, tgtLang] = process.argv;

    console.log(`Starting translation with path: ${pathArg}, source: ${srcLang}, target: ${tgtLang}`);

    if (!pathArg || !srcLang || !tgtLang) {
        console.error("❌ Usage: node gtx-srt.js /path/to/file/or/folder sourceLang targetLang");
        process.exit(1);
    }

    let files = [];
    try {
        const stats = await fs.stat(pathArg);
        if (stats.isDirectory()) {
            files = (await fs.readdir(pathArg))
                .filter(f => f.toLowerCase().endsWith(".srt"))
                .map(f => path.join(pathArg, f));
        } else if (stats.isFile() && pathArg.toLowerCase().endsWith(".srt")) {
            files = [pathArg];
        } else {
            console.error("❌ Invalid path. Must be a .srt file or directory containing .srt files.");
            process.exit(1);
        }
    } catch (error) {
        console.error("❌ Error accessing path:", error.message);
        process.exit(1);
    }

    if (!files.length) {
        console.error("❌ No .srt files found.");
        process.exit(1);
    }

    const total = files.length;
    let index = 0;
    let cancelled = false;
    
    // Handle cancellation signals
    const signalHandler = () => {
        cancelled = true;
        console.log("\n[INFO] Translation process cancelled by user");
        process.exit(0);
    };
    
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);

    for (const file of files) {
        // Check if cancelled before processing each file
        if (cancelled) {
            console.log(`[INFO] Skipping ${path.basename(file)} due to cancellation`);
            continue;
        }
        
        index++;
        await translateFile(file, srcLang, tgtLang, index, total);
        
        // If cancelled during processing, exit
        if (cancelled) {
            console.log("[INFO] Process cancelled during file translation");
            break;
        }
    }

    console.log("\n🎉 All done!");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

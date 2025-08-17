#!/usr/bin/env node
/**
 * gtx-srt.js
 * Async subtitle translator using Google's free "GTX" endpoint.
 * Skips files that already have target translation.
 *
 * Usage:
 *   node srt.js /path/to/folder sourceLang targetLang
 */
import fs from "fs/promises";
import path from "path";
import https from "https";
import { URLSearchParams } from "url";
// ─────────── CONFIG ───────────
const CHUNK_SZ = 1000;
const REQ_GAP = 1200;
const CACHE_F = path.join(process.cwd(), "cache.json");
// ─────────── UTILS ───────────
/**
* @description Press Your { Function sleep } Description
* @param {any} ms
* @returns {void}
*/
const sleep = ms => new Promise(r => setTimeout(r, ms));
/**
* @description Press Your { Function loadCache } Description
* @returns {void}
*/
async function loadCache() {
    try {
        const data = await fs.readFile(CACHE_F, "utf8");
        return JSON.parse(data);
    }
    catch {
        return {};
    }
}
/**
* @description Press Your { Function saveCache } Description
* @param {any} c
* @returns {void}
*/
async function saveCache(c) {
    await fs.writeFile(CACHE_F, JSON.stringify(c, null, 2), "utf8");
}
let cache = await loadCache();
// ─────────── SRT PARSE/BUILD ───────────
/**
* @description Press Your { Function parseSrt } Description
* @param {any} file
* @returns {void}
*/
async function parseSrt(file) {
    const content = await fs.readFile(file, "utf8");
    const blocks = content.split(/\r?\n\r?\n/);
    return blocks.map(b => {
        const [idx, time, ...textLines] = b.split(/\r?\n/);
        return { idx, time, text: textLines.join("\n") };
    });
}
/**
* @description Press Your { Function buildSrt } Description
* @param {any} entries
* @returns {void}
*/
function buildSrt(entries) {
    return entries.map(e => `${e.idx}\n${e.time}\n${e.text}`).join("\n\n") + "\n";
}
// ─────────── GTX TOKEN ───────────
/**
* @description Press Your { Function generateTk } Description
* @param {any} text
* @returns {void}
*/
function generateTk(text) {
    const b = 406644;
    const b1 = 3293161072;
    let e = [], f = 0;
    for (let g = 0; g < text.length; g++) {
        let l = text.charCodeAt(g);
        if (l < 128)
            e[f++] = l;
        else {
            if (l < 2048)
                e[f++] = l >> 6 | 192;
            else {
                if ((l & 0xFC00) === 0xD800 && g + 1 < text.length &&
                    (text.charCodeAt(g + 1) & 0xFC00) === 0xDC00) {
                    l = 0x10000 + (((l & 0x3FF) << 10) | (text.charCodeAt(++g) & 0x3FF));
                    e[f++] = l >> 18 | 240;
                    e[f++] = l >> 12 & 63 | 128;
                }
                else
                    e[f++] = l >> 12 | 224;
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
// ─────────── GTX TRANSLATE ───────────
/**
* @description Press Your { Function gtxTranslate } Description
* @param {any} text
* @param {any} targetLang
* @param {any} sourceLang
* @returns {void}
*/
async function gtxTranslate(text, targetLang, sourceLang = "auto") {
    const key = `${text}_${sourceLang}_${targetLang}`;
    if (cache[key])
        return cache[key];
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
                }
                catch {
                    reject("GTX parse error");
                }
            });
        }).on("error", reject);
    });
}
// ─────────── MAIN TRANSLATION ───────────
/**
* @description Press Your { Function translateFile } Description
* @param {any} filePath
* @param {any} srcLang
* @param {any} tgtLang
* @param {any} index
* @param {any} total
* @returns {void}
*/
async function translateFile(filePath, srcLang, tgtLang, index, total) {
    const outFile = filePath.replace(/\.srt$/i, `-${tgtLang}.srt`);
    // Skip if already exists
    try {
        await fs.access(outFile);
        console.log(`(${index}/${total}) ⏭ Skipped: ${path.basename(outFile)} (already exists)`);
        return;
    }
    catch { }
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
        if (indices.length === 0)
            indices.push(i++);
        try {
            const res = await gtxTranslate(chunk.trim(), tgtLang, srcLang);
            res.split("\n").forEach((t, k) => {
                if (indices[k] !== undefined)
                    entries[indices[k]].text = t;
            });
        }
        catch (e) {
            console.error(`⚠️  ${e}`);
        }
        await sleep(REQ_GAP);
    }
    await fs.writeFile(outFile, buildSrt(entries), "utf8");
    await saveCache(cache); // Save cache after processing
    console.log(`✅ Saved: ${path.basename(outFile)}`);
    return { skipped: false, outPath: outFile };
}
// ─────────── CLI ENTRY ───────────
/**
* @description Press Your { Function main } Description
* @returns {void}
*/
async function main() {
    const [, , folder, srcLang, tgtLang] = process.argv;
    if (!folder || !srcLang || !tgtLang) {
        console.error("❌ Usage: node srt.js /path/to/folder sourceLang targetLang");
        process.exit(1);
    }
    let files;
    try {
        files = (await fs.readdir(folder))
            .filter(f => f.toLowerCase().endsWith(".srt"))
            .map(f => path.join(folder, f));
    }
    catch {
        console.error("❌ Invalid folder path.");
        process.exit(1);
    }
    if (!files.length) {
        console.error("❌ No .srt files found.");
        process.exit(1);
    }
    const total = files.length;
    let index = 0;
    for (const file of files) {
        index++;
        await translateFile(file, srcLang, tgtLang, index, total);
    }
    console.log("\n🎉 All done!");
}
// Run main function if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) {
    try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegPath = 'ffmpeg'; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Telegram yuklash limiti: oddiy Bot API — 50MB, lokal Bot API server — 2GB
const MAX_UPLOAD = process.env.TELEGRAM_API_URL ? 2000 * 1024 * 1024 : 50 * 1024 * 1024;

const TMP_ROOT = path.join(__dirname, '..', 'tmp');

class DownloadError extends Error {
    constructor(message, userMessage) {
        super(message);
        this.userMessage = userMessage;
    }
}

class TooLargeError extends Error {
    constructor(size, url) {
        super(`Fayl juda katta: ${size}`);
        this.size = size;
        this.url = url;
    }
}

function exec(bin, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, {
            maxBuffer: 64 * 1024 * 1024,
            timeout: opts.timeout || 10 * 60 * 1000,
            cwd: opts.cwd,
        }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function makeWorkDir() {
    const dir = path.join(TMP_ROOT, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function removeDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'm4v'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav'];

function extOf(name) {
    if (!name) return '';
    const clean = name.split('?')[0].split('#')[0];
    const m = clean.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
}

function typeFromExt(ext) {
    if (ext === 'gif') return 'animation';
    if (IMAGE_EXT.includes(ext)) return 'photo';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (AUDIO_EXT.includes(ext)) return 'audio';
    return null;
}

function extFromContentType(ct) {
    if (!ct) return '';
    ct = ct.split(';')[0].trim().toLowerCase();
    const map = {
        'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
        'image/gif': 'gif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/webm': 'webm',
        'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
        'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    };
    return map[ct] || '';
}

// URL'dan faylni yuklab olish (hajm limitini tekshirib)
async function downloadFile(url, dir, baseName, { headers = {}, type, maxBytes = MAX_UPLOAD } = {}) {
    const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 180000,
        maxRedirects: 10,
        headers: { 'User-Agent': UA, ...headers },
    });

    const len = parseInt(res.headers['content-length'] || '0', 10);
    if (maxBytes && len > maxBytes) {
        res.data.destroy();
        throw new TooLargeError(len, url);
    }

    let ext = extFromContentType(res.headers['content-type']) || extOf(url);
    if (!ext) ext = type === 'photo' ? 'jpg' : type === 'audio' ? 'mp3' : 'mp4';
    // Telegram videoni fayl emas, video sifatida ko'rishi uchun
    if (type === 'video' && !VIDEO_EXT.includes(ext)) ext = 'mp4';

    const filePath = path.join(dir, `${baseName}.${ext}`);
    const writer = fs.createWriteStream(filePath);
    let bytes = 0;

    await new Promise((resolve, reject) => {
        res.data.on('data', (chunk) => {
            bytes += chunk.length;
            if (maxBytes && bytes > maxBytes) {
                res.data.destroy();
                writer.destroy();
                reject(new TooLargeError(bytes, url));
            }
        });
        res.data.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        res.data.pipe(writer);
    });

    if (bytes === 0) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        throw new Error('Bo\'sh fayl qaytdi');
    }

    return { path: filePath, size: bytes, type: type || typeFromExt(ext) || 'video' };
}

// HLS (m3u8) oqimini mp4 ga aylantirish
async function downloadHls(url, dir, baseName, headers = {}) {
    const out = path.join(dir, `${baseName}.mp4`);
    const headerStr = Object.entries({ 'User-Agent': UA, ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    await exec(ffmpegPath, [
        '-y', '-loglevel', 'error', '-headers', headerStr, '-i', url,
        '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out,
    ], { timeout: 10 * 60 * 1000 });
    const size = fs.statSync(out).size;
    if (size > MAX_UPLOAD) throw new TooLargeError(size, url);
    return { path: out, size, type: 'video' };
}

// Alohida video va audio oqimlarini birlashtirish
async function mergeAv(videoPath, audioPath, dir, baseName) {
    const out = path.join(dir, `${baseName}_merged.mp4`);
    await exec(ffmpegPath, [
        '-y', '-loglevel', 'error', '-i', videoPath, '-i', audioPath,
        '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-movflags', '+faststart', out,
    ]);
    return out;
}

// Qisqa linklarni (pin.it, vm.tiktok, instagram share) ochish
async function resolveUrl(url) {
    try {
        const res = await axios.get(url, {
            maxRedirects: 10,
            timeout: 15000,
            responseType: 'stream',
            headers: { 'User-Agent': UA },
            validateStatus: () => true,
        });
        res.data.destroy();
        return (res.request && res.request.res && res.request.res.responseUrl) || url;
    } catch (e) {
        return url;
    }
}

// Oddiy semafor — bir vaqtda ishlaydigan yuklashlar sonini cheklash
function createLimiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= max || queue.length === 0) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            active--;
            next();
        });
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

module.exports = {
    UA, MAX_UPLOAD, TMP_ROOT, ffmpegPath,
    DownloadError, TooLargeError,
    exec, makeWorkDir, removeDir, extOf, typeFromExt,
    downloadFile, downloadHls, mergeAv, resolveUrl, createLimiter,
};

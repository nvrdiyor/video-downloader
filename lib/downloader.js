const fs = require('fs');
const path = require('path');
const { downloadFile, downloadHls, TooLargeError, DownloadError, MAX_UPLOAD } = require('./utils');
const { chainFor, audioChainFor } = require('./providers');

const MAX_ITEMS = 20;

function detectPlatform(url) {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
    host = host.replace(/^(www\.|m\.|mobile\.)/, '');
    if (/(^|\.)(instagram\.com|instagr\.am|ddinstagram\.com)$/.test(host)) return 'instagram';
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(^|\.)pin\.it$/.test(host) || /(^|\.)pinterest\.[a-z.]+$/.test(host)) return 'pinterest';
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
    return null;
}

// Xabar matnidan birinchi linkni ajratib olish
function extractUrl(text) {
    if (!text) return null;
    const m = text.match(/https?:\/\/[^\s<>"']+/i);
    return m ? m[0].replace(/[),.!?]+$/, '') : null;
}

// Provider natijasidagi elementlarni lokal fayllarga aylantirish
async function materialize(items, dir) {
    const files = [];
    const tooLarge = [];
    let lastErr = null;

    for (let i = 0; i < Math.min(items.length, MAX_ITEMS); i++) {
        const item = items[i];
        if (item.path) {
            const size = item.size || fs.statSync(item.path).size;
            if (size > MAX_UPLOAD) tooLarge.push({ type: item.type, size });
            else files.push({ path: item.path, type: item.type, size });
            continue;
        }
        const base = `item_${String(i).padStart(2, '0')}`;
        try {
            let f;
            try {
                f = item.hls
                    ? await downloadHls(item.url, dir, base, item.headers)
                    : await downloadFile(item.url, dir, base, { headers: item.headers, type: item.type });
            } catch (e) {
                if (!item.fallback || e instanceof TooLargeError) throw e;
                f = await downloadFile(item.fallback, dir, base, { headers: item.headers, type: item.type });
            }
            // Kontent turi URL'dagi turdan farq qilsa (masalan, rasm o'rniga video)
            if (item.type !== 'audio' && f.type !== item.type && ['photo', 'video', 'animation'].includes(f.type)) {
                files.push(f);
            } else {
                files.push({ ...f, type: item.type || f.type });
            }
        } catch (e) {
            if (e instanceof TooLargeError) tooLarge.push({ type: item.type, size: e.size, url: item.url });
            else lastErr = e;
            console.error(`  ↳ element ${i} yuklanmadi:`, e.message);
        }
    }

    if (!files.length && !tooLarge.length) throw lastErr || new Error('Hech narsa yuklanmadi');
    return { files, tooLarge };
}

// Asosiy funksiya: linkdan media yuklab olish (manbalarni navbat bilan sinab ko'radi)
async function fetchMedia(url, platform, workDir) {
    const chain = chainFor(platform, url);
    let lastErr = null;
    let userMessage = null;

    for (let i = 0; i < chain.length; i++) {
        const provider = chain[i];
        const dir = path.join(workDir, `try${i}`);
        fs.mkdirSync(dir, { recursive: true });
        try {
            const result = await provider(url, { dir });
            const { files, tooLarge } = await materialize(result.items || [], dir);
            console.log(`✅ ${platform} | ${provider.providerName} | ${files.length} ta fayl`);
            return { files, tooLarge, audio: result.audio || null, provider: provider.providerName };
        } catch (e) {
            lastErr = e;
            if (e.userMessage && !userMessage) userMessage = e.userMessage;
            console.error(`❌ ${platform} | ${provider.providerName}: ${e.message}`);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
        }
    }

    const err = new DownloadError(lastErr ? lastErr.message : 'Yuklab bo\'lmadi', userMessage);
    throw err;
}

// Musiqa/audio yuklab olish
async function fetchAudio(url, platform, workDir, known) {
    const chain = audioChainFor(platform);
    if (known && known.url) {
        chain.unshift(Object.assign(async () => known, { providerName: 'cached' }));
    }

    for (let i = 0; i < chain.length; i++) {
        const provider = chain[i];
        const dir = path.join(workDir, `audio${i}`);
        fs.mkdirSync(dir, { recursive: true });
        try {
            const a = await provider(url, { dir });
            let file = a.path;
            if (!file) {
                const f = await downloadFile(a.url, dir, 'audio', { type: 'audio' });
                file = f.path;
            }
            console.log(`🎵 ${platform} | ${provider.providerName}`);
            return { path: file, title: a.title, performer: a.performer };
        } catch (e) {
            console.error(`❌ audio ${platform} | ${provider.providerName}: ${e.message}`);
        }
    }
    throw new DownloadError('Audio topilmadi', 'Bu postdan musiqani ajratib bo\'lmadi.');
}

module.exports = { detectPlatform, extractUrl, fetchMedia, fetchAudio };

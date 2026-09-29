const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec, ffmpegPath, MAX_UPLOAD, UA, typeFromExt, extOf, DownloadError } = require('./utils');
const cookies = require('./cookies');

const BIN_DIR = path.join(__dirname, '..', 'bin');
let bin = null;
let version = '';

function assetName() {
    if (process.platform === 'win32') return 'yt-dlp.exe';
    if (process.platform === 'darwin') return 'yt-dlp_macos';
    if (process.arch === 'arm64') return 'yt-dlp_linux_aarch64';
    return 'yt-dlp_linux';
}

// yt-dlp ni topish, bo'lmasa GitHub'dan avtomatik yuklab olish
async function ensure() {
    const local = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    const candidates = [process.env.YTDLP_PATH, local, 'yt-dlp'].filter(Boolean);

    for (const c of candidates) {
        try {
            const { stdout } = await exec(c, ['--version'], { timeout: 60000 });
            bin = c;
            version = stdout.trim();
            console.log(`✅ yt-dlp topildi: ${c} (${version})`);
            return true;
        } catch (e) {}
    }

    try {
        console.log('⬇️ yt-dlp yuklab olinmoqda...');
        fs.mkdirSync(BIN_DIR, { recursive: true });
        const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 300000, maxRedirects: 10 });
        fs.writeFileSync(local, Buffer.from(res.data));
        fs.chmodSync(local, 0o755);
        const { stdout } = await exec(local, ['--version'], { timeout: 60000 });
        bin = local;
        version = stdout.trim();
        console.log(`✅ yt-dlp o'rnatildi (${version})`);
        return true;
    } catch (e) {
        console.error('❌ yt-dlp o\'rnatib bo\'lmadi:', e.message);
        return false;
    }
}

// YouTube PO token plagini (bgutil) — bepul, serverdagi bgutil-provider konteyneri bilan ishlaydi.
// Plagin token serveri (http://127.0.0.1:4416) topilmasa, yt-dlp oddiy rejimda ishlashda davom etadi.
const PLUGIN_DIR = path.join(BIN_DIR, 'yt-dlp-plugins');
const POT_PLUGIN = path.join(PLUGIN_DIR, 'bgutil-ytdlp-pot-provider.zip');

async function ensurePotPlugin() {
    if (process.env.YOUTUBE_POT_PLUGIN === 'off') return;
    try {
        fs.mkdirSync(PLUGIN_DIR, { recursive: true });
        const url = 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip';
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, maxRedirects: 10 });
        fs.writeFileSync(POT_PLUGIN, Buffer.from(res.data));
        console.log('✅ YouTube PO token plagini yangilandi');
    } catch (e) {
        console.error('PO token plaginini yuklab bo\'lmadi:', e.message);
    }
}

// yt-dlp ni yangilab turish (saytlar tez-tez o'zgaradi)
async function update() {
    await ensurePotPlugin();
    if (!bin || !bin.startsWith(BIN_DIR)) return;
    try {
        const { stdout } = await exec(bin, ['-U'], { timeout: 300000 });
        const { stdout: v } = await exec(bin, ['--version'], { timeout: 60000 });
        version = v.trim();
        console.log('🔄 yt-dlp:', stdout.trim().split('\n').pop());
    } catch (e) {
        console.error('yt-dlp yangilashda xato:', e.message);
    }
}

function available() {
    return !!bin;
}

function baseArgs(platform, dir) {
    const args = [
        '--no-warnings', '--no-progress', '--no-mtime', '--restrict-filenames',
        '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
        '--user-agent', UA,
        '-P', dir,
    ];
    if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);

    // YouTube uchun yangi yt-dlp JS runtime talab qiladi — Node.js dan foydalanamiz
    if (platform === 'youtube' && version >= '2025.11.12') {
        args.push('--js-runtimes', `node:${process.execPath}`);
    }
    // Server (datacenter) IP'lardan "bot emasligingizni tasdiqlang" xatosini chetlab o'tish uchun
    // mweb klienti ham qo'shiladi
    if (platform === 'youtube') {
        const clients = process.env.YOUTUBE_PLAYER_CLIENTS || 'default,mweb';
        args.push('--extractor-args', `youtube:player_client=${clients}`);
        if (fs.existsSync(POT_PLUGIN)) args.push('--plugin-dirs', PLUGIN_DIR);
        if (process.env.YOUTUBE_POT_URL) {
            args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${process.env.YOUTUBE_POT_URL}`);
        }
    }

    const cookieFile = cookies.netscapeFileFor(platform, dir);
    if (cookieFile) args.push('--cookies', cookieFile);

    if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
    if (process.env.YTDLP_EXTRA_ARGS) args.push(...process.env.YTDLP_EXTRA_ARGS.split(' ').filter(Boolean));
    return args;
}

function listMedia(dir) {
    return fs.readdirSync(dir)
        .filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.txt'))
        .map(f => {
            const p = path.join(dir, f);
            return { path: p, size: fs.statSync(p).size, type: typeFromExt(extOf(f)) };
        })
        .filter(f => f.type && f.size > 0)
        .sort((a, b) => a.path.localeCompare(b.path));
}

function friendlyError(stderr) {
    const s = stderr || '';
    if (/confirm you.?re not a bot|Sign in to confirm/i.test(s)) {
        return 'YouTube serverni bot deb hisobladi. Keyinroq urinib ko\'ring.';
    }
    if (/private|login required|rate-limit reached or login required|not available/i.test(s)) {
        return 'Bu kontent yopiq (private) yoki mavjud emas.';
    }
    if (/Unsupported URL/i.test(s)) return 'Bu link qo\'llab-quvvatlanmaydi.';
    return null;
}

async function run(args) {
    try {
        return await exec(bin, args, { timeout: 15 * 60 * 1000 });
    } catch (e) {
        const lastLine = (e.stderr || e.message || '').trim().split('\n').slice(-3).join(' | ');
        throw new DownloadError(`yt-dlp: ${lastLine}`, friendlyError(e.stderr));
    }
}

function clearMedia(dir) {
    for (const f of listMedia(dir)) {
        try { fs.unlinkSync(f.path); } catch (e) {}
    }
}

// Video/rasm yuklab olish
async function download(url, platform, dir) {
    if (!bin) throw new Error('yt-dlp mavjud emas');
    const common = [
        ...baseArgs(platform, dir),
        '-o', '%(id).60B_%(autonumber)02d.%(ext)s',
        '--merge-output-format', 'mp4',
        '--postprocessor-args', 'Merger+ffmpeg_o:-movflags +faststart',
    ];

    if (platform === 'youtube') {
        common.push('--no-playlist');
        const limitMb = Math.floor(MAX_UPLOAD / 1024 / 1024);
        const vLim = `${Math.floor(limitMb * 0.85)}M`;
        const aLim = `${Math.floor(limitMb * 0.15)}M`;
        const heights = MAX_UPLOAD > 60 * 1024 * 1024 ? [1080, 720] : [720, 480, 360];

        for (const h of heights) {
            const format = [
                `bv*[height<=${h}][filesize<?${vLim}]+ba[filesize<?${aLim}]`,
                `bv*[height<=${h}][filesize_approx<?${vLim}]+ba`,
                `b[height<=${h}][filesize<?${limitMb}M]`,
            ].join('/');
            try {
                await run([...common, '-f', format, '-S', 'vcodec:h264,res,acodec:m4a', url]);
            } catch (e) {
                if (/Requested format is not available/i.test(e.message)) continue;
                throw e;
            }
            const files = listMedia(dir);
            if (files.length && files.every(f => f.size <= MAX_UPLOAD)) return files;
            clearMedia(dir);
        }
        // Oxirgi urinish — eng kichik sifat
        await run([...common, '-f', 'b[height<=360]/wv*+wa/w', url]);
        return listMedia(dir);
    }

    await run([
        ...common,
        '--yes-playlist', '--playlist-items', '1:20',
        '-f', 'bv*+ba/b',
        '-S', 'res,vcodec:h264,acodec:m4a',
        url,
    ]);
    return listMedia(dir);
}

// Faqat audio (mp3) yuklab olish
async function downloadAudio(url, platform, dir) {
    if (!bin) throw new Error('yt-dlp mavjud emas');
    await run([
        ...baseArgs(platform, dir),
        '-o', '%(title).80B.%(ext)s',
        '--no-playlist',
        '-f', 'ba/b',
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '--embed-metadata',
        url,
    ]);
    const files = listMedia(dir).filter(f => f.type === 'audio');
    if (!files.length) throw new Error('yt-dlp audio fayl qaytarmadi');
    return { ...files[0], title: path.basename(files[0].path, path.extname(files[0].path)).replace(/_/g, ' ') };
}

module.exports = { ensure, update, available, download, downloadAudio };

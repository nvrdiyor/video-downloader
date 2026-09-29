// Har bir manba (provider) quyidagi ko'rinishda natija qaytaradi:
// { items: [{ type: 'photo'|'video'|'animation', url, headers?, hls? } | { type, path, size }],
//   audio: { url, title, performer } | null }
const axios = require('axios');
const path = require('path');
const { UA, resolveUrl, DownloadError, downloadFile, mergeAv, typeFromExt, extOf } = require('./utils');
const cookies = require('./cookies');
const ytdlp = require('./ytdlp');

const COBALT_API_URL = process.env.COBALT_API_URL || 'http://178.128.199.137:9000/';
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';

// ==================== COBALT (o'zimizning server) ====================

async function cobaltRequest(body) {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
    const res = await axios.post(COBALT_API_URL, body, {
        headers, timeout: 60000, validateStatus: () => true,
    });
    return res.data || {};
}

async function cobalt(url, { dir, audioOnly = false } = {}) {
    const body = {
        url,
        videoQuality: '1080',
        audioFormat: 'mp3',
        downloadMode: audioOnly ? 'audio' : 'auto',
    };
    let data = await cobaltRequest(body);
    // Eski/yangi versiyalar bilan moslik — faqat URL bilan qayta urinish
    if (data.status === 'error' && /invalid_body/.test(data.error?.code || '')) {
        data = await cobaltRequest({ url, downloadMode: body.downloadMode });
    }

    if (data.status === 'error' || !data.status) {
        const code = data.error?.code || 'unknown';
        let userMessage = null;
        if (/fetch\.empty|content\.post\.private|content\.video\.private|unavailable/.test(code)) {
            userMessage = 'Bu kontent yopiq (private) yoki o\'chirilgan.';
        }
        throw new DownloadError(`cobalt: ${code}`, userMessage);
    }

    if (data.status === 'redirect' || data.status === 'tunnel') {
        const ext = extOf(data.filename);
        const type = audioOnly ? 'audio' : (typeFromExt(ext) || 'video');
        return { items: [{ type, url: data.url }], audio: null };
    }

    if (data.status === 'picker' && Array.isArray(data.picker)) {
        const items = data.picker.map(p => ({
            type: p.type === 'photo' ? 'photo' : p.type === 'gif' ? 'animation' : 'video',
            url: p.url,
        }));
        const audio = data.audio ? { url: data.audio, title: data.audioFilename } : null;
        return { items, audio };
    }

    // Cobalt v11: "local-processing" — video va audioni o'zimiz birlashtiramiz
    if (data.status === 'local-processing' && Array.isArray(data.tunnel)) {
        if ((data.type === 'proxy' || data.type === 'remux' || data.type === 'audio') && data.tunnel.length >= 1) {
            const t = data.type === 'audio' ? 'audio' : (typeFromExt(extOf(data.output?.filename)) || 'video');
            return { items: [{ type: t, url: data.tunnel[0] }], audio: null };
        }
        if (data.type === 'merge' && data.tunnel.length >= 2 && dir) {
            const v = await downloadFile(data.tunnel[0], dir, 'cobalt_v', { type: 'video' });
            const a = await downloadFile(data.tunnel[1], dir, 'cobalt_a', { type: 'audio' });
            const merged = await mergeAv(v.path, a.path, dir, 'cobalt');
            return { items: [{ type: 'video', path: merged }], audio: null };
        }
    }

    throw new Error(`cobalt: noma'lum javob ${JSON.stringify(data).slice(0, 200)}`);
}

// ==================== TIKTOK (tikwm.com — bepul API) ====================

async function tikwm(url) {
    const abs = (u) => (!u ? null : u.startsWith('http') ? u : `https://www.tikwm.com${u}`);
    const res = await axios.post('https://www.tikwm.com/api/',
        new URLSearchParams({ url, hd: '1' }).toString(),
        {
            headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
        });
    const body = res.data || {};
    if (body.code !== 0 || !body.data) throw new Error(`tikwm: ${body.msg || 'xato'}`);
    const d = body.data;

    const musicUrl = abs(d.music_info?.play || d.music);
    const audio = musicUrl ? {
        url: musicUrl,
        title: d.music_info?.title,
        performer: d.music_info?.author,
    } : null;

    if (Array.isArray(d.images) && d.images.length) {
        return { items: d.images.map(u => ({ type: 'photo', url: abs(u) })), audio };
    }

    const videoUrl = abs(d.hdplay || d.play);
    if (!videoUrl) throw new Error('tikwm: video topilmadi');
    return { items: [{ type: 'video', url: videoUrl }], audio };
}

// ==================== PINTEREST (rasmiy sayt API'si) ====================

function bestPinVideo(videoList) {
    const list = Object.values(videoList || {}).filter(v => v && v.url);
    const mp4 = list.filter(v => /\.mp4(\?|$)/i.test(v.url)).sort((a, b) => (b.width || 0) - (a.width || 0));
    if (mp4.length) return { type: 'video', url: mp4[0].url };
    const hls = list.find(v => /\.m3u8/i.test(v.url));
    if (hls) return { type: 'video', url: hls.url, hls: true };
    return null;
}

function bestPinImage(images) {
    if (!images) return null;
    const direct = images.orig || images.originals;
    let url = direct?.url;
    if (!url) {
        const all = Object.values(images).filter(v => v && v.url);
        all.sort((a, b) => (b.width || 0) - (a.width || 0));
        url = all[0]?.url;
    }
    if (!url) return null;
    // Eng yuqori sifat — originals (bo'lmasa kichikrog'iga qaytamiz)
    const original = url.replace(/\/\d+x(\d+)?\//, '/originals/');
    const type = extOf(url) === 'gif' ? 'animation' : 'photo';
    return { type, url: original, fallback: original !== url ? url : undefined };
}

async function pinterest(url) {
    let u = url;
    if (/pin\.it/i.test(u)) u = await resolveUrl(u);
    const m = u.match(/\/pin\/(?:[^/]*--)?(\d+)/) || u.match(/\/pin\/([\w-]+)/);
    if (!m) throw new Error('pinterest: pin ID topilmadi');
    const id = m[1];

    const res = await axios.get('https://www.pinterest.com/resource/PinResource/get/', {
        params: {
            source_url: `/pin/${id}/`,
            data: JSON.stringify({ options: { id, field_set_key: 'unauth_react_main_pin' } }),
        },
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Pinterest-PWS-Handler': 'www/pin/[id].js',
            'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 30000,
    });
    const pin = res.data?.resource_response?.data;
    if (!pin) throw new Error('pinterest: ma\'lumot topilmadi');

    const items = [];

    const video = bestPinVideo(pin.videos?.video_list);
    if (video) items.push(video);

    // Idea (story) pinlar — bir nechta sahifa
    if (!items.length && Array.isArray(pin.story_pin_data?.pages)) {
        for (const page of pin.story_pin_data.pages) {
            for (const block of page.blocks || []) {
                const v = bestPinVideo(block.video?.video_list);
                if (v) { items.push(v); continue; }
                const img = bestPinImage(block.image?.images);
                if (img) items.push(img);
            }
        }
    }

    // Karusel pinlar
    if (!items.length && Array.isArray(pin.carousel_data?.carousel_slots)) {
        for (const slot of pin.carousel_data.carousel_slots) {
            const img = bestPinImage(slot.images);
            if (img) items.push(img);
        }
    }

    if (!items.length) {
        const img = bestPinImage(pin.images);
        if (img) items.push(img);
    }

    if (!items.length) throw new Error('pinterest: media topilmadi');
    return { items, audio: null };
}

// ==================== INSTAGRAM ====================

const IG_APP_ID = '936619743392459';
const IG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function shortcodeToPk(code) {
    let n = 0n;
    for (const c of code.slice(0, 11)) n = n * 64n + BigInt(IG_ALPHABET.indexOf(c));
    return n.toString();
}

function igShortcode(url) {
    const m = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i);
    return m ? m[1] : null;
}

function igMediaToItems(m) {
    if (Array.isArray(m.carousel_media) && m.carousel_media.length) {
        return m.carousel_media.flatMap(igMediaToItems);
    }
    if (Array.isArray(m.video_versions) && m.video_versions.length) {
        const best = [...m.video_versions].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0];
        return [{ type: 'video', url: best.url }];
    }
    const cands = m.image_versions2?.candidates || [];
    if (cands.length) {
        const best = [...cands].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0];
        return [{ type: 'photo', url: best.url }];
    }
    return [];
}

function igMusic(m) {
    const info = m.music_metadata?.music_info?.music_asset_info
        || m.clips_metadata?.music_info?.music_asset_info
        || m.story_music_stickers?.[0]?.music_asset_info;
    if (info?.progressive_download_url) {
        return { url: info.progressive_download_url, title: info.title, performer: info.display_artist };
    }
    const os = m.clips_metadata?.original_sound_info;
    if (os?.progressive_download_url) {
        return { url: os.progressive_download_url, title: os.original_audio_title, performer: os.ig_artist?.username };
    }
    return null;
}

// Cookie (login) bilan Instagram API — eng sifatli, story va musiqalarni ham beradi
async function instagramApi(url) {
    const cookie = cookies.getInstagramCookie();
    if (!cookie) throw new Error('instagram: cookie sozlanmagan');
    const csrf = (cookie.match(/csrftoken=([^;]+)/) || [])[1];
    const headers = {
        'User-Agent': UA,
        'Cookie': cookie,
        'X-IG-App-ID': IG_APP_ID,
        'X-ASBD-ID': '129477',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.instagram.com/',
        'Accept': '*/*',
    };
    if (csrf) headers['X-CSRFToken'] = csrf;
    const api = (p) => axios.get(`https://www.instagram.com/api/v1/${p}`, { headers, timeout: 30000 }).then(r => r.data);

    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    let medias = [];

    if (parts[0] === 'stories') {
        if (parts[1] === 'highlights') {
            const reelId = `highlight:${parts[2]}`;
            const data = await api(`feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
            medias = data.reels?.[reelId]?.items || data.reels_media?.[0]?.items || [];
            const sel = u.searchParams.get('story_media_id');
            if (sel) {
                const one = medias.filter(i => String(i.id).startsWith(sel.split('_')[0]) || String(i.pk) === sel.split('_')[0]);
                if (one.length) medias = one;
            }
        } else if (parts[2] && /^\d+$/.test(parts[2])) {
            const data = await api(`media/${parts[2]}/info/`);
            medias = data.items || [];
        } else if (parts[1]) {
            // Foydalanuvchining barcha joriy storylari
            const profile = await api(`users/web_profile_info/?username=${encodeURIComponent(parts[1])}`);
            const userId = profile.data?.user?.id;
            if (!userId) throw new Error('instagram: foydalanuvchi topilmadi');
            const data = await api(`feed/reels_media/?reel_ids=${userId}`);
            medias = data.reels?.[userId]?.items || data.reels_media?.[0]?.items || [];
            if (!medias.length) throw new DownloadError('instagram: story yo\'q', 'Bu foydalanuvchida hozir faol story yo\'q.');
        }
    } else {
        const code = igShortcode(url);
        if (!code) throw new Error('instagram: shortcode topilmadi');
        const data = await api(`media/${shortcodeToPk(code)}/info/`);
        medias = data.items || [];
    }

    const items = medias.flatMap(igMediaToItems);
    if (!items.length) throw new Error('instagram api: media topilmadi');
    const audio = medias.map(igMusic).find(Boolean) || null;
    return { items, audio };
}

// Login talab qilmaydigan embed sahifasi — oxirgi zaxira
async function instagramEmbed(url) {
    const code = igShortcode(url);
    if (!code) throw new Error('instagram embed: shortcode topilmadi');
    const res = await axios.get(`https://www.instagram.com/p/${code}/embed/captioned/`, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        timeout: 30000,
    });
    const html = String(res.data || '');
    const items = [];

    const ctx = html.match(/"contextJSON":"((?:\\.|[^"\\])*)"/);
    if (ctx) {
        try {
            const json = JSON.parse(JSON.parse(`"${ctx[1]}"`));
            const media = json?.gql_data?.shortcode_media || json?.gql_data?.xdt_shortcode_media;
            const nodes = media?.edge_sidecar_to_children?.edges?.map(e => e.node) || (media ? [media] : []);
            for (const n of nodes) {
                if (n.is_video && n.video_url) items.push({ type: 'video', url: n.video_url });
                else if (n.display_url) items.push({ type: 'photo', url: n.display_url });
            }
        } catch (e) {}
    }

    // Sahifa ichidagi (ba'zan escape qilingan) JSON'dan to'g'ridan-to'g'ri qidirish
    if (!items.length) {
        const clean = (s) => s.replace(/\\+\//g, '/').replace(/\\+u0026/g, '&').replace(/\\+u003d/gi, '=');
        const find = (key) => [...html.matchAll(new RegExp(`\\\\*"${key}\\\\*":\\s*\\\\*"(https?:.*?)\\\\*"`, 'g'))].map(m => clean(m[1]));
        const videos = find('video_url');
        const images = find('display_url');
        if (videos.length) items.push({ type: 'video', url: videos[0] });
        else if (images.length) items.push(...[...new Set(images)].map(url => ({ type: 'photo', url })));
    }

    if (!items.length) {
        const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) || html.match(/<img[^>]+class="EmbeddedMediaImage"[^>]+src="([^"]+)"/);
        if (img) items.push({ type: 'photo', url: img[1].replace(/&amp;/g, '&') });
    }

    if (!items.length) throw new Error('instagram embed: media topilmadi');
    return { items, audio: null };
}

// ==================== YT-DLP (universal) ====================

function ytdlpProvider(platform) {
    return async (url, { dir }) => {
        const files = await ytdlp.download(url, platform, dir);
        if (!files.length) throw new Error('yt-dlp: fayl topilmadi');
        return { items: files, audio: null };
    };
}

// ==================== PLATFORMA BO'YICHA TARTIB ====================

function chainFor(platform, url) {
    const named = (name, fn) => Object.assign(fn, { providerName: name });
    const cob = named('cobalt', cobalt);
    const yt = named('yt-dlp', ytdlpProvider(platform));

    switch (platform) {
        case 'tiktok':
            return [named('tikwm', tikwm), cob, yt];
        case 'pinterest':
            return [named('pinterest', pinterest), cob, yt];
        case 'youtube':
            return [yt, cob];
        case 'instagram': {
            const hasCookie = !!cookies.getInstagramCookie();
            const isStory = /\/stories\//i.test(url);
            const chain = [];
            if (hasCookie) chain.push(named('instagram-api', instagramApi));
            if (isStory) chain.push(yt, cob);
            else chain.push(cob, yt, named('instagram-embed', instagramEmbed));
            return chain;
        }
        default:
            return [cob, yt];
    }
}

// Musiqa (audio) uchun manbalar
function audioChainFor(platform) {
    const named = (name, fn) => Object.assign(fn, { providerName: name });
    const chain = [];
    if (platform === 'tiktok') chain.push(named('tikwm', async (url) => {
        const r = await tikwm(url);
        if (!r.audio) throw new Error('tikwm: musiqa yo\'q');
        return r.audio;
    }));
    if (platform === 'instagram' && cookies.getInstagramCookie()) chain.push(named('instagram-api', async (url) => {
        const r = await instagramApi(url);
        if (!r.audio) throw new Error('instagram: musiqa yo\'q');
        return r.audio;
    }));
    chain.push(named('yt-dlp', async (url, { dir }) => {
        const f = await ytdlp.downloadAudio(url, platform, dir);
        return { path: f.path, title: f.title };
    }));
    chain.push(named('cobalt', async (url, { dir }) => {
        const r = await cobalt(url, { dir, audioOnly: true });
        return { url: r.items[0].url };
    }));
    return chain;
}

module.exports = { chainFor, audioChainFor };

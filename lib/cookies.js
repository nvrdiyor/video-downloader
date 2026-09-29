const fs = require('fs');
const path = require('path');

// Cobalt formatidagi cookies.json: { "instagram": ["sessionid=...; csrftoken=...; ds_user_id=..."] }
const COBALT_COOKIES_PATH = process.env.COBALT_COOKIES_PATH || '/root/cobalt/cookies.json';
const COOKIES_DIR = path.join(__dirname, '..', 'cookies');

const DOMAINS = {
    instagram: '.instagram.com',
    youtube: '.youtube.com',
    tiktok: '.tiktok.com',
    pinterest: '.pinterest.com',
};

function readCobaltCookies(service) {
    try {
        const data = JSON.parse(fs.readFileSync(COBALT_COOKIES_PATH, 'utf8'));
        const list = data[service];
        if (Array.isArray(list) && list.length) return list;
    } catch (e) {}
    return [];
}

// Instagram cookie qatori ("name=value; name2=value2")
function getInstagramCookie() {
    if (process.env.INSTAGRAM_COOKIE) return process.env.INSTAGRAM_COOKIE.trim();
    const list = readCobaltCookies('instagram');
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
}

function cookieStringToNetscape(str, domain) {
    const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const lines = ['# Netscape HTTP Cookie File'];
    for (const part of str.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 1) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        lines.push([domain, 'TRUE', '/', 'TRUE', expiry, name, value].join('\t'));
    }
    return lines.join('\n') + '\n';
}

// yt-dlp uchun Netscape formatidagi cookie faylini tayyorlash.
// Har bir so'rov uchun nusxa olinadi, chunki yt-dlp faylni qayta yozadi.
function netscapeFileFor(platform, dir) {
    const envFile = process.env[`${platform.toUpperCase()}_COOKIES_FILE`];
    const candidates = [envFile, path.join(COOKIES_DIR, `${platform}.txt`)].filter(Boolean);
    const target = path.join(dir, 'cookies.txt');

    for (const file of candidates) {
        if (fs.existsSync(file)) {
            fs.copyFileSync(file, target);
            return target;
        }
    }

    if (platform === 'instagram') {
        const cookie = getInstagramCookie();
        if (cookie) {
            fs.writeFileSync(target, cookieStringToNetscape(cookie, DOMAINS.instagram));
            return target;
        }
    }
    return null;
}

module.exports = { getInstagramCookie, netscapeFileFor };

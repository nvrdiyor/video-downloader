require('dotenv').config();
process.env.NTBA_FIX_350 = process.env.NTBA_FIX_350 || '1';
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { detectPlatform, extractUrl, fetchMedia, fetchAudio } = require('./lib/downloader');
const { makeWorkDir, removeDir, createLimiter, MAX_UPLOAD, TMP_ROOT } = require('./lib/utils');
const ytdlp = require('./lib/ytdlp');

// Token .env faylidan olinadi
const token = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const botOptions = { polling: true };
// Lokal Telegram Bot API server (2GB gacha fayllar uchun), ixtiyoriy
if (process.env.TELEGRAM_API_URL) botOptions.baseApiUrl = process.env.TELEGRAM_API_URL;
const bot = new TelegramBot(token, botOptions);

// Users faylini saqlash
const USERS_FILE = path.join(__dirname, 'users.json');

// Post rejimida turgan adminlar
const postMode = new Set();

// ==================== FOYDALANUVCHILAR BOSHQARUVI ====================

// Foydalanuvchilarni yuklash (avtomatik migratsiya bilan)
function loadUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        const parsed = JSON.parse(data);

        // Eski formatdan yangi formatga migratsiya: [123] → [{id: 123, status: "active"}]
        if (parsed.length > 0 && typeof parsed[0] === 'number') {
            const migrated = parsed.map(id => ({ id, status: 'active' }));
            fs.writeFileSync(USERS_FILE, JSON.stringify(migrated, null, 2));
            console.log(`✅ ${migrated.length} ta foydalanuvchi yangi formatga migrate qilindi.`);
            return migrated;
        }

        return parsed;
    } catch (err) {
        return [];
    }
}

// Foydalanuvchini saqlash (yangi format)
function saveUser(chatId) {
    const users = loadUsers();
    const existing = users.find(u => u.id === chatId);
    if (!existing) {
        users.push({ id: chatId, status: 'active' });
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } else if (existing.status === 'blocked') {
        // Agar oldin bloklagan bo'lsa va endi qayta yozsa — active qilish
        existing.status = 'active';
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    }
}

// Foydalanuvchi statusini yangilash
function updateUserStatus(chatId, status) {
    const users = loadUsers();
    const user = users.find(u => u.id === chatId);
    if (user) {
        user.status = status;
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    }
}

// Statistikani olish
function getStats() {
    const users = loadUsers();
    const total = users.length;
    const active = users.filter(u => u.status === 'active').length;
    const blocked = users.filter(u => u.status === 'blocked').length;
    return { total, active, blocked };
}

// ==================== ADMIN FUNKSIYALARI ====================

// Admin tekshirish
function isAdmin(userId) {
    return userId === ADMIN_ID;
}

// Admin uchun klaviatura
function getAdminKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '📢 Post' }, { text: '📊 Statistika' }],
            ],
            resize_keyboard: true
        }
    };
}

// Post rejimidagi klaviatura
function getPostKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                [{ text: '❌ Bekor qilish' }],
            ],
            resize_keyboard: true
        }
    };
}

// Barcha faol foydalanuvchilarga xabar yuborish (broadcast)
async function broadcast(msg) {
    const users = loadUsers();
    const activeUsers = users.filter(u => u.status === 'active');
    let success = 0;
    let fail = 0;
    let newBlocked = 0;

    for (const user of activeUsers) {
        try {
            if (msg.text) {
                await bot.sendMessage(user.id, msg.text);
            } else if (msg.photo) {
                const photo = msg.photo[msg.photo.length - 1].file_id;
                await bot.sendPhoto(user.id, photo, { caption: msg.caption || '' });
            } else if (msg.video) {
                await bot.sendVideo(user.id, msg.video.file_id, { caption: msg.caption || '' });
            } else if (msg.document) {
                await bot.sendDocument(user.id, msg.document.file_id, { caption: msg.caption || '' });
            } else if (msg.animation) {
                await bot.sendAnimation(user.id, msg.animation.file_id, { caption: msg.caption || '' });
            } else if (msg.sticker) {
                await bot.sendSticker(user.id, msg.sticker.file_id);
            } else if (msg.voice) {
                await bot.sendVoice(user.id, msg.voice.file_id, { caption: msg.caption || '' });
            } else if (msg.audio) {
                await bot.sendAudio(user.id, msg.audio.file_id, { caption: msg.caption || '' });
            } else if (msg.video_note) {
                await bot.sendVideoNote(user.id, msg.video_note.file_id);
            }
            success++;
        } catch (err) {
            fail++;
            // 403 Forbidden — foydalanuvchi botni bloklagan
            if (err.response && err.response.statusCode === 403) {
                updateUserStatus(user.id, 'blocked');
                newBlocked++;
            }
        }
    }

    return { success, fail, newBlocked };
}

// Matn broadcast (faqat /send uchun)
async function broadcastText(text) {
    const users = loadUsers();
    const activeUsers = users.filter(u => u.status === 'active');
    let success = 0;
    let fail = 0;
    let newBlocked = 0;

    for (const user of activeUsers) {
        try {
            await bot.sendMessage(user.id, text, { parse_mode: 'HTML' });
            success++;
        } catch (err) {
            fail++;
            if (err.response && err.response.statusCode === 403) {
                updateUserStatus(user.id, 'blocked');
                newBlocked++;
            }
        }
    }

    return { success, fail, newBlocked };
}

// ==================== YUKLASH VA YUBORISH ====================

const CAPTION = '<a href="https://t.me/pinterest_downloader_uzbot">pinterest_downloader_uzbot</a> dan yuklandi';

// Bir vaqtda ishlaydigan yuklashlar soni (server yuklanib qolmasligi uchun)
const limit = createLimiter(parseInt(process.env.MAX_CONCURRENT_JOBS || '4', 10));

// "Musiqasini yuklash" tugmasi uchun ma'lumotlar (callback_data 64 baytdan oshmasligi kerak)
const audioCache = new Map();
const AUDIO_CACHE_MAX = 5000;

function rememberAudio(entry) {
    const id = Math.random().toString(36).slice(2, 10);
    audioCache.set(id, entry);
    while (audioCache.size > AUDIO_CACHE_MAX) {
        audioCache.delete(audioCache.keys().next().value);
    }
    return id;
}

function audioKeyboard(id) {
    return { inline_keyboard: [[{ text: '🎵 Musiqasini yuklab olish', callback_data: `a:${id}` }]] };
}

function formatMb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Bitta faylni turiga qarab yuborish (xato bo'lsa — hujjat sifatida)
async function sendSingle(chatId, file, { caption, replyMarkup } = {}) {
    const options = {};
    if (caption) { options.caption = caption; options.parse_mode = 'HTML'; }
    if (replyMarkup) options.reply_markup = replyMarkup;
    try {
        if (file.type === 'photo') return await bot.sendPhoto(chatId, file.path, options);
        if (file.type === 'animation') return await bot.sendAnimation(chatId, file.path, options);
        return await bot.sendVideo(chatId, file.path, { ...options, supports_streaming: true });
    } catch (e) {
        console.error(`${file.type} yuborishda xato, hujjat sifatida yuborilmoqda:`, e.message);
        return await bot.sendDocument(chatId, file.path, options);
    }
}

// Fayllarni yuborish: bitta bo'lsa oddiy, ko'p bo'lsa 10 tadan albom qilib
async function sendFiles(chatId, files, replyMarkup) {
    if (files.length === 1) {
        await sendSingle(chatId, files[0], { caption: CAPTION, replyMarkup });
        return;
    }

    const groupable = files.filter(f => f.type === 'photo' || f.type === 'video');
    const others = files.filter(f => !groupable.includes(f));
    let captionUsed = false;
    const nextCaption = () => {
        if (captionUsed) return undefined;
        captionUsed = true;
        return CAPTION;
    };

    for (let i = 0; i < groupable.length; i += 10) {
        const chunk = groupable.slice(i, i + 10);
        if (chunk.length === 1) {
            await sendSingle(chatId, chunk[0], { caption: nextCaption() });
            continue;
        }
        const caption = nextCaption();
        const media = chunk.map((f, idx) => {
            const m = { type: f.type, media: f.path };
            if (idx === 0 && caption) { m.caption = caption; m.parse_mode = 'HTML'; }
            if (f.type === 'video') m.supports_streaming = true;
            return m;
        });
        try {
            await bot.sendMediaGroup(chatId, media);
        } catch (e) {
            console.error('Albom yuborishda xato, bittadan yuborilmoqda:', e.message);
            for (let j = 0; j < chunk.length; j++) {
                try {
                    await sendSingle(chatId, chunk[j], { caption: j === 0 ? caption : undefined });
                } catch (err) {
                    console.error('Faylni yuborishda xato:', err.message);
                }
            }
        }
    }

    for (const f of others) {
        try {
            await sendSingle(chatId, f, { caption: nextCaption() });
        } catch (e) {
            console.error('Faylni yuborishda xato:', e.message);
        }
    }

    if (replyMarkup) {
        await bot.sendMessage(chatId, '🎵 Musiqasini ham yuklab olishingiz mumkin:', { reply_markup: replyMarkup });
    }
}

async function sendAudioFile(chatId, audio, replyTo) {
    const title = audio.title || 'audio';
    const options = { caption: CAPTION, parse_mode: 'HTML', title };
    if (audio.performer) options.performer = audio.performer;
    if (replyTo) options.reply_to_message_id = replyTo;
    const safeName = `${title}`.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) || 'audio';
    const ext = path.extname(audio.path) || '.mp3';
    await bot.sendAudio(chatId, audio.path, options, { filename: `${safeName}${ext}`, contentType: ext === '.mp3' ? 'audio/mpeg' : undefined });
}

// Link bo'yicha yuklab olib, foydalanuvchiga yuborish
async function handleLink(msg, url, platform) {
    const chatId = msg.chat.id;
    const status = await bot.sendMessage(chatId, 'Kuting, yuklanmoqda... ⏳', {
        reply_to_message_id: msg.message_id,
    }).catch(() => null);
    const workDir = makeWorkDir();

    try {
        await limit(async () => {
            bot.sendChatAction(chatId, 'upload_video').catch(() => {});
            const result = await fetchMedia(url, platform, workDir);
            const hasVideo = result.files.some(f => f.type === 'video');

            // Rasmli post (slayd-shou) + musiqa — musiqani avtomatik yuboramiz,
            // video bo'lsa — "Musiqasini yuklab olish" tugmasi
            const autoAudio = !hasVideo && !!result.audio;
            let replyMarkup;
            if (!autoAudio && (hasVideo || result.audio)) {
                replyMarkup = audioKeyboard(rememberAudio({ url, platform, audio: result.audio }));
            }

            if (result.files.length) {
                await sendFiles(chatId, result.files, replyMarkup);
            }

            if (result.tooLarge.length) {
                const lines = result.tooLarge.map(t => {
                    const size = t.size ? ` (${formatMb(t.size)})` : '';
                    return t.url ? `• <a href="${t.url.replace(/"/g, '&quot;')}">Yuklab olish havolasi</a>${size}` : `• Fayl${size}`;
                });
                await bot.sendMessage(chatId,
                    `⚠️ Fayl Telegram limitidan (${formatMb(MAX_UPLOAD)}) katta, shuning uchun to'g'ridan-to'g'ri yubora olmadim:\n${lines.join('\n')}`,
                    { parse_mode: 'HTML', disable_web_page_preview: true });
            }

            if (autoAudio) {
                try {
                    bot.sendChatAction(chatId, 'upload_voice').catch(() => {});
                    const audio = await fetchAudio(url, platform, workDir, result.audio);
                    await sendAudioFile(chatId, audio);
                } catch (e) {
                    console.error('Musiqani yuborishda xato:', e.message);
                }
            }
        });
    } catch (e) {
        console.error(`Yuklash xatosi [${platform}] ${url}:`, e.message);
        await bot.sendMessage(chatId, e.userMessage
            ? `😔 ${e.userMessage}`
            : "😔 Kechirasiz, bu linkdan yuklab bo'lmadi. Link to'g'riligini tekshiring yoki birozdan keyin qayta urinib ko'ring.")
            .catch(() => {});
    } finally {
        removeDir(workDir);
        if (status) bot.deleteMessage(chatId, status.message_id).catch(() => {});
    }
}

// "🎵 Musiqasini yuklab olish" tugmasi
bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const chatId = query.message && query.message.chat.id;
    if (!data.startsWith('a:') || !chatId) {
        return bot.answerCallbackQuery(query.id).catch(() => {});
    }

    const entry = audioCache.get(data.slice(2));
    if (!entry) {
        return bot.answerCallbackQuery(query.id, {
            text: 'Muddati o\'tgan. Linkni qaytadan yuboring.',
            show_alert: true,
        }).catch(() => {});
    }

    bot.answerCallbackQuery(query.id, { text: '🎵 Musiqa yuklanmoqda...' }).catch(() => {});
    const workDir = makeWorkDir();
    try {
        await limit(async () => {
            bot.sendChatAction(chatId, 'upload_voice').catch(() => {});
            const audio = await fetchAudio(entry.url, entry.platform, workDir, entry.audio);
            await sendAudioFile(chatId, audio, query.message.message_id);
        });
    } catch (e) {
        console.error('Audio xatosi:', e.message);
        bot.sendMessage(chatId, `😔 ${e.userMessage || "Musiqani yuklab bo'lmadi."}`).catch(() => {});
    } finally {
        removeDir(workDir);
    }
});

// ==================== BOT XABAR HANDLER ====================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // Foydalanuvchini saqlash
    saveUser(chatId);

    // ---- ADMIN KOMANDALAR ----
    if (isAdmin(userId)) {
        // "Bekor qilish" — har doim ishlaydi
        if (text === '❌ Bekor qilish') {
            postMode.delete(userId);
            return bot.sendMessage(chatId, "✅ Post bekor qilindi.", getAdminKeyboard());
        }

        // "📊 Statistika" tugmasi yoki /stat komandasi
        if (text === '📊 Statistika' || text === '/stat' || text === '/stats') {
            const stats = getStats();
            return bot.sendMessage(chatId,
                `📊 Statistika:\n\n👥 Jami: ${stats.total}\n✅ Faol: ${stats.active}\n🚫 Bloklagan: ${stats.blocked}`,
                getAdminKeyboard()
            );
        }

        // /send komandasi
        if (text && text.startsWith('/send ')) {
            const sendText = text.slice(6).trim();
            if (!sendText) {
                return bot.sendMessage(chatId, "❌ Matn kiriting: /send [matn]", getAdminKeyboard());
            }
            const statusMsg = await bot.sendMessage(chatId, "📤 Xabar tarqatilmoqda...");
            const result = await broadcastText(sendText);
            await bot.editMessageText(
                `✅ Xabar tarqatildi!\n\n📊 Natija:\n✅ Muvaffaqiyatli: ${result.success}\n❌ Xatolik: ${result.fail}\n🚫 Yangi bloklagan: ${result.newBlocked}`,
                { chat_id: chatId, message_id: statusMsg.message_id }
            );
            return;
        }

        // "📢 Post" tugmasi
        if (text === '📢 Post') {
            postMode.add(userId);
            const stats = getStats();
            return bot.sendMessage(chatId,
                `📢 Post rejimi yoqildi!\n\n👥 Faol foydalanuvchilar: ${stats.active}\n🚫 Bloklagan: ${stats.blocked}\n\nPostni yuboring (matn, rasm, video, fayl).\n❌ Bekor qilish uchun tugmani bosing.`,
                getPostKeyboard()
            );
        }

        // Post rejimida — xabarni broadcast qilish
        if (postMode.has(userId)) {
            postMode.delete(userId);
            const statusMsg = await bot.sendMessage(chatId, "📤 Post tarqatilmoqda...");
            const result = await broadcast(msg);
            await bot.editMessageText(
                `✅ Post yuborildi!\n\n📊 Natija:\n✅ Muvaffaqiyatli: ${result.success}\n❌ Xatolik: ${result.fail}\n🚫 Yangi bloklagan: ${result.newBlocked}`,
                { chat_id: chatId, message_id: statusMsg.message_id }
            );
            return bot.sendMessage(chatId, "Davom eting:", getAdminKeyboard());
        }
    }

    // ---- /start KOMANDASI ----
    if (text === '/start') {
        if (isAdmin(userId)) {
            return bot.sendMessage(chatId,
                "Salom Admin! 👋\nMenga Instagram, TikTok, Pinterest yoki YouTube linkini yuboring.\n\n📢 Post — barcha foydalanuvchilarga xabar\n📊 Statistika — foydalanuvchilar soni\n/send [matn] — matn tarqatish",
                getAdminKeyboard()
            );
        }
        return bot.sendMessage(chatId, "Salom! Menga Instagram, TikTok, Pinterest yoki YouTube linkini yuboring.");
    }

    if (!text) return;

    // ---- LINK QAYTA ISHLASH ----
    const isPrivate = msg.chat.type === 'private';
    const url = extractUrl(text);

    if (!url) {
        if (isPrivate) bot.sendMessage(chatId, "Iltimos, Instagram, TikTok, Pinterest yoki YouTube linkini yuboring!");
        return;
    }

    const platform = detectPlatform(url);
    if (!platform) {
        if (isPrivate) bot.sendMessage(chatId, "Men faqat Instagram, TikTok, Pinterest va YouTube linklarini qabul qilaman.");
        return;
    }

    handleLink(msg, url, platform);
});

bot.on('polling_error', (err) => {
    console.error('Polling xatosi:', err.code, err.message);
});

// ==================== ISHGA TUSHIRISH ====================

// Eski vaqtinchalik fayllarni tozalash
removeDir(TMP_ROOT);
fs.mkdirSync(TMP_ROOT, { recursive: true });

// yt-dlp ni tayyorlash va har kuni yangilab turish
ytdlp.ensure().then((ok) => {
    if (!ok) return;
    ytdlp.update();
    setInterval(() => ytdlp.update(), 24 * 60 * 60 * 1000);
});

console.log('Bot ishga tushdi...');

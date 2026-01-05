const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

/* ================= ENV ================= */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SERVER_URL = process.env.SERVER_URL;

if (!TELEGRAM_TOKEN || !SERVER_URL) {
    console.error('❌ TELEGRAM_TOKEN or SERVER_URL missing');
    process.exit(1);
}

/* ================= BOT ================= */
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Telegram bot started');

/* ================= USER STATE ================= */
const userState = new Map();

function getState(userId) {
    if (!userState.has(userId)) {
        userState.set(userId, { cwd: '/', uploadTarget: null });
    }
    return userState.get(userId);
}

/* ================= HELP ================= */
const HELP_TEXT = `
📂 *MEGA File Bot Commands*

pwd  
ls  
cd <folder>  
cd ..  

upload  
download <file>  

mv <source> <destination>  
cp <source> <destination>  

help
`;

/* ================= COMMAND HANDLER ================= */
bot.on('message', async (msg) => {
    if (!msg.text) return;

    const userId = msg.chat.id;
    const text = msg.text.trim();
    const args = text.split(/\s+/);
    const cmd = args[0].toLowerCase();

    const state = getState(userId);

    try {
        switch (cmd) {
            case 'help':
                return bot.sendMessage(userId, HELP_TEXT, { parse_mode: 'Markdown' });

            case 'pwd':
                return bot.sendMessage(userId, `📍 ${state.cwd}`);

            case 'ls': {
                const res = await axios.get(`${SERVER_URL}/list`, {
                    params: { folder: state.cwd }
                });

                if (!res.data.files.length) {
                    return bot.sendMessage(userId, '📁 Empty folder');
                }

                const out = res.data.files.map(f =>
                    f.isFolder ? `📂 ${f.name}` : `📄 ${f.name} (${f.size}b)`
                ).join('\n');

                return bot.sendMessage(userId, out);
            }

            case 'cd': {
                if (!args[1]) {
                    return bot.sendMessage(userId, '❌ cd <folder>');
                }

                if (args[1] === '..') {
                    state.cwd = path.posix.dirname(state.cwd);
                    if (state.cwd === '.') state.cwd = '/';
                    return bot.sendMessage(userId, `📂 ${state.cwd}`);
                }

                const target = path.posix.join(state.cwd, args[1]);
                await axios.get(`${SERVER_URL}/list`, { params: { folder: target } });

                state.cwd = target;
                return bot.sendMessage(userId, `📂 ${state.cwd}`);
            }

            case 'upload':
                state.uploadTarget = state.cwd;
                return bot.sendMessage(userId, '📤 Send the file now');

            case 'download': {
                if (!args[1]) {
                    return bot.sendMessage(userId, '❌ download <file>');
                }

                const res = await axios.get(`${SERVER_URL}/list`, {
                    params: { folder: state.cwd }
                });

                const file = res.data.files.find(
                    f => f.name === args[1] && !f.isFolder
                );

                if (!file) {
                    return bot.sendMessage(userId, '❌ File not found');
                }

                return bot.sendDocument(
                    userId,
                    `${SERVER_URL}/download/${file.handle}`
                );
            }

            case 'mv':
            case 'cp': {
                if (args.length < 3) {
                    return bot.sendMessage(userId, `❌ ${cmd} <src> <dest>`);
                }

                const endpoint = cmd === 'mv' ? 'move' : 'copy';

                await axios.post(`${SERVER_URL}/${endpoint}`, {
                    source: args[1],
                    destination: path.posix.join(state.cwd, args[2])
                });

                return bot.sendMessage(userId, `✅ ${cmd} successful`);
            }

            default:
                return bot.sendMessage(userId, '❓ Unknown command. Type `help`');
        }
    } catch (err) {
        return bot.sendMessage(userId, `❌ Error: ${err.message}`);
    }
});

/* ================= FILE UPLOAD HANDLER ================= */
bot.on('document', async (msg) => {
    const userId = msg.chat.id;
    const state = getState(userId);

    if (!state.uploadTarget) return;

    const fileId = msg.document.file_id;
    const fileInfo = await bot.getFile(fileId);

    const tempDir = path.join(__dirname, 'tmp');
    fs.mkdirSync(tempDir, { recursive: true });

    const localPath = path.join(tempDir, msg.document.file_name);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

    const response = await axios.get(fileUrl, { responseType: 'stream' });
    response.data.pipe(fs.createWriteStream(localPath));

    response.data.on('end', async () => {
        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(localPath));
            form.append('folder', state.uploadTarget);
            form.append('filename', msg.document.file_name);

            await axios.post(`${SERVER_URL}/upload-book`, form, {
                headers: form.getHeaders()
            });

            bot.sendMessage(userId, '✅ Upload complete');
        } catch (err) {
            bot.sendMessage(userId, `❌ Upload failed: ${err.message}`);
        } finally {
            fs.unlinkSync(localPath);
            state.uploadTarget = null;
        }
    });
});


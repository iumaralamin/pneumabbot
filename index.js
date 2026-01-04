const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // Your Telegram bot token
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'; // Your bookserver URL

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ------------------- User State -------------------
const userStates = new Map();

function getUserState(userId) {
    if (!userStates.has(userId)) {
        userStates.set(userId, { cwd: '/', uploadingFile: null });
    }
    return userStates.get(userId);
}

// ------------------- Command Handler -------------------
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const text = msg.text?.trim();
    if (!text) return;

    const state = getUserState(userId);
    const args = text.split(/\s+/);
    const cmd = args[0].toLowerCase();

    try {
        switch (cmd) {

            case '/help':
                bot.sendMessage(userId, `📖 *Supported Commands:*
                
🔹 pwd — Show current folder
🔹 ls — List files/folders in current folder
🔹 cd <folder> — Change directory (use .. for parent)
🔹 upload <filename> — Upload a file to current folder
🔹 download <filename> — Download a file from current folder
🔹 mv <source> <dest> — Move a file or folder
🔹 cp <source> <dest> — Copy a file or folder
🔹 /help — Show this help message
                `, { parse_mode: 'Markdown' });
                break;

            // ------------------- Navigation -------------------
            case 'pwd':
                bot.sendMessage(userId, `📂 Current directory: ${state.cwd}`);
                break;

            case 'ls':
                {
                    const resp = await axios.get(`${SERVER_URL}/list`, { params: { userId, folder: state.cwd } });
                    if (!resp.data.files || resp.data.files.length === 0) {
                        bot.sendMessage(userId, '📁 Folder is empty.');
                        break;
                    }
                    let list = '';
                    resp.data.files.forEach(f => {
                        if (f.isFolder) list += `📂 ${f.name}\n`;
                        else list += `📄 ${f.name} (${f.size} bytes)\n`;
                    });
                    bot.sendMessage(userId, list);
                }
                break;

            case 'cd':
                {
                    if (!args[1]) return bot.sendMessage(userId, '❌ Usage: cd <folder>');
                    let target = args[1];
                    if (target === '..') {
                        state.cwd = path.posix.dirname(state.cwd);
                        if (state.cwd === '.') state.cwd = '/';
                    } else {
                        const resp = await axios.get(`${SERVER_URL}/list`, { params: { userId, folder: state.cwd } });
                        const folderExists = resp.data.files.some(f => f.isFolder && f.name === target);
                        if (!folderExists) return bot.sendMessage(userId, '❌ Folder not found');
                        state.cwd = path.posix.join(state.cwd, target);
                    }
                    bot.sendMessage(userId, `📂 Changed directory: ${state.cwd}`);
                }
                break;

            // ------------------- Upload -------------------
            case 'upload':
                {
                    const fileName = args[1];
                    if (!fileName) return bot.sendMessage(userId, '❌ Usage: upload <filename>');
                    state.uploadingFile = { name: fileName, folder: state.cwd };
                    bot.sendMessage(userId, '📤 Please send the file now.');
                }
                break;

            // ------------------- Download -------------------
            case 'download':
                {
                    const fileName = args[1];
                    if (!fileName) return bot.sendMessage(userId, '❌ Usage: download <filename>');

                    const resp = await axios.get(`${SERVER_URL}/list`, { params: { userId, folder: state.cwd } });
                    const file = resp.data.files.find(f => f.name === fileName && !f.isFolder);
                    if (!file) return bot.sendMessage(userId, '❌ File not found');

                    bot.sendMessage(userId, `⬇️ Downloading ${fileName}...`);
                    bot.sendDocument(userId, file.handle ? `${SERVER_URL}/download/${file.handle}` : null);
                }
                break;

            // ------------------- Move / Copy -------------------
            case 'mv':
            case 'cp':
                {
                    const [_, src, dest] = args;
                    if (!src || !dest) return bot.sendMessage(userId, `❌ Usage: ${cmd} <source> <dest>`);

                    try {
                        const endpoint = cmd === 'mv' ? 'move' : 'copy';
                        const resp = await axios.post(`${SERVER_URL}/${endpoint}`, {
                            userId,
                            source: src,
                            destination: path.posix.join(state.cwd, dest)
                        });

                        if (resp.data.success) bot.sendMessage(userId, `✅ ${cmd} successful: ${resp.data.message}`);
                        else bot.sendMessage(userId, `❌ ${cmd} failed: ${resp.data.error}`);
                    } catch (err) {
                        bot.sendMessage(userId, `❌ ${cmd} error: ${err.message}`);
                    }
                }
                break;

            default:
                bot.sendMessage(userId, '❌ Unknown command. Type /help to see available commands.');
        }
    } catch (err) {
        bot.sendMessage(userId, `❌ Error: ${err.message}`);
    }
});

// ------------------- Handle actual file upload -------------------
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    const state = getUserState(userId);
    if (!state.uploadingFile) return;

    const fileId = msg.document.file_id;
    const fileInfo = await bot.getFile(fileId);
    const filePath = path.join(__dirname, 'temp', msg.document.file_name);

    fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const writer = fs.createWriteStream(filePath);
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    response.data.pipe(writer);

    writer.on('finish', async () => {
        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));
            form.append('filename', state.uploadingFile.name);
            form.append('description', '');
            form.append('userId', userId);
            form.append('folder', state.uploadingFile.folder);

            const uploadResp = await axios.post(`${SERVER_URL}/upload-book`, form, { headers: form.getHeaders() });
            if (uploadResp.data.success) {
                bot.sendMessage(userId, `✅ Upload successful!\nDownload URL: ${uploadResp.data.downloadUrl}`);
            } else bot.sendMessage(userId, `❌ Upload failed: ${uploadResp.data.error}`);

            fs.unlinkSync(filePath);
            state.uploadingFile = null;
        } catch (err) {
            bot.sendMessage(userId, `❌ Upload error: ${err.message}`);
            state.uploadingFile = null;
        }
    });

    writer.on('error', (err) => {
        bot.sendMessage(userId, `❌ Error downloading file: ${err.message}`);
        state.uploadingFile = null;
    });
});

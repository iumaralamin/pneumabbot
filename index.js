
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// ------------------- ENV -------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SERVER_URL = process.env.SERVER_URL; // Your Mega server
const BOT_URL = process.env.BOT_URL;       // Your Render deployment URL

if (!TELEGRAM_TOKEN || !SERVER_URL || !BOT_URL) {
  console.error("❌ Please set TELEGRAM_TOKEN, SERVER_URL, and BOT_URL in .env");
  process.exit(1);
}

// ------------------- Bot Setup -------------------
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });
bot.setWebHook(`${BOT_URL}/bot${TELEGRAM_TOKEN}`);

// ------------------- Express -------------------
const app = express();
app.use(express.json());

app.post(`/bot${TELEGRAM_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot server running on port ${PORT}`));

// ------------------- User State -------------------
const userStates = new Map();
function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, { cwd: '/', uploadingFile: null });
  }
  return userStates.get(userId);
}

// ------------------- Help Text -------------------
const HELP_TEXT = `📂 MEGA File Bot Commands (Full Explanation)

🔹 /start
  Starts the bot and shows this help message.

🔹 help
  Shows all commands with explanations.

🔹 pwd
  Shows the current folder path.

🔹 ls
  Lists all files and folders in the current directory.
  If the folder is empty, shows 'Folder is empty'.

🔹 tree
  Shows the entire file system structure recursively from current folder.

🔹 cd <folder>
  Move into the specified folder.

🔹 cd ..
  Go up one directory.

🔹 mkdir <folder>
  Create a new folder in the current directory.

🔹 upload <filename>
  Upload a file to the current folder.
  After running this, send the file through Telegram.

🔹 download <file>
  Download a file from the current folder.

🔹 mv <source> <destination>
  Move a file/folder to another location.

🔹 cp <source> <destination>
  Copy a file/folder to another location.
`;

// ------------------- Bot Commands -------------------
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text?.trim();
  if (!text) return;

  const state = getUserState(userId);
  const args = text.split(/\s+/);
  const cmd = args[0].toLowerCase();

  try {
    switch (cmd) {

      // ------------------- Help / Start -------------------
      case '/start':
      case 'help':
        bot.sendMessage(userId, HELP_TEXT);
        break;

      // ------------------- Navigation -------------------
      case 'pwd':
        bot.sendMessage(userId, `📍 ${state.cwd}`);
        break;

      case 'ls':
        {
          const resp = await axios.get(`${SERVER_URL}/list`, { params: { userId, folder: state.cwd } });
          const files = resp.data.files || [];
          if (files.length === 0) {
            bot.sendMessage(userId, '📁 Folder is empty.');
            break;
          }
          let list = '';
          files.forEach(f => {
            list += f.isFolder ? `📂 ${f.name}\n` : `📄 ${f.name} (${f.size} bytes)\n`;
          });
          bot.sendMessage(userId, list);
        }
        break;

      case 'tree':
        {
          const buildTree = async (folder) => {
            const resp = await axios.get(`${SERVER_URL}/list`, { params: { userId, folder } });
            const files = resp.data.files || [];
            let result = '';
            for (const f of files) {
              if (f.isFolder) {
                result += `📂 ${path.posix.join(folder, f.name)}\n`;
                result += await buildTree(path.posix.join(folder, f.name));
              } else {
                result += `📄 ${path.posix.join(folder, f.name)} (${f.size} bytes)\n`;
              }
            }
            return result;
          };
          const treeOutput = await buildTree(state.cwd);
          bot.sendMessage(userId, treeOutput || '📁 Folder is empty.');
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

      // ------------------- Make Directory -------------------
      case 'mkdir':
        {
          const folderName = args[1];
          if (!folderName) return bot.sendMessage(userId, '❌ Usage: mkdir <folder>');
          try {
            const resp = await axios.post(`${SERVER_URL}/mkdir`, { userId, folder: state.cwd, name: folderName });
            if (resp.data.success) bot.sendMessage(userId, `✅ Folder created: ${folderName}`);
            else bot.sendMessage(userId, `❌ Failed to create folder: ${resp.data.error}`);
          } catch (err) {
            bot.sendMessage(userId, `❌ Error: ${err.message}`);
          }
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
        bot.sendMessage(userId, '❓ Unknown command. Type `help`');
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

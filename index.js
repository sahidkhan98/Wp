const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { 
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = 3000;

app.use(express.static('public'));
app.use(fileUpload());

const sessions = {}; // Session map

// Send messages from creds + file
app.post('/send-message', async (req, res) => {
  try {
    const { name, targetNumber, targetType, delayTime } = req.body;
    const sessionId = `${Date.now()}`;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    await fs.ensureDir(sessionPath);

    const credsPath = path.join(sessionPath, 'creds.json');
    const messagePath = path.join(sessionPath, 'message.txt');

    if (!req.files || !req.files.creds || !req.files.messageFile) {
      return res.status(400).send('Missing files.');
    }

    // Save creds.json
    await req.files.creds.mv(credsPath);

    // Save message file
    await req.files.messageFile.mv(messagePath);

    const messageLines = (await fs.readFile(messagePath, 'utf-8'))
      .split('\n')
      .filter(Boolean);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      version: await fetchLatestBaileysVersion().then(v => v.version),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error).output.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          await fs.remove(sessionPath);
        }
      }
    });

    sock.ev.on('messages.upsert', m => {}); // Placeholder

    await delay(5000);

    const jid = targetType === 'group' ? `${targetNumber}@g.us` : `${targetNumber}@s.whatsapp.net`;

    for (const line of messageLines) {
      const finalMessage = `*${name}:* ${line.trim()}`;
      await sock.sendMessage(jid, { text: finalMessage });
      await delay(parseInt(delayTime) * 1000);
    }

    sessions[sessionId] = sock;
    return res.send(`Message sent successfully. Your session ID: ${sessionId}`);

  } catch (err) {
    console.error("Error in send-message:", err);
    return res.status(500).send("Internal Server Error. Check console.");
  }
});

// Stop session
app.post('/stop-session/:id', async (req, res) => {
  const id = req.params.id;
  const session = sessions[id];
  if (session) {
    try {
      await session.logout();
      delete sessions[id];
      res.send('Session stopped successfully.');
    } catch (e) {
      res.status(500).send('Failed to stop session.');
    }
  } else {
    res.status(404).send('Session not found.');
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
    

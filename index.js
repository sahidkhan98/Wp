const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 3000;

// Middleware
app.use(fileUpload());
app.use(express.static('public')); // serve index.html from public
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Required to parse JSON responses

// In-memory store for active sessions
const activeSessions = {};

app.post('/send-message', async (req, res) => {
  try {
    const { name, targetNumber, targetType, delayTime } = req.body;
    const creds = req.files?.creds;
    const messageFile = req.files?.messageFile;

    if (!creds || !messageFile || !targetNumber || !targetType || !delayTime) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const sessionId = Date.now().toString(); // Unique session ID
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    await fs.ensureDir(sessionPath);

    const credsPath = path.join(sessionPath, 'creds.json');
    await creds.mv(credsPath);

    const messagePath = path.join(sessionPath, 'message.txt');
    await messageFile.mv(messagePath);

    const messageLines = (await fs.readFile(messagePath, 'utf-8'))
      .split('\n')
      .filter(line => line.trim() !== '');

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      browser: Browsers.macOS('Safari'),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    });

    // Save the socket to active sessions
    activeSessions[sessionId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`[✅] Session started: ${sessionId}`);

        try {
          for (let line of messageLines) {
            const fullMessage = `👤 ${name}\n\n${line.trim()}\n\n~ LEGEND MALICK 🔥`;
            const jid = targetType === 'group'
              ? `${targetNumber}@g.us`
              : `${targetNumber}@s.whatsapp.net`;

            await sock.sendMessage(jid, { text: fullMessage });
            console.log(`[📤] Sent to ${jid}: ${line.trim()}`);
            await delay(Number(delayTime) * 1000);
          }

          await sock.ws.close();
          delete activeSessions[sessionId];
          console.log(`[🔚] Session ended: ${sessionId}`);
        } catch (err) {
          console.error('Error while sending messages:', err);
        }
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(`[❌] Connection closed (${sessionId}): ${reason}`);
        delete activeSessions[sessionId];
      }
    });

    // ✅ Respond with session ID
    return res.json({ sessionId });

  } catch (err) {
    console.error("Main error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Stop session
app.post('/stop-session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const sessionSock = activeSessions[sessionId];

  if (sessionSock) {
    try {
      await sessionSock.ws.close();
      delete activeSessions[sessionId];

      const sessionPath = path.join(__dirname, 'sessions', sessionId);
      await fs.remove(sessionPath);

      return res.send(`Session ${sessionId} stopped and deleted successfully.`);
    } catch (err) {
      console.error("Error stopping session:", err);
      return res.status(500).send("Failed to stop the session.");
    }
  } else {
    return res.status(404).send("Session not found or already closed.");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

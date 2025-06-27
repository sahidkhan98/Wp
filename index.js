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
  Browsers,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 3000;

app.use(fileUpload());
app.use(express.static('public')); // To serve index.html
app.use(express.urlencoded({ extended: true }));

const activeSessions = {}; // ✅ Map to track active sessions

app.post('/send-message', async (req, res) => {
  try {
    const { name, targetNumber, targetType, delayTime } = req.body;
    const creds = req.files?.creds;
    const messageFile = req.files?.messageFile;

    if (!creds || !messageFile || !targetNumber || !targetType || !delayTime) {
      return res.status(400).send("Missing required fields");
    }

    const sessionId = Date.now().toString();
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
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }).child({ level: "silent" }))
      },
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      logger: pino({ level: 'silent' })
    });

    activeSessions[sessionId] = sock; // ✅ Save session

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log(`[✅] Session started: ${sessionId}`);
        try {
          for (let line of messageLines) {
            let fullMessage = `👤 ${name}\n\n${line.trim()}\n\n~ LEGEND MALICK 🔥`;

            const jid = targetType === "group"
              ? `${targetNumber}@g.us`
              : `${targetNumber}@s.whatsapp.net`;

            await sock.sendMessage(jid, { text: fullMessage });
            console.log(`[📤] Sent to ${jid}: ${line.trim()}`);
            await delay(Number(delayTime) * 1000);
          }

          await sock.ws.close();
          delete activeSessions[sessionId];
          return res.send(`Messages sent successfully! ✅\nSession ID: ${sessionId}`);
        } catch (err) {
          console.error("Send error:", err);
          return res.status(500).send("Error sending messages");
        }
      }

      if (connection === "close") {
        let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(`[❌] Connection closed (${sessionId}): ${reason}`);
        delete activeSessions[sessionId];
      }
    });

  } catch (err) {
    console.error("Main error:", err);
    res.status(500).send("Internal Server Error");
  }
});

// 🔴 Stop specific session
app.post('/stop-session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const sessionSock = activeSessions[sessionId];

  if (sessionSock) {
    try {
      await sessionSock.ws.close();
      delete activeSessions[sessionId];

      const sessionPath = path.join(__dirname, 'sessions', sessionId);
      await fs.remove(sessionPath);

      res.send(`Session ${sessionId} stopped and deleted successfully.`);
    } catch (err) {
      console.error("Error closing session:", err);
      res.status(500).send("Failed to stop the session.");
    }
  } else {
    res.status(404).send("Session not found or already closed.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

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
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// POST: /send-message
app.post('/send-message', async (req, res) => {
  try {
    const { name, targetNumber, targetType, delayTime } = req.body;
    const creds = req.files.creds;
    const messageFile = req.files.messageFile;

    if (!creds || !messageFile || !targetNumber || !targetType || !delayTime) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const sessionId = Date.now().toString();
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    await fs.ensureDir(sessionPath);

    await creds.mv(path.join(sessionPath, 'creds.json'));
    await messageFile.mv(path.join(sessionPath, 'message.txt'));

    const messageLines = (await fs.readFile(path.join(sessionPath, 'message.txt'), 'utf-8'))
      .split('\n')
      .filter(line => line.trim() !== '');

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        const jid = targetType === "group"
          ? `${targetNumber}@g.us`
          : `${targetNumber}@s.whatsapp.net`;

        for (let line of messageLines) {
          let fullMessage = `👤 ${name}\n\n${line.trim()}\n\n~ LEGEND MALICK 🔥`;
          await sock.sendMessage(jid, { text: fullMessage });
          console.log(`[📤] Sent: ${line.trim()}`);
          await delay(Number(delayTime) * 1000);
        }

        await sock.ws.close();
        return res.json({
          status: "success",
          sessionId,
          message: `✅ Messages sent to ${targetNumber}`
        });
      }

      if (connection === "close") {
        let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(`[❌] Connection closed: ${reason}`);
      }
    });

  } catch (err) {
    console.error("Error in send-message:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST: /stop-session/:id
app.post('/stop-session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const sessionPath = path.join(__dirname, 'sessions', sessionId);
  try {
    await fs.remove(sessionPath);
    res.send(`🗑️ Session ${sessionId} deleted.`);
  } catch (err) {
    res.status(500).send("Error deleting session");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

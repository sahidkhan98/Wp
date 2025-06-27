const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { exec } = require('child_process');

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
app.use(express.static('public')); // For index.html
app.use(express.urlencoded({ extended: true }));

// 💬 POST endpoint for sending WhatsApp messages
app.post('/send-message', async (req, res) => {
  try {
    const { name, targetNumber, targetType, delayTime } = req.body;
    const creds = req.files.creds;
    const messageFile = req.files.messageFile;

    if (!creds || !messageFile || !targetNumber || !targetType || !delayTime) {
      return res.status(400).send("Missing required fields");
    }

    const sessionId = Date.now().toString();
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    await fs.ensureDir(sessionPath);

    // Save creds.json file
    const credsPath = path.join(sessionPath, 'creds.json');
    await creds.mv(credsPath);

    // Save message file
    const messagePath = path.join(sessionPath, 'message.txt');
    await messageFile.mv(messagePath);

    const messageLines = (await fs.readFile(messagePath, 'utf-8'))
      .split('\n')
      .filter(line => line.trim() !== '');

    // Load Baileys with this creds
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
        console.log(`[✅] Session started for ${targetNumber}`);
        try {
          for (let line of messageLines) {
            let fullMessage = `👤 ${name}\n\n${line.trim()}\n\n~ LEGEND MALICK 🔥`;

            const jid = targetType === "group"
              ? `${targetNumber}@g.us`
              : `${targetNumber}@s.whatsapp.net`;

            await sock.sendMessage(jid, { text: fullMessage });
            console.log(`[📤] Sent: ${line.trim()}`);
            await delay(Number(delayTime) * 1000);
          }

          await sock.ws.close();
          return res.send(`Messages sent successfully to ${targetNumber}`);
        } catch (err) {
          console.error("Send error:", err);
          return res.status(500).send("Failed to send messages");
        }
      }

      if (connection === "close") {
        let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        console.log(`[❌] Connection closed: ${reason}`);
      }
    });

  } catch (err) {
    console.error("Error in send-message:", err);
    res.status(500).send("Internal Server Error");
  }
});

// 🔴 Stop session manually (optional)
app.post('/stop-session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const sessionPath = path.join(__dirname, 'sessions', sessionId);
  try {
    await fs.remove(sessionPath);
    res.send(`Session ${sessionId} deleted.`);
  } catch (err) {
    res.status(500).send("Error deleting session");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

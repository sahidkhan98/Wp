const express = require("express");
const fs = require("fs-extra");
const fileUpload = require("express-fileupload");
const path = require("path");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  delay
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 3000;

app.use(express.static("public"));
app.use(fileUpload());

const sessions = {}; // Session store

// API to send message from creds.json and message file
app.post("/send-message", async (req, res) => {
  try {
    const name = req.body.name;
    const number = req.body.targetNumber;
    const delayTime = parseInt(req.body.delayTime) * 1000;
    const targetType = req.body.targetType;

    const credsFile = req.files.creds;
    const messageFile = req.files.messageFile;

    const sessionId = Date.now().toString();
    const sessionPath = path.join(__dirname, "sessions", sessionId);
    await fs.ensureDir(sessionPath);

    // Save creds.json
    const authPath = path.join(sessionPath, "auth_info_baileys");
    await fs.ensureDir(authPath);
    await fs.writeFile(path.join(authPath, "creds.json"), credsFile.data);

    // Save messages
    const messages = messageFile.data.toString().split(/\r?\n/).filter(line => line.trim() !== "");

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      logger: pino({ level: "silent" })
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection } = update;
      if (connection === "close") {
        console.log(`Session ${sessionId} disconnected.`);
        delete sessions[sessionId];
      }
    });

    sessions[sessionId] = sock;

    (async () => {
      for (let i = 0; i < messages.length; i++) {
        const fullMsg = `*${name}:* ${messages[i]}`;
        const jid = targetType === "group" ? `${number}@g.us` : `${number}@s.whatsapp.net`;

        try {
          await sock.sendMessage(jid, { text: fullMsg });
          console.log(`[Sent] ${fullMsg}`);
          await delay(delayTime);
        } catch (err) {
          console.error("Error sending message:", err.message || err);
        }
      }
    })();

    res.send(`Session started: ${sessionId}`);
  } catch (err) {
    console.error("Error in send-message:", err);
    res.status(500).send("Something went wrong.");
  }
});

// API to stop a session by ID
app.post("/stop-session/:id", async (req, res) => {
  const sessionId = req.params.id;
  const session = sessions[sessionId];

  if (session) {
    try {
      await session.ws.close();
      delete sessions[sessionId];
      res.send("Session stopped successfully.");
    } catch (err) {
      console.error("Error stopping session:", err);
      res.status(500).send("Failed to stop session.");
    }
  } else {
    res.status(404).send("Session not found.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs-extra");
const path = require("path");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  delay,
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 3000;

app.use(express.static("public")); // for frontend HTML
app.use(fileUpload());

// Store active sessions
const sessions = {};

// Send message with uploaded creds
app.post("/send-message", async (req, res) => {
  try {
    const {
      name,
      targetNumber,
      targetType,
      delayTime
    } = req.body;

    const credsFile = req.files?.creds;
    const messageFile = req.files?.messageFile;

    if (!credsFile || !messageFile) return res.status(400).send("Missing files");

    const sessionId = Date.now().toString();
    const sessionPath = path.join(__dirname, "sessions", sessionId);

    await fs.ensureDir(sessionPath);
    await credsFile.mv(path.join(sessionPath, "creds.json"));
    await messageFile.mv(path.join(sessionPath, "message.txt"));

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
          console.log(`Session ${sessionId} disconnected, retrying...`);
        }
      }
    });

    await delay(4000);

    const jid = targetType === 'group' ? `${targetNumber}@g.us` : `${targetNumber}@s.whatsapp.net`;
    const lines = (await fs.readFile(path.join(sessionPath, "message.txt"), "utf-8"))
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const msg = `👹 *${name}* 👇\n` + lines[i];
      await sock.sendMessage(jid, { text: msg });
      await delay(parseInt(delayTime) * 1000);
    }

    sessions[sessionId] = sock;
    res.send(`Messages sent! Session ID: ${sessionId}`);

  } catch (err) {
    console.error("Error in send-message:", err);
    res.status(500).send("Error sending message.");
  }
});

// Stop session
app.post("/stop-session/:id", async (req, res) => {
  const sessionId = req.params.id;
  if (sessions[sessionId]) {
    await sessions[sessionId].logout();
    delete sessions[sessionId];
    res.send(`Session ${sessionId} stopped.`);
  } else {
    res.status(404).send("Session not found.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

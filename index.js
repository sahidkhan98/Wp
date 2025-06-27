const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const path = require("path");
const { makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const Pino = require("pino");
const app = express();
const PORT = 3000;

// Enable file upload & public folder
app.use(fileUpload());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

let sessions = {}; // To store all active sessions

// Route to serve the UI (index.html)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public/index.html"));
});

// Start Session & Send Messages
app.post("/send-message", async (req, res) => {
    try {
        const {
            name,
            targetNumber,
            targetType,
            delayTime
        } = req.body;

        const credsFile = req.files.creds;
        const messageFile = req.files.messageFile;

        const sessionId = Date.now().toString();
        const sessionPath = path.join(__dirname, "sessions", sessionId);

        await fs.promises.mkdir(sessionPath, { recursive: true });

        // Save creds.json
        await credsFile.mv(path.join(sessionPath, "creds.json"));

        // Save message file
        await messageFile.mv(path.join(sessionPath, "message.txt"));

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const sock = makeWASocket({
            auth: state,
            logger: Pino({ level: "silent" })
        });

        sock.ev.on("creds.update", saveCreds);
        sock.ev.on("connection.update", async (update) => {
            if (update.connection === "open") {
                const messageText = fs.readFileSync(path.join(sessionPath, "message.txt"), "utf-8");
                const lines = messageText.split("\n").filter(Boolean);

                const jid = targetType === "group"
                    ? `${targetNumber}@g.us`
                    : `${targetNumber}@s.whatsapp.net`;

                for (const line of lines) {
                    await sock.sendMessage(jid, { text: `*${name}:* ${line}` });
                    await new Promise(resolve => setTimeout(resolve, parseInt(delayTime) * 1000));
                }

                sessions[sessionId] = sock;
                res.send(`Message session started! Session ID: ${sessionId}`);
            }

            if (update.connection === "close") {
                console.log(`Session ${sessionId} disconnected`);
                delete sessions[sessionId];
            }
        });

    } catch (error) {
        console.error("Error in send-message:", error);
        res.status(500).send("Failed to send messages. Please check the inputs or session.");
    }
});

// Stop session by ID
app.post("/stop-session/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;

    if (sessions[sessionId]) {
        try {
            sessions[sessionId].end();
            delete sessions[sessionId];
            res.send(`Session ${sessionId} stopped successfully.`);
        } catch (e) {
            console.error("Error stopping session:", e);
            res.status(500).send("Error stopping session.");
        }
    } else {
        res.status(404).send("Session not found.");
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});

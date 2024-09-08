import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeInMemoryStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { makeWASocket } from "@whiskeysockets/baileys"; // Fixed import
import P from "pino";
import express from "express";
import fileUpload from "express-fileupload";
import cors from "cors";
import bodyParser from "body-parser";
import { Boom } from "@hapi/boom";
import path from "path";
import fs, { existsSync } from "fs";
import http from "http";
import { Server as SocketIOServer } from "socket.io"; // Corrected import name
import qrcode from "qrcode";
import { fileURLToPath } from "url";

import { GoogleGenerativeAI } from "@google/generative-ai";
import Messages from "./models/Message.js";
import db from "./utils/db.js";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

// Access your API key as an environment variable (see "Set up your API key" above)
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-flash",
});

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
}); // Initialize Socket.IO server
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jsonFilePath = path.join(__dirname, "schoolData.json");

app.use("/assets", express.static(path.join(__dirname, "client", "assets")));

// Middleware Configuration
app.use(
  fileUpload({
    createParentPath: true,
  })
);
// Daftar domain yang diizinkan
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:8000",
  "https://smk-icb.vercel.app",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
        // Jika origin ada dalam daftar yang diizinkan atau tidak ada origin (misalnya untuk permintaan dari server ke server)
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.get("/scan", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "server.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

// Utility Functions
const capitalize = (text) => {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

// Baileys Store
const store = makeInMemoryStore({
  logger: P().child({ level: "silent", stream: "store" }),
});

let sock;
let qrCode;
let currentSocket;

async function run(prompt) {
  try {
    console.log("Sending request to AI with prompt:", prompt);
    const result = await model.generateContent(prompt);
    console.log("Received response from AI:", result);

    // Pastikan untuk memeriksa struktur respons
    if (
      result &&
      result.response &&
      typeof result.response.text === "function"
    ) {
      // Panggil fungsi `text` untuk mendapatkan hasilnya
      const text = await result.response.text();
      console.log("Extracted text from AI response:", text);
      return text;
    } else {
      throw new Error("AI response text function not found or not callable");
    }
  } catch (error) {
    console.error("Error during AI interaction:", error);
    return "Maaf, saya tidak dapat menjawab pertanyaan Anda saat ini."; // Fallback message
  }
}

// Fungsi untuk memuat data sekolah dari JSON
const loadSchoolData = () => {
  try {
    const data = fs.readFileSync(jsonFilePath);
    return JSON.parse(data);
  } catch (error) {
    console.error("Error loading school data:", error);
    return {};
  }
};

// Fungsi untuk menghapus folder session secara otomatis
const deleteSessionFolder = (folderPath) => {
  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
    console.log(`Folder ${folderPath} berhasil dihapus.`);
  } else {
    console.log(`Folder ${folderPath} tidak ditemukan.`);
  }
};

// WhatsApp Connection Function
const connectToWhatsApp = async () => {
  // Path folder session
  const sessionFolderPath = path.join(__dirname, "baileys_auth_info");

  // Hapus folder sesi sebelum memulai koneksi baru
  // Only delete the folder if there’s a reason to reset the session
  if (!fs.existsSync(sessionFolderPath)) {
    deleteSessionFolder(sessionFolderPath);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolderPath);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: P({ level: "silent" }),
    version,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
    browser: "Desktop",
    syncFullHistory: true,
  });
  store.bind(sock.ev);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      updateQR("qr");
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      switch (reason) {
        case DisconnectReason.badSession:
          console.log(`Bad Session File, Please Delete session and Scan Again`);
          deleteSessionFolder(sessionFolderPath); // Hapus folder sesi jika sesi rusak
          await sock.logout();
          break;
        case DisconnectReason.connectionClosed:
          console.log("Connection closed, reconnecting....");
          connectToWhatsApp();
          break;
        case DisconnectReason.connectionLost:
          console.log("Connection Lost from Server, reconnecting...");
          connectToWhatsApp();
          break;
        case DisconnectReason.connectionReplaced:
          console.log(
            "Connection Replaced, Another New Session Opened, Please Close Current Session First"
          );
          await sock.logout();
          break;
        case DisconnectReason.loggedOut:
          console.log(
            `Device Logged Out, Please Delete session and Scan Again.`
          );
          deleteSessionFolder(sessionFolderPath); // Hapus folder sesi saat logout
          await sock.logout();
          break;
        case DisconnectReason.restartRequired:
          console.log("Restart Required, Restarting...");
          connectToWhatsApp();
          break;
        case DisconnectReason.timedOut:
          console.log("Connection TimedOut, Reconnecting...");
          connectToWhatsApp();
          break;
        default:
          console.log(`Unknown Disconnect`);
          await sock.end();
      }
    } else if (connection === "open") {
      console.log("WhatsApp connected");
      updateQR("connect");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Fungsi untuk menghubungkan dengan WhatsApp
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    const phone = msg.key.remoteJid;

    if (msg.message.conversation) {
      const pesan = msg.message.conversation.toLowerCase();

      try {
        await db.connect();

        // Simpan pesan ke MongoDB
        await Messages.findOneAndUpdate(
          { phone },
          { $push: { messages: pesan } },
          { upsert: true, new: true }
        );

        // Ambil riwayat pesan sebelumnya (5 pesan terakhir)
        const history = await Messages.findOne({ phone });
        const previousMessages = history
          ? history.messages.slice(-5).join("\n")
          : "";

        const schoolData = loadSchoolData();
        // Integrasi dengan instruksi sistem untuk pemrosesan AI
        const prompt = `You are an AI assistant for ${schoolData.NamaSekolah}.
    Here is the school data: ${JSON.stringify(schoolData)}
    The user asked: ${messages}
    Provide a relevant response based on this information. If the question is out of scope, reply with "Sorry, I can only assist with school-related inquiries."  ,${previousMessages}\n\nUser: ${pesan}\nAI:`;

        const aiResponse = await run(prompt);

        // Kirim pesan ke pengguna
        await sock.sendMessage(phone, { text: aiResponse });
      } catch (error) {
        console.error("Error processing message:", error);
        await sock.sendMessage(phone, {
          text: "Maaf, saya tidak dapat menjawab pertanyaan Anda saat ini.",
        });
      }
    }
  });
};

//   sock.ev.on("messages.upsert", async ({ messages }) => {
//     const msg = messages[0];
//     const phone = msg.key.remoteJid;

//     if (msg.message.conversation) {
//       const pesan = msg.message.conversation;
//       console.log(`Pesan masuk: ${pesan} - Dari: ${phone}`);

//       try {
//         // Periksa status pengirim
//         if (!userStatus[phone]) {
//           // Pesan pertama
//           userStatus[phone] = { firstMessageSent: true };
//           const response =
//             "Hallo saya AI Ampas, saat ini Ricky masih tidur. Jika ingin menunggu saya bersedia menemani, silahkan tanyakan pertanyaan apapun atau apakah anda ingin saya membantu dengan sesuatu yang lain? Misalnya, apakah anda ingin saya:\n- Mencari informasi tentang topik tertentu?\n- Membuat naskah, novel, artikel atau cerpen\n- Membuat berbagai resep makanan\n- Memberi solusi tentang masalah yang sedang anda alami\n\nSilahkan beri tahu saya apa yang ingin Anda lakukan. Saya siap membantu!😊";
//           await sock.sendMessage(phone, { text: response });
//         } else {
//           // Pesan berikutnya
//           const aiResponse = await run(pesan);
//           await sock.sendMessage(phone, { text: aiResponse });
//         }
//       } catch (error) {
//         console.error("Error processing message:", error);
//         await sock.sendMessage(phone, {
//           text: "Maaf, saya tidak dapat menjawab pertanyaan Anda saat ini.",
//         });
//       }
//     }
//   });
// };

// Socket.io Connection
io.on("connection", (socket) => {
  currentSocket = socket;
  if (isConnected()) {
    updateQR("connected");
  } else if (qrCode) {
    updateQR("qr");
  }

  socket.on("disconnect", (reason) => {
    console.log(`User disconnected due to: ${reason}`);
  });
});

// Helper Functions
const isConnected = () => {
  return !!sock?.user;
};

const updateQR = (status) => {
  if (!currentSocket) {
    return;
  }

  switch (status) {
    case "qr":
      qrcode.toDataURL(qrCode, (err, url) => {
        if (err) {
          console.error("Error generating QR Code: ", err);
        } else {
          currentSocket?.emit("qr", url);
          currentSocket?.emit("log", "QR Code received, please scan!");
        }
      });
      break;
    case "connected":
      currentSocket?.emit("qrstatus", "./assets/check.svg");
      currentSocket?.emit("log", "WhatsApp terhubung!");
      break;
    case "qrscanned":
      currentSocket?.emit("qrstatus", "./assets/check.svg");
      currentSocket?.emit("log", "QR Code Telah discan!");
      break;
    case "loading":
      currentSocket?.emit("qrstatus", "./assets/loader.gif");
      currentSocket?.emit("log", "Registering QR Code, please wait!");
      break;
    default:
      break;
  }
};

// Send Text Message to WhatsApp User
app.post("/send-message", async (req, res) => {
  let { numbers, message } = req.body;
  const file = req.files?.file_dikirim;

  // Parsing numbers jika masih berupa string
  if (typeof numbers === "string") {
    try {
      numbers = JSON.parse(numbers);
    } catch (error) {
      return res.status(400).json({
        status: false,
        response: "Format daftar nomor WA tidak valid!",
      });
    }
  }

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({
      status: false,
      response: "Daftar nomor WA tidak disertakan!",
    });
  }

  try {
    if (!isConnected()) {
      return res.status(500).json({
        status: false,
        response: "WhatsApp belum terhubung.",
      });
    }

    for (const number of numbers) {
      const numberWA = `${number}@s.whatsapp.net`;
      const [exists] = await sock.onWhatsApp(numberWA);

      if (!exists?.jid) {
        console.warn(`Nomor ${number} tidak terdaftar.`);
        continue;
      }

      let options = {};

      if (file) {
        const uploadPath = path.join(
          __dirname,
          "uploads",
          `${Date.now()}_${file.name}`
        );

        // Handle File Upload

        // Cek apakah direktori 'uploads' ada
        if (!fs.existsSync(path.join(__dirname, "uploads"))) {
          fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
        }

        await file.mv(uploadPath);

        const mimeType = file.mimetype;
        const extension = path.extname(uploadPath).toLowerCase();

        if ([".jpeg", ".jpg", ".png", ".gif"].includes(extension)) {
          options = {
            image: { url: uploadPath }, // Adjust if sending file path
            caption: message,
          };
        } else if ([".mp3", ".ogg"].includes(extension)) {
          options = {
            audio: { url: uploadPath }, // Ensure path is correct
            mimetype: mimeType,
            ptt: true,
          };
        } else {
          options = {
            document: { url: uploadPath },
            mimetype: mimeType,
            fileName: file.name,
            caption: message,
          };
        }
        await sock.sendMessage(exists.jid, options);
        // Hapus file setelah dikirim
        fs.unlink(uploadPath, (err) => {
          if (err) console.error("Error deleting file: ", err);
        });
      } else {
        options = { text: message };
      }
    }

    res.status(200).json({
      status: true,
      response: "Pesan berhasil dikirim ke semua nomor.",
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      response: `Failed to send message: ${error.message}`,
    });
  }
});

const PORT = process.env.PORT || 8000;

// Start Express Server
server.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  connectToWhatsApp();
});

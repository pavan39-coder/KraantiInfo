import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import api from "./routes/api.js";
import { startNewsCollectorScheduler } from "./services/NewsCollector.js";
import { processCollectedCandidates } from "./services/EditorialAutomation.js";
import { connectToDatabase } from "./config/database.js";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const app = express();
const port = Number(process.env.PORT) || 5000;
const isDevelopment = process.env.NODE_ENV === "development";
const allowedOrigins = (process.env.CLIENT_ORIGIN || (isDevelopment ? "http://localhost:5173" : ""))
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

if (isDevelopment) {
  allowedOrigins.push("http://localhost:5173", "http://localhost:5174");
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api", api);
app.use((error, _req, res, _next) => {
  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json({ error: error.message });
  }
  if (error.code === 11000) {
    return res.status(409).json({ error: "A matching news item or source already exists." });
  }
  console.error(error);
  res.status(500).json({ error: "The server could not complete the request." });
});

app.listen(port, () => console.log(`KraantiInfo API listening on http://localhost:${port}`));

connectToDatabase({
  onConnected: () => {
    if (process.env.AI_AUTO_PROCESSING_ENABLED === "true") {
      processCollectedCandidates()
        .then(result => console.log("Startup editorial processing completed:", result))
        .catch(error => console.error("Startup editorial processing failed:", error.message));
    }
    startNewsCollectorScheduler({ afterCollection: processCollectedCandidates });
  }
});

if (process.env.NEWS_ENGINE_ENABLED === "true" && !process.env.MONGO_URI) {
  console.warn("NEWS_ENGINE_ENABLED=true, but the collector cannot run without MongoDB.");
}


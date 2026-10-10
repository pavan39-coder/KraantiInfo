import mongoose from "mongoose";

const INITIAL_RETRY_MS = 5000;
const MAX_RETRY_MS = 60000;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function connectToDatabase({
  uri = process.env.MONGO_URI,
  onConnected = () => {},
  connect = mongoose.connect,
  sleep = wait
} = {}) {
  if (!uri) {
    console.warn("MONGO_URI is not set; MongoDB persistence and real news collection are unavailable.");
    return false;
  }

  let retryDelay = INITIAL_RETRY_MS;
  while (true) {
    try {
      await connect(uri);
      console.log("MongoDB connected");
      onConnected();
      return true;
    } catch (error) {
      console.error(`MongoDB connection failed (${error.name}). Retrying in ${retryDelay / 1000} seconds.`);
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    }
  }
}

export function getDatabaseStatus({ readyState = mongoose.connection.readyState, configured = Boolean(process.env.MONGO_URI) } = {}) {
  if (!configured) return "demo-mode";
  if (readyState === 1) return "connected";
  if (readyState === 2) return "connecting";
  return "disconnected";
}

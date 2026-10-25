import mongoose from "mongoose";

const newsSourceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ["NEWSDATA", "RSS", "GOVERNMENT_FEED", "GDELT"], required: true },
    endpoint: { type: String, default: "" },
    language: { type: String, default: "hi,en", trim: true, maxlength: 20 },
    country: { type: String, default: "in" },
    category: { type: String, default: "India" },
    allowFullText: { type: Boolean, default: false },
    allowMedia: { type: Boolean, default: false },
    enabled: { type: Boolean, default: false },
    reliabilityScore: { type: Number, min: 0, max: 100, default: 50 },
    lastFetchStatus: { type: String, default: "Never fetched" },
    lastFetchError: { type: String, default: "" },
    lastFetchedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export default mongoose.model("NewsSource", newsSourceSchema);

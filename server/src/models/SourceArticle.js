import mongoose from "mongoose";

const sourceArticleSchema = new mongoose.Schema(
  {
    source: { type: mongoose.Schema.Types.ObjectId, ref: "NewsSource", required: true, index: true },
    provider: { type: String, enum: ["NEWSDATA", "RSS", "GOVERNMENT_FEED", "GDELT"], required: true },
    title: { type: String, required: true, trim: true, maxlength: 500 },
    description: { type: String, default: "", maxlength: 3000 },
    url: { type: String, required: true },
    canonicalUrl: { type: String, required: true },
    imageUrl: { type: String, default: "" },
    sourceName: { type: String, default: "" },
    author: { type: String, default: "" },
    language: { type: String, default: "" },
    country: { type: String, default: "" },
    category: { type: String, default: "" },
    publishedAt: { type: Date, default: null },
    collectedAt: { type: Date, default: Date.now },
    dedupeKey: { type: String, required: true, unique: true },
    titleFingerprint: { type: String, required: true, unique: true },
    status: { type: String, enum: ["collected", "draft", "review", "published", "rejected"], default: "collected", index: true }
  },
  { timestamps: true }
);

sourceArticleSchema.index({ publishedAt: -1 });

export default mongoose.model("SourceArticle", sourceArticleSchema);

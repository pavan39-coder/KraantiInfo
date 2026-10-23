import mongoose from "mongoose";

const articleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    summary: { type: String, required: true, trim: true },
    body: { type: String, default: "" },
    verificationNotes: { type: String, default: "" },
    category: { type: String, required: true },
    author: { type: String, default: "KraantiInfo Desk" },
    aiAssisted: { type: Boolean, default: false },
    autoPublished: { type: Boolean, default: false },
    bloggerSync: {
      status: { type: String, enum: ["pending", "published", "failed"], default: undefined },
      postId: { type: String, default: "" },
      postUrl: { type: String, default: "" },
      label: { type: String, default: "" },
      lastAttemptAt: { type: Date, default: null },
      error: { type: String, default: "" }
    },
    image: { type: String, default: "" },
    imageAlt: { type: String, default: "" },
    sourceName: { type: String, default: "" },
    sourceUrl: { type: String, default: "" },
    sourceArticle: { type: mongoose.Schema.Types.ObjectId, ref: "SourceArticle", unique: true, sparse: true },
    status: { type: String, enum: ["draft", "review", "published", "rejected"], default: "draft" },
    tags: { type: [String], default: [] },
    publishedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

articleSchema.index({ status: 1, publishedAt: -1 });

export default mongoose.model("Article", articleSchema);


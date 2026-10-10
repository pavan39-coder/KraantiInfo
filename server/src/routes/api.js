import { Router } from "express";
import mongoose from "mongoose";
import Article from "../models/Article.js";
import { demoArticles } from "../data/demoArticles.js";
import { getDatabaseStatus } from "../config/database.js";
import adminRoutes from "./admin.js";
import { categories } from "../constants/categories.js";

const router = Router();
const databaseReady = () => mongoose.connection.readyState === 1;

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    database: getDatabaseStatus(),
    engineEnabled: process.env.NEWS_ENGINE_ENABLED === "true",
    aiAutoProcessingEnabled: process.env.AI_AUTO_PROCESSING_ENABLED === "true",
    aiAutoPublishEnabled: process.env.AI_AUTO_PUBLISH_ENABLED === "true",
    collectionIntervalMinutes: Math.min(Math.max(Number(process.env.NEWS_COLLECTION_INTERVAL_MINUTES) || 30, 5), 1440)
  });
});

router.get("/categories", (_req, res) => res.json(categories));

router.get("/articles", async (req, res, next) => {
  try {
    const { category, search, limit = 20 } = req.query;
    if (!databaseReady()) {
      const results = demoArticles.filter(article =>
        article.status === "published" &&
        (!category || category === "All" || article.category.toLowerCase() === String(category).toLowerCase()) &&
        (!search || `${article.title} ${article.summary} ${article.category}`.toLowerCase().includes(String(search).toLowerCase()))
      );
      return res.json({ data: results.slice(0, Number(limit)), demo: true });
    }

    const query = { status: "published" };
    if (category && category !== "All") query.category = new RegExp(`^${String(category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    if (search) query.$text = { $search: String(search) };
    const data = await Article.find(query).sort({ publishedAt: -1 }).limit(Math.min(Number(limit) || 20, 100)).lean();
    res.json({ data, demo: false });
  } catch (error) {
    next(error);
  }
});

router.get("/articles/:id", async (req, res, next) => {
  try {
    if (databaseReady() && mongoose.isValidObjectId(req.params.id)) {
      const article = await Article.findOne({ _id: req.params.id, status: "published" }).lean();
      if (article) return res.json({ data: article, demo: false });
    }
    const article = demoArticles.find(item => item._id === req.params.id);
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json({ data: article, demo: true });
  } catch (error) {
    next(error);
  }
});

router.post("/assistant/chat", (req, res) => {
  const { question, article } = req.body ?? {};
  if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "Please enter a question." });
  if (!article || typeof article.title !== "string") return res.status(400).json({ error: "An article is required for context." });
  res.json({
    answer: `DEMO RESPONSE — This answer is based only on the WakeupIndia demo article “${article.title}”. ${article.summary ?? "The article summary is not available."} For verified details, refer to the attributed sources in the article. A live AI provider has not been configured.`,
    demo: true
  });
});

router.use("/admin", adminRoutes);

export default router;

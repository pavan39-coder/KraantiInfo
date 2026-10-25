import { Router } from "express";
import mongoose from "mongoose";
import Article from "../models/Article.js";
import { demoArticles } from "../data/demoArticles.js";
import { getDatabaseStatus } from "../config/database.js";
import adminRoutes from "./admin.js";
import { categories } from "../constants/categories.js";
import { canonicalSiteOrigin, createSitemapXml, renderArticleSeoPage } from "../services/SeoRenderer.js";

const router = Router();
const databaseReady = () => mongoose.connection.readyState === 1;
const publicSiteOrigin = () => canonicalSiteOrigin(process.env.SEO_PUBLIC_SITE_URL || "https://www.kraantiinfo.in");

router.get("/sitemap.xml", async (_req, res, next) => {
  try {
    const articles = databaseReady()
      ? await Article.find({ status: "published" })
        .select("_id category publishedAt updatedAt status")
        .sort({ publishedAt: -1 })
        .limit(49980)
        .lean()
      : [];
    res.set({
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      "Vercel-CDN-Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600"
    });
    res.send(createSitemapXml({ articles, categories, siteOrigin: publicSiteOrigin() }));
  } catch (error) {
    next(error);
  }
});

router.get("/seo/articles/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).type("text").send("Article not found.");
    if (!databaseReady()) return res.status(503).type("text").send("Article service is temporarily unavailable.");
    const article = await Article.findOne({ _id: req.params.id, status: "published" }).lean();
    if (!article) return res.status(404).type("text").send("Article not found.");

    const siteOrigin = publicSiteOrigin();
    const shellResponse = await fetch(`${siteOrigin}/`, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(8000)
    });
    if (!shellResponse.ok) throw new Error(`Could not load the public site shell (${shellResponse.status}).`);
    const shell = await shellResponse.text();
    const publicArticle = {
      _id: article._id,
      title: article.title,
      summary: article.summary,
      body: article.body,
      category: article.category,
      author: article.author,
      aiAssisted: article.aiAssisted,
      autoPublished: article.autoPublished,
      image: article.image,
      imageAlt: article.imageAlt,
      videoUrl: article.videoUrl,
      language: article.language,
      sourceName: article.sourceName,
      sourceUrl: article.sourceUrl,
      tags: article.tags,
      publishedAt: article.publishedAt,
      updatedAt: article.updatedAt
    };
    const html = renderArticleSeoPage({ shell, article: publicArticle, siteOrigin });
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
      "Vercel-CDN-Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600"
    });
    res.send(html);
  } catch (error) {
    next(error);
  }
});

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
    answer: `DEMO RESPONSE — This answer is based only on the KraantiInfo demo article “${article.title}”. ${article.summary ?? "The article summary is not available."} For verified details, refer to the attributed sources in the article. A live AI provider has not been configured.`,
    demo: true
  });
});

router.use("/admin", adminRoutes);

export default router;


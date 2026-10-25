import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import Article from "../models/Article.js";
import NewsSource from "../models/NewsSource.js";
import SourceArticle from "../models/SourceArticle.js";
import { generateEditorialDraft } from "../services/EditorialDraftAgent.js";
import { processCollectedCandidates } from "../services/EditorialAutomation.js";
import { demoArticles, demoSources } from "../data/demoArticles.js";
import { MockNewsProvider } from "../providers/MockNewsProvider.js";
import { collectEnabledSources, getLastCollection } from "../services/NewsCollector.js";
import { getDatabaseStatus } from "../config/database.js";
import { categories } from "../constants/categories.js";
import { countWords, MINIMUM_ARTICLE_WORDS } from "../utils/wordCount.js";
import { isBloggerConfigured, isBloggerPublishingEnabled, publishArticleToBlogger, retryFailedBloggerArticles } from "../services/BloggerPublisher.js";

const router = Router();
const sensitiveCategories = /politic|election|crime|health|business|finance|death|market|stock|bank|assault|arrest|murder|injur|fatal|disease|drug|court/i;
const demoProvider = new MockNewsProvider();
let lastRun = null;
const isDraftLanguage = language => language === "hi" || language === "en";

const databaseReady = () => mongoose.connection.readyState === 1;

function requireAdmin(req, res, next) {
  if (process.env.NODE_ENV === "development") return next();
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    return res.status(503).json({ error: "Admin authentication is not configured with a strong signing secret." });
  }
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: "Admin sign-in is required." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (payload.role !== "admin") return res.status(403).json({ error: "Admin access is required." });
    next();
  } catch {
    res.status(401).json({ error: "Your admin session is invalid or expired. Please sign in again." });
  }
}

router.post("/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const { ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32) {
    return res.status(503).json({ error: "Admin sign-in is not configured on this server." });
  }
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const suppliedEmail = Buffer.from(email.trim().toLowerCase());
  const expectedEmail = Buffer.from(ADMIN_EMAIL.trim().toLowerCase());
  const suppliedPassword = Buffer.from(password);
  const expectedPassword = Buffer.from(ADMIN_PASSWORD);
  const emailMatches = suppliedEmail.length === expectedEmail.length && timingSafeEqual(suppliedEmail, expectedEmail);
  const passwordMatches = suppliedPassword.length === expectedPassword.length && timingSafeEqual(suppliedPassword, expectedPassword);
  if (!emailMatches || !passwordMatches) return res.status(401).json({ error: "Email or password is incorrect." });
  const token = jwt.sign({ sub: ADMIN_EMAIL, role: "admin" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "8h" });
  res.json({ token, expiresIn: 28800 });
});

router.use(requireAdmin);

router.get("/overview", async (_req, res, next) => {
  try {
    if (!databaseReady()) {
      return res.json({
        demo: true,
        counts: { published: demoArticles.length, review: 3, drafts: 2 },
        engine: { enabled: false, lastRun: getLastCollection()?.completedAt || lastRun },
        automation: { enabled: false, autoPublishEnabled: false, maxPerRun: 1 },
        blogger: { enabled: isBloggerPublishingEnabled(), configured: isBloggerConfigured() }
      });
    }
    const [published, review, drafts, collected, latestSourceFetch] = await Promise.all([
      Article.countDocuments({ status: "published" }),
      Article.countDocuments({ status: "review" }),
      Article.countDocuments({ status: "draft" }),
      SourceArticle.countDocuments({ status: "collected" }),
      NewsSource.findOne({ lastFetchedAt: { $ne: null } }).sort({ lastFetchedAt: -1 }).select("lastFetchedAt").lean()
    ]);
    const latestRun = getLastCollection()?.completedAt || latestSourceFetch?.lastFetchedAt || null;
    res.json({
      demo: false,
      counts: { published, review, drafts, collected },
      engine: { enabled: process.env.NEWS_ENGINE_ENABLED === "true", lastRun: latestRun },
      automation: {
        enabled: process.env.AI_AUTO_PROCESSING_ENABLED === "true",
        autoPublishEnabled: process.env.AI_AUTO_PUBLISH_ENABLED === "true",
        maxPerRun: 1
      },
      blogger: { enabled: isBloggerPublishingEnabled(), configured: isBloggerConfigured() }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/sources", async (_req, res, next) => {
  try {
    if (!databaseReady()) return res.json({ data: demoSources, demo: true });
    const data = await NewsSource.find().sort({ createdAt: -1 }).lean();
    res.json({ data, demo: false });
  } catch (error) {
    next(error);
  }
});

router.post("/sources", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to save a news source. Demo mode is read-only." });
    const source = await NewsSource.create({
      name: req.body.name,
      type: req.body.type,
      endpoint: req.body.endpoint,
      language: req.body.language,
      country: req.body.country,
      category: req.body.category,
      allowFullText: req.body.allowFullText === true,
      allowMedia: req.body.allowMedia === true,
      reliabilityScore: req.body.reliabilityScore
    });
    res.status(201).json({ data: source });
  } catch (error) {
    next(error);
  }
});

router.patch("/sources/:id", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to update a news source. Demo mode is read-only." });
    const updates = {};
    if (Object.hasOwn(req.body, "enabled")) {
      if (typeof req.body.enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean." });
      updates.enabled = req.body.enabled;
    }
    if (Object.hasOwn(req.body, "language")) {
      if (!["hi", "hi,en", "en"].includes(req.body.language)) return res.status(400).json({ error: "Choose Hindi, Hindi plus English, or English for this source." });
      updates.language = req.body.language;
    }
    if (Object.hasOwn(req.body, "category")) {
      if (!categories.includes(req.body.category)) return res.status(400).json({ error: "Choose a supported KraantiInfo category." });
      updates.category = req.body.category;
    }
    if (Object.hasOwn(req.body, "allowFullText")) {
      if (typeof req.body.allowFullText !== "boolean") return res.status(400).json({ error: "allowFullText must be a boolean." });
      updates.allowFullText = req.body.allowFullText;
    }
    if (Object.hasOwn(req.body, "allowMedia")) {
      if (typeof req.body.allowMedia !== "boolean") return res.status(400).json({ error: "allowMedia must be a boolean." });
      updates.allowMedia = req.body.allowMedia;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: "Provide at least one source setting to update." });
    const current = await NewsSource.findById(req.params.id);
    if (!current) return res.status(404).json({ error: "News source not found." });
    if (updates.enabled && current.type === "NEWSDATA" && !process.env.NEWSDATA_API_KEY) {
      return res.status(400).json({ error: "Set NEWSDATA_API_KEY in the server environment before enabling NewsData.io." });
    }
    if (updates.enabled && ["RSS", "GOVERNMENT_FEED"].includes(current.type) && !current.endpoint) {
      return res.status(400).json({ error: "Configure an HTTPS feed URL before enabling this source." });
    }
    const source = await NewsSource.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true });
    if (!source) return res.status(404).json({ error: "News source not found." });
    res.json({ data: source });
  } catch (error) {
    next(error);
  }
});

router.post("/engine/run-demo", async (_req, res) => {
  const stories = await demoProvider.discover();
  lastRun = new Date().toISOString();
  res.json({ demo: true, found: stories.length, duplicates: 0, needsReview: stories.length, message: "Demo discovery complete. No external sources were contacted." });
});

router.post("/engine/collect", async (req, res, next) => {
  if (process.env.NEWS_ENGINE_ENABLED !== "true") {
    return res.status(503).json({ error: "External news collection is disabled. Set NEWS_ENGINE_ENABLED=true on the server after reviewing provider terms and configuring approved sources." });
  }
  if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to collect and deduplicate source articles." });
  const requestedLanguage = req.body?.language;
  if (requestedLanguage !== undefined && !isDraftLanguage(requestedLanguage)) {
    return res.status(400).json({ error: "Choose Hindi or English for AI drafts." });
  }
  try {
    const collection = await collectEnabledSources();
    const editorial = await processCollectedCandidates({ draftLanguage: requestedLanguage });
    res.json({ ...collection, editorial });
  } catch (error) {
    if (/already in progress|disabled|No news sources are enabled/.test(error.message)) return res.status(409).json({ error: error.message });
    next(error);
  }
});

router.post("/editorial/automation/run", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to process collected candidates." });
    const requestedLanguage = req.body?.language;
    if (requestedLanguage !== undefined && !isDraftLanguage(requestedLanguage)) {
      return res.status(400).json({ error: "Choose Hindi or English for AI drafts." });
    }
    const result = await processCollectedCandidates({ draftLanguage: requestedLanguage });
    if (!result.enabled) {
      return res.status(503).json({ error: "AI auto-processing is disabled. Set AI_AUTO_PROCESSING_ENABLED=true on the server and restart it." });
    }
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

router.post("/blogger/retry-failed", async (_req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to retry Blogger posts." });
    if (!isBloggerPublishingEnabled() || !isBloggerConfigured()) {
      return res.status(503).json({ error: "Enable Blogger auto-publishing and configure Blogger OAuth credentials and blog ID on the backend first." });
    }
    res.json({ data: await retryFailedBloggerArticles() });
  } catch (error) {
    next(error);
  }
});

router.get("/collected-articles", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to view collected articles." });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const allowedStatuses = ["collected", "draft", "review", "published", "rejected"];
    const status = req.query.status || "collected";
    if (!allowedStatuses.includes(status)) return res.status(400).json({ error: "Unsupported candidate status." });
    const data = await SourceArticle.find({ status })
      .sort({ publishedAt: -1, collectedAt: -1 })
      .limit(limit)
      .populate("source", "name type reliabilityScore")
      .lean();
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.get("/editorial/articles", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to load the editorial queue." });
    const status = req.query.status;
    const query = { status: { $in: ["draft", "review"] } };
    if (status) {
      if (!["draft", "review"].includes(status)) return res.status(400).json({ error: "Editorial queue status must be draft or review." });
      query.status = status;
    }
    const data = await Article.find(query)
      .sort({ updatedAt: -1 })
      .limit(100)
      .populate("sourceArticle", "title sourceName url provider")
      .lean();
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.get("/editorial/published-articles", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to load published articles." });
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const data = await Article.find({ status: "published" })
      .select("title category publishedAt bloggerSync")
      .sort({ publishedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

router.post("/collected-articles/:id/generate-draft", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to create editorial drafts." });
    const language = req.body?.language ?? "hi";
    if (!isDraftLanguage(language)) return res.status(400).json({ error: "Choose Hindi or English for the AI draft." });
    const candidate = await SourceArticle.findById(req.params.id);
    if (!candidate) return res.status(404).json({ error: "Collected source item not found." });
    if (candidate.status !== "collected") {
      return res.status(409).json({ error: "This source item is no longer awaiting editorial processing." });
    }
    if ((typeof candidate.description !== "string" || candidate.description.trim().length < 80) && countWords(candidate.contentText) < 100) {
      return res.status(422).json({ error: "Source mein AI article ke liye paryapt details nahi hain. Behtar description ya source details wala candidate chunen." });
    }
    const generated = await generateEditorialDraft(candidate, { language });
    const article = await Article.create({
      sourceArticle: candidate._id,
      title: generated.title,
      summary: generated.summary,
      body: generated.body,
      verificationNotes: generated.verificationNotes,
      category: generated.category,
      author: "KraantiInfo AI Desk",
      aiAssisted: true,
      sourceName: candidate.sourceName || candidate.provider,
      sourceUrl: candidate.url,
      image: candidate.imageUrl,
      imageAlt: candidate.title,
      videoUrl: candidate.videoUrl,
      language,
      tags: [generated.category],
      status: "draft"
    });
    candidate.status = "draft";
    await candidate.save();
    res.status(201).json({ data: article, generatedBy: generated.model });
  } catch (error) {
    if (/^The AI draft contains/.test(error.message)) return res.status(422).json({ error: error.message });
    if (/^Configure OPENROUTER_API_KEY/.test(error.message)) {
      return res.status(503).json({ error: error.message });
    }
    if (/^OpenRouter|^The AI provider|^AI draft generation failed/.test(error.message)) {
      return res.status(502).json({ error: error.message });
    }
    next(error);
  }
});

router.patch("/editorial/articles/:id", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to edit editorial articles." });
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ error: "Editorial article not found." });
    if (!["draft", "review"].includes(article.status)) {
      return res.status(409).json({ error: "Only drafts and articles awaiting review can be edited." });
    }
    const { title, summary, body, category, author, verificationNotes } = req.body ?? {};
    if ([title, summary, body, category].some(value => typeof value !== "string" || !value.trim())) {
      return res.status(400).json({ error: "Headline, summary, article body, and category are required." });
    }
    const cleanCategory = category.trim();
    if (!categories.includes(cleanCategory)) return res.status(400).json({ error: "Choose a supported KraantiInfo category." });
    if (title.trim().length > 180 || summary.trim().length > 500 || body.trim().length > 20000) {
      return res.status(400).json({ error: "Headline, summary, or article body exceeds the allowed length." });
    }
    const bodyWordCount = countWords(body);
    if (bodyWordCount < MINIMUM_ARTICLE_WORDS) {
      return res.status(400).json({ error: `Article body has ${bodyWordCount} words. Write at least ${MINIMUM_ARTICLE_WORDS} words before saving.` });
    }
    article.title = title.trim();
    article.summary = summary.trim();
    article.body = body.trim();
    article.category = cleanCategory;
    article.author = typeof author === "string" && author.trim() ? author.trim().slice(0, 100) : article.author;
    if (typeof verificationNotes === "string") article.verificationNotes = verificationNotes.slice(0, 3000);
    article.tags = [cleanCategory];
    await article.save();
    res.json({ data: article });
  } catch (error) {
    next(error);
  }
});

router.post("/collected-articles/:id/draft", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to create editorial drafts." });
    const candidate = await SourceArticle.findById(req.params.id);
    if (!candidate) return res.status(404).json({ error: "Collected source item not found." });
    if (candidate.status !== "collected") return res.status(409).json({ error: "This source item is no longer awaiting editorial processing." });

    const { title, summary, body, category, author } = req.body ?? {};
    const language = req.body?.language ?? "hi";
    if (!isDraftLanguage(language)) return res.status(400).json({ error: "Choose Hindi or English for this draft." });
    if ([title, summary, body, category].some(value => typeof value !== "string" || !value.trim())) {
      return res.status(400).json({ error: "Write an original headline, summary, article body, and category before saving a draft." });
    }
    const cleanCategory = category.trim();
    if (!categories.includes(cleanCategory)) return res.status(400).json({ error: "Choose a supported KraantiInfo category." });
    if (title.trim().length > 180 || summary.trim().length > 500 || body.trim().length > 20000) {
      return res.status(400).json({ error: "Headline, summary, or article body exceeds the allowed length." });
    }
    const bodyWordCount = countWords(body);
    if (bodyWordCount < MINIMUM_ARTICLE_WORDS) {
      return res.status(400).json({ error: `Article body has ${bodyWordCount} words. Write at least ${MINIMUM_ARTICLE_WORDS} words before saving.` });
    }

    const article = await Article.create({
      sourceArticle: candidate._id,
      title: title.trim(),
      summary: summary.trim(),
      body: body.trim(),
      category: cleanCategory,
      author: typeof author === "string" && author.trim() ? author.trim().slice(0, 100) : "KraantiInfo Desk",
      sourceName: candidate.sourceName || candidate.provider,
      sourceUrl: candidate.url,
      image: candidate.imageUrl,
      imageAlt: candidate.title,
      videoUrl: candidate.videoUrl,
      language,
      tags: [cleanCategory],
      status: "draft"
    });
    candidate.status = "draft";
    await candidate.save();
    res.status(201).json({ data: article });
  } catch (error) {
    next(error);
  }
});

router.patch("/editorial/articles/:id/status", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to update editorial articles." });
    const { status, factCheckConfirmed, attributionConfirmed, sensitiveReviewConfirmed } = req.body ?? {};
    if (!["review", "published", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Choose submit for review, publish, or reject." });
    }

    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ error: "Editorial article not found." });
    const allowedTransitions = {
      draft: ["review", "rejected"],
      review: ["published", "rejected"]
    };
    if (!allowedTransitions[article.status]?.includes(status)) {
      return res.status(409).json({ error: `An article in ${article.status} status cannot be moved to ${status}.` });
    }
    if (status === "published") {
      const bodyWordCount = countWords(article.body);
      if (bodyWordCount < MINIMUM_ARTICLE_WORDS) {
        return res.status(400).json({ error: `This article has ${bodyWordCount} words. Add at least ${MINIMUM_ARTICLE_WORDS} words before publishing.` });
      }
      if (!article.title || !article.summary || !article.body || !article.sourceUrl || !article.sourceName) {
        return res.status(400).json({ error: "A headline, summary, complete article body, and source attribution are required before publishing." });
      }
      if (factCheckConfirmed !== true || attributionConfirmed !== true) {
        return res.status(400).json({ error: "Confirm that you verified the story facts and source attribution before publishing." });
      }
      const source = article.sourceArticle
        ? await SourceArticle.findById(article.sourceArticle).select("title description category").lean()
        : null;
      const sensitiveSourceText = `${source?.title || ""} ${source?.description || ""} ${source?.category || ""}`;
      if ((sensitiveCategories.test(article.category) || sensitiveCategories.test(sensitiveSourceText)) && sensitiveReviewConfirmed !== true) {
        return res.status(400).json({ error: "This sensitive category requires an additional editorial review confirmation." });
      }
    }
    article.status = status;
    if (status === "published") article.publishedAt = new Date();
    await article.save();
    if (article.sourceArticle) {
      await SourceArticle.updateOne({ _id: article.sourceArticle }, { $set: { status } });
    }
    let blogger = { status: "skipped" };
    if (status === "published") {
      try {
        blogger = await publishArticleToBlogger(article);
      } catch (error) {
        // Preserve the successful KraantiInfo publish; Blogger sync can be retried.
        blogger = { status: "failed", error: error.message };
        console.error(`Blogger sync failed for KraantiInfo article ${article._id}: ${error.message}`);
      }
    }
    res.json({ data: article, blogger });
  } catch (error) {
    next(error);
  }
});

router.post("/editorial/articles/:id/blogger-sync", async (req, res, next) => {
  try {
    if (!databaseReady()) return res.status(503).json({ error: "MongoDB is required to retry Blogger publishing." });
    const article = await Article.findById(req.params.id);
    if (!article) return res.status(404).json({ error: "Editorial article not found." });
    if (article.status !== "published") return res.status(409).json({ error: "Only stories already published on KraantiInfo can sync to Blogger." });
    if (!isBloggerPublishingEnabled() || !isBloggerConfigured()) {
      return res.status(503).json({ error: "Enable Blogger auto-publishing and configure the Blogger OAuth credentials and blog ID on the backend first." });
    }
    const blogger = await publishArticleToBlogger(article);
    res.json({ data: article, blogger });
  } catch (error) {
    if (/^Google OAuth|^Blogger API/.test(error.message)) return res.status(502).json({ error: error.message });
    next(error);
  }
});

export default router;


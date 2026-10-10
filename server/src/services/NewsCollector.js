import { createHash } from "node:crypto";
import { isIP } from "node:net";
import dns from "node:dns/promises";
import Parser from "rss-parser";
import SourceArticle from "../models/SourceArticle.js";
import NewsSource from "../models/NewsSource.js";

const parser = new Parser();
const REQUEST_TIMEOUT_MS = 15000;
const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;
let collectionInProgress = false;
let lastCollection = null;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedIpv4) return isPrivateAddress(mappedIpv4[1]);
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe80:") || normalized.startsWith("ff");
  }
  return true;
}

export async function safeExternalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Source URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("News feeds must use HTTPS and must not embed credentials in their URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Local and private network feed URLs are not allowed.");
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error("Local and private network feed URLs are not allowed.");
  } else {
    const addresses = await dns.lookup(hostname, { all: true });
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Feed host resolves to a local or private network address.");
    }
  }
  return url;
}

function safeString(value, maximum = 3000) {
  if (Array.isArray(value)) value = value.join(", ");
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function dateOrNull(value) {
  if (!value) return null;
  const normalized = typeof value === "string" && /^\d{8}T\d{6}Z$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeRecord(record, source) {
  const originalUrl = safeString(record.url, 2000);
  if (!record.title || !originalUrl) return null;
  let canonicalUrl;
  try {
    canonicalUrl = normalizedUrl(originalUrl);
  } catch {
    return null;
  }
  const title = safeString(record.title, 500);
  const description = safeString(record.description, 1500);
  const normalizedTitle = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const publishedAt = dateOrNull(record.publishedAt);
  const publishDay = publishedAt ? publishedAt.toISOString().slice(0, 10) : "unknown-date";
  return {
    source: source._id,
    provider: source.type,
    title,
    description,
    url: originalUrl,
    canonicalUrl,
    imageUrl: safeString(record.imageUrl, 2000),
    sourceName: safeString(record.sourceName, 200),
    author: safeString(record.author, 200),
    language: safeString(record.language, 20) || source.language,
    country: safeString(record.country, 50) || source.country,
    category: safeString(record.category, 100) || source.category,
    publishedAt,
    dedupeKey: hash(canonicalUrl),
    titleFingerprint: hash(`${normalizedTitle}|${publishDay}`)
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(`Provider returned HTTP ${response.status}${retryAfter ? `; retry after ${retryAfter}` : ""}.`);
  }
  return response.json();
}

async function collectNewsData(source) {
  if (!process.env.NEWSDATA_API_KEY) throw new Error("Set NEWSDATA_API_KEY in the server environment before enabling this source.");
  const url = new URL("https://newsdata.io/api/1/latest");
  url.searchParams.set("apikey", process.env.NEWSDATA_API_KEY);
  url.searchParams.set("language", source.language || "en");
  url.searchParams.set("country", source.country || "in");
  url.searchParams.set("size", "10");
  if (source.endpoint) url.searchParams.set("q", source.endpoint.trim());
  const payload = await fetchJson(url);
  if (payload.status !== "success" || !Array.isArray(payload.results)) {
    throw new Error(payload.results?.message || payload.message || "NewsData.io returned an unexpected response.");
  }
  return payload.results.map(item => ({
    title: item.title,
    description: item.description,
    url: item.link,
    imageUrl: item.image_url,
    sourceName: item.source_name || item.source_id,
    author: item.creator,
    language: item.language,
    country: item.country,
    category: item.category,
    publishedAt: item.pubDate
  }));
}

async function collectGdelt(source) {
  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", source.endpoint?.trim() || "India");
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "50");
  url.searchParams.set("sort", "DateDesc");
  const gdeltLanguages = { en: "English", es: "Spanish", fr: "French", de: "German", hi: "Hindi", ar: "Arabic", pt: "Portuguese", ru: "Russian", zh: "Chinese" };
  if (source.language) url.searchParams.set("sourcelang", gdeltLanguages[source.language.toLowerCase()] || source.language);
  const payload = await fetchJson(url);
  if (payload.status === "error") throw new Error(payload.message || "GDELT returned an error.");
  if (!Array.isArray(payload.articles)) throw new Error("GDELT returned an unexpected response.");
  return payload.articles.map(item => ({
    title: item.title,
    description: "",
    url: item.url,
    imageUrl: item.socialimage,
    sourceName: item.domain,
    language: item.language,
    country: item.sourcecountry,
    category: source.category,
    publishedAt: item.seendate
  }));
}

async function collectFeed(source) {
  if (!source.endpoint) throw new Error("Configure an HTTPS RSS feed URL for this source.");
  let url = await safeExternalUrl(source.endpoint);
  let response;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("RSS feed redirected without a Location header.");
    if (redirectCount === 5) throw new Error("RSS feed exceeded the 5-redirect limit.");
    url = await safeExternalUrl(new URL(location, url).toString());
  }
  if (!response.ok) throw new Error(`RSS feed returned HTTP ${response.status}.`);
  const xml = await response.text();
  if (xml.length > 2_000_000) throw new Error("RSS feed exceeds the 2 MB size limit.");
  const feed = await parser.parseString(xml);
  return (feed.items || []).map(item => ({
    title: item.title,
    description: item.contentSnippet || item.summary,
    url: item.link,
    imageUrl: item.enclosure?.url || "",
    sourceName: feed.title || source.name,
    author: item.creator || item.author,
    language: source.language,
    country: source.country,
    category: item.categories?.[0] || source.category,
    publishedAt: item.isoDate || item.pubDate
  }));
}

async function fetchSource(source) {
  switch (source.type) {
    case "NEWSDATA": return collectNewsData(source);
    case "GDELT": return collectGdelt(source);
    case "RSS":
    case "GOVERNMENT_FEED": return collectFeed(source);
    default: throw new Error(`Unsupported news source type: ${source.type}`);
  }
}

async function collectOneSource(source) {
  try {
    const records = await fetchSource(source);
    let inserted = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const record of records) {
      const article = normalizeRecord(record, source);
      if (!article) {
        skipped += 1;
        continue;
      }
      const existing = await SourceArticle.exists({
        $or: [
          { dedupeKey: article.dedupeKey },
          { titleFingerprint: article.titleFingerprint }
        ]
      });
      if (existing) {
        duplicates += 1;
        continue;
      }
      try {
        await SourceArticle.create(article);
        inserted += 1;
      } catch (error) {
        if (error.code !== 11000) throw error;
        duplicates += 1;
      }
    }
    await NewsSource.updateOne(
      { _id: source._id },
      { $set: { lastFetchedAt: new Date(), lastFetchStatus: `OK · ${inserted} new, ${duplicates} duplicates`, lastFetchError: "" } }
    );
    return { sourceId: String(source._id), sourceName: source.name, fetched: records.length, inserted, duplicates, skipped };
  } catch (error) {
    const causeDetail = error.cause?.code || error.cause?.message;
    const rawMessage = causeDetail ? `${error.message} (${causeDetail})` : error.message;
    const errorMessage = process.env.NEWSDATA_API_KEY
      ? safeString(rawMessage, 500).replaceAll(process.env.NEWSDATA_API_KEY, "[redacted]")
      : safeString(rawMessage, 500);
    await NewsSource.updateOne(
      { _id: source._id },
      { $set: { lastFetchedAt: new Date(), lastFetchStatus: "Error", lastFetchError: errorMessage } }
    );
    return { sourceId: String(source._id), sourceName: source.name, error: errorMessage, fetched: 0, inserted: 0, duplicates: 0, skipped: 0 };
  }
}

export async function collectEnabledSources() {
  if (process.env.NEWS_ENGINE_ENABLED !== "true") throw new Error("News collection is disabled. Set NEWS_ENGINE_ENABLED=true on the server after configuring approved sources.");
  if (collectionInProgress) throw new Error("A news collection run is already in progress.");
  collectionInProgress = true;
  try {
    const sources = await NewsSource.find({ enabled: true }).lean();
    if (!sources.length) throw new Error("No news sources are enabled. Add and enable an approved source first.");
    const results = [];
    for (const source of sources) results.push(await collectOneSource(source));
    lastCollection = {
      completedAt: new Date().toISOString(),
      sources: results.length,
      fetched: results.reduce((total, result) => total + result.fetched, 0),
      inserted: results.reduce((total, result) => total + result.inserted, 0),
      duplicates: results.reduce((total, result) => total + result.duplicates, 0),
      errors: results.filter(result => result.error).length
    };
    return { ...lastCollection, results };
  } finally {
    collectionInProgress = false;
  }
}

export function getLastCollection() {
  return lastCollection;
}

export function startNewsCollectorScheduler({ afterCollection } = {}) {
  if (process.env.NEWS_ENGINE_ENABLED !== "true") {
    console.log("News collector scheduler is disabled (NEWS_ENGINE_ENABLED is not true).");
    return null;
  }
  const requestedMinutes = Number(process.env.NEWS_COLLECTION_INTERVAL_MINUTES) || 30;
  const intervalMinutes = Math.min(Math.max(requestedMinutes, 5), 1440);
  const intervalMs = intervalMinutes * 60 * 1000;
  console.log(`News collector scheduler enabled; first run in ${intervalMinutes} minutes.`);
  const timer = setInterval(async () => {
    try {
      const result = await collectEnabledSources();
      console.log("Scheduled news collection completed:", result);
      if (afterCollection) {
        const editorialResult = await afterCollection();
        console.log("Scheduled editorial processing completed:", editorialResult);
      }
    } catch (error) {
      console.error("Scheduled news collection failed:", error.message);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

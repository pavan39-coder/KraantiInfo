import { createHash } from "node:crypto";
import { isIP } from "node:net";
import dns from "node:dns/promises";
import Parser from "rss-parser";
import SourceArticle from "../models/SourceArticle.js";
import NewsSource from "../models/NewsSource.js";

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:group", "mediaGroup", { keepArray: true }],
      ["media:player", "mediaPlayer", { keepArray: true }],
      ["atom:link", "atomLinks", { keepArray: true }]
    ]
  }
});
const REQUEST_TIMEOUT_MS = 15000;
const SOURCE_FETCH_CONCURRENCY = 3;
const GDELT_REQUEST_INTERVAL_MS = 5000;
const GDELT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;
let collectionInProgress = false;
let lastCollection = null;
let gdeltRequestQueue = Promise.resolve();
let gdeltNextRequestAt = 0;

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

function cleanFeedText(value, maximum = 30000) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|blockquote|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const point = Number(code);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/&#x([\da-f]+);/gi, (match, code) => {
      const point = Number.parseInt(code, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maximum);
}

function httpsMediaUrl(value, maximum = 2000) {
  try {
    const url = new URL(typeof value === "string" ? value : "");
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
        (isIP(hostname) && isPrivateAddress(hostname))) return "";
    return url.toString().slice(0, maximum);
  } catch {
    return "";
  }
}

function classifyCategory(value, title, description, fallback) {
  const text = `${safeString(value, 250)} ${title} ${description}`.toLowerCase();
  const matches = [
    ["Cricket", /\b(cricket|ipl|bcci|icc|test match|t20|odi)\b|क्रिकेट|आईपीएल|बीसीसीआई|टी20|वनडे/],
    ["Sports", /\b(sport|football|hockey|tennis|badminton|olympic|athlet|wrestling)\b|खेल|फुटबॉल|हॉकी|टेनिस|बैडमिंटन/],
    ["Education", /\b(education|school|university|college|exam|student|classroom)\b|शिक्षा|स्कूल|विश्वविद्यालय|कॉलेज|परीक्षा|छात्र/],
    ["Jobs", /\b(jobs?|employment|recruitment|career|vacanc|hiring)\b|रोजगार|नौकरी|भर्ती|करियर/],
    ["Agriculture", /\b(agriculture|farm(?:er|ing)?|crop|irrigation|harvest)\b|कृषि|किसान|फसल|सिंचाई/],
    ["Environment", /\b(environment|climate|pollution|conservation|wildlife|carbon)\b|पर्यावरण|जलवायु|प्रदूषण|वन्यजीव/],
    ["Technology", /\b(technology|tech|artificial intelligence|\bai\b|software|cyber|startup|internet|mobile)\b|तकनीक|आर्टिफिशियल इंटेलिजेंस|साइबर/],
    ["Business", /\b(business|economy|finance|market|bank|company|trade|industry|stock)\b|व्यापार|अर्थव्यवस्था|बाजार|बैंक|कंपनी/],
    ["Health", /\b(health|medical|hospital|medicine|doctor|disease|wellness)\b|स्वास्थ्य|अस्पताल|चिकित्सा|डॉक्टर|बीमारी/],
    ["Entertainment", /\b(entertainment|film|movie|cinema|bollywood|music|celebrity|streaming)\b|मनोरंजन|फिल्म|सिनेमा|बॉलीवुड|संगीत/],
    ["Science", /\b(science|research|space|nasa|isro|scientist|discovery)\b|विज्ञान|अनुसंधान|अंतरिक्ष|इसरो/],
    ["Politics", /\b(politic|election|parliament|minister|government|assembly|campaign)\b|राजनीति|चुनाव|संसद|मंत्री|सरकार/],
    ["World", /\b(world|global|international|foreign|united nations|diplomacy)\b|दुनिया|वैश्विक|अंतरराष्ट्रीय|विदेश/],
    ["Lifestyle", /\b(lifestyle|travel|food|fashion|relationships|culture)\b|जीवनशैली|यात्रा|खाना|फैशन|संस्कृति/],
    ["Opinion", /\b(opinion|editorial|column|commentary|perspective)\b|विचार|संपादकीय|राय/]
  ];
  return matches.find(([, pattern]) => pattern.test(text))?.[0] || fallback || "India";
}

function mediaFieldUrl(value) {
  if (typeof value === "string") return value;
  return value?.url || value?.$?.url || value?.href || value?.$?.href || value?._ || "";
}

function isVideoMedia(url, mimeType = "") {
  if (mimeType.toLowerCase().startsWith("video/") || /\.(mp4|m4v|webm|ogv)(?:$|\?)/i.test(url)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") ||
      host === "vimeo.com" || host.endsWith(".vimeo.com");
  } catch {
    return false;
  }
}

function mediaAttribute(value, name) {
  return value?.[name] || value?.$?.[name] || "";
}

function asArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function feedMediaItems(item) {
  const groups = asArray(item.mediaGroup).flatMap(group => asArray(group?.["media:content"]));
  return [
    ...asArray(item.enclosure),
    ...asArray(item.mediaContent),
    ...groups,
    ...asArray(item.mediaPlayer),
    ...asArray(item.atomLinks),
    ...asArray(item.links)
  ];
}

function mediaUrl(item) {
  const url = mediaFieldUrl(item);
  const mimeType = mediaAttribute(item, "type");
  const medium = String(mediaAttribute(item, "medium")).toLowerCase();
  const relation = String(mediaAttribute(item, "rel")).toLowerCase();
  return medium === "video" || (relation === "enclosure" && mimeType.toLowerCase().startsWith("video/")) || isVideoMedia(url, mimeType)
    ? httpsMediaUrl(url)
    : "";
}

function imageUrl(item) {
  const url = mediaFieldUrl(item);
  const mimeType = mediaAttribute(item, "type");
  const medium = String(mediaAttribute(item, "medium")).toLowerCase();
  const relation = String(mediaAttribute(item, "rel")).toLowerCase();
  if (isVideoMedia(url, mimeType) || isAudioMedia(url, mimeType)) return "";
  if (medium === "image" || mimeType.toLowerCase().startsWith("image/") ||
      (relation === "enclosure" && /\.(jpg|jpeg|png|gif|webp|avif)(?:$|\?)/i.test(url)) ||
      /\.(jpg|jpeg|png|gif|webp|avif)(?:$|\?)/i.test(url)) return httpsMediaUrl(url);
  return "";
}

function embeddedVideoLink(value) {
  if (typeof value !== "string") return "";
  for (const match of value.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const candidate = match[1].replaceAll("&amp;", "&");
    if (isVideoMedia(candidate)) return httpsMediaUrl(candidate);
  }
  return "";
}

function isAudioMedia(url, mimeType = "") {
  return mimeType.toLowerCase().startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg)(?:$|\?)/i.test(url);
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
    contentText: source.allowFullText === true ? cleanFeedText(record.contentText, 30000) : "",
    imageUrl: source.allowMedia === true ? httpsMediaUrl(record.imageUrl) : "",
    videoUrl: source.allowMedia === true ? httpsMediaUrl(record.videoUrl) : "",
    sourceName: safeString(record.sourceName, 200),
    author: safeString(record.author, 200),
    language: safeString(record.language, 20) || source.language,
    country: safeString(record.country, 50) || source.country,
    category: classifyCategory(record.category, title, description, source.category),
    publishedAt,
    dedupeKey: hash(canonicalUrl),
    titleFingerprint: hash(`${normalizedTitle}|${publishDay}`)
  };
}

async function fetchJson(url, { includeErrorBody = false } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { Accept: "application/json" } });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const responseBody = includeErrorBody ? (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300) : "";
    throw new Error(`Provider returned HTTP ${response.status}${retryAfter ? `; retry after ${retryAfter}` : ""}.${responseBody ? ` ${responseBody}` : ""}`);
  }
  return response.json();
}

async function collectNewsData(source) {
  if (!process.env.NEWSDATA_API_KEY) throw new Error("Set NEWSDATA_API_KEY in the server environment before enabling this source.");
  const url = new URL("https://newsdata.io/api/1/latest");
  url.searchParams.set("apikey", process.env.NEWSDATA_API_KEY);
  url.searchParams.set("language", source.language || "hi,en");
  url.searchParams.set("country", source.country || "in");
  const requestedSize = Number(process.env.NEWSDATA_PAGE_SIZE) || 10;
  url.searchParams.set("size", String(Math.min(Math.max(requestedSize, 1), 50)));
  if (source.allowFullText === true) url.searchParams.set("full_content", "1");
  if (source.endpoint) url.searchParams.set("q", source.endpoint.trim());
  const payload = await fetchJson(url);
  if (payload.status !== "success" || !Array.isArray(payload.results)) {
    throw new Error(payload.results?.message || payload.message || "NewsData.io returned an unexpected response.");
  }
  return payload.results.map(item => ({
    title: item.title,
    description: item.description,
    contentText: source.allowFullText === true ? item.content : "",
    url: item.link,
    imageUrl: item.image_url,
    videoUrl: item.video_url,
    sourceName: item.source_name || item.source_id,
    author: item.creator,
    language: item.language,
    country: item.country,
    category: item.category,
    publishedAt: item.pubDate
  }));
}

async function collectGdelt(source) {
  let releaseRequestSlot;
  const previousRequest = gdeltRequestQueue;
  gdeltRequestQueue = new Promise(resolve => { releaseRequestSlot = resolve; });
  await previousRequest;
  try {
    const waitMs = gdeltNextRequestAt - Date.now();
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    gdeltNextRequestAt = Date.now() + GDELT_REQUEST_INTERVAL_MS;
  } finally {
    releaseRequestSlot();
  }

  const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  url.searchParams.set("query", source.endpoint?.trim() || "India");
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "50");
  url.searchParams.set("sort", "DateDesc");
  const gdeltLanguages = { en: "English", es: "Spanish", fr: "French", de: "German", hi: "Hindi", ar: "Arabic", pt: "Portuguese", ru: "Russian", zh: "Chinese" };
  if (source.language) {
    const preferredLanguage = source.language.split(",")[0].trim().toLowerCase();
    url.searchParams.set("sourcelang", gdeltLanguages[preferredLanguage] || preferredLanguage);
  }
  const payload = await fetchJson(url, { includeErrorBody: true });
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

export function gdeltRateLimitCooldownMs(source, now = Date.now()) {
  if (source.type !== "GDELT" || !source.lastFetchedAt ||
      !/(?:HTTP\s+429|limit requests to one every 5 seconds|rate.?limit)/i.test(source.lastFetchError || "")) return 0;
  const elapsed = now - new Date(source.lastFetchedAt).getTime();
  return elapsed >= 0 && elapsed < GDELT_RATE_LIMIT_COOLDOWN_MS
    ? GDELT_RATE_LIMIT_COOLDOWN_MS - elapsed
    : 0;
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
  return (feed.items || []).map(item => {
    const attachments = feedMediaItems(item);
    const mediaContentItems = [
      ...asArray(item.mediaContent),
      ...asArray(item.mediaGroup).flatMap(group => asArray(group?.["media:content"]))
    ];
    const embeddedContent = `${typeof item.content === "string" ? item.content : ""} ${typeof item["content:encoded"] === "string" ? item["content:encoded"] : ""} ${typeof item.summary === "string" ? item.summary : ""}`;
    return {
      title: item.title,
      description: item.contentSnippet || item.summary,
      contentText: source.allowFullText === true ? (item["content:encoded"] || item.content || item.summary || "") : "",
      url: item.link,
      imageUrl: attachments.map(imageUrl).find(Boolean) || asArray(item.mediaThumbnail).map(mediaFieldUrl).map(value => httpsMediaUrl(value)).find(Boolean) ||
        mediaContentItems.map(item => {
          const url = mediaFieldUrl(item);
          return /\.(jpg|jpeg|png|gif|webp|avif)(?:$|\?)/i.test(url) ? httpsMediaUrl(url) : "";
        }).find(Boolean) || "",
      videoUrl: attachments.map(mediaUrl).find(Boolean) || embeddedVideoLink(embeddedContent),
      sourceName: feed.title || source.name,
      author: item.creator || item.author,
      language: source.language,
      country: source.country,
      category: item.categories?.[0] || source.category,
      publishedAt: item.isoDate || item.pubDate
    };
  });
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

export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

async function fetchOneSource(source) {
  const cooldownMs = gdeltRateLimitCooldownMs(source);
  if (cooldownMs > 0) {
    return {
      source,
      records: [],
      error: null,
      skippedReason: `GDELT rate-limit cooldown active; retry in ${Math.ceil(cooldownMs / 1000)} seconds.`
    };
  }
  try {
    return { source, records: await fetchSource(source), error: null };
  } catch (error) {
    return { source, records: [], error };
  }
}

async function collectOneSource(source, records, fetchError, skippedReason) {
  if (skippedReason) {
    await NewsSource.updateOne(
      { _id: source._id },
      { $set: { lastFetchStatus: `Skipped · ${skippedReason}` } }
    );
    return { sourceId: String(source._id), sourceName: source.name, cooldownSkipped: true, message: skippedReason, fetched: 0, inserted: 0, duplicates: 0, skipped: 0 };
  }
  try {
    if (fetchError) throw fetchError;
    const articles = [];
    let skipped = 0;
    for (const record of records) {
      const article = normalizeRecord(record, source);
      if (!article) {
        skipped += 1;
        continue;
      }
      articles.push(article);
    }
    const operations = articles.map(article => ({
      updateOne: {
        filter: { $or: [{ dedupeKey: article.dedupeKey }, { titleFingerprint: article.titleFingerprint }] },
        update: { $setOnInsert: { ...article, status: "collected", collectedAt: new Date() } },
        upsert: true
      }
    }));
    const writeResult = operations.length
      ? await SourceArticle.bulkWrite(operations, { ordered: true })
      : { upsertedCount: 0 };
    const inserted = writeResult.upsertedCount ?? writeResult.nUpserted ?? 0;
    const duplicates = articles.length - inserted;
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
    const fetchedSources = await mapWithConcurrency(sources, SOURCE_FETCH_CONCURRENCY, fetchOneSource);
    const results = [];
    for (const { source, records, error, skippedReason } of fetchedSources) {
      results.push(await collectOneSource(source, records, error, skippedReason));
    }
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

const DEFAULT_SITE_ORIGIN = "https://www.kraantiinfo.in";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029"
  })[character]);
}

export function canonicalSiteOrigin(value = DEFAULT_SITE_ORIGIN) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return DEFAULT_SITE_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}

function validDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function articleHtml(article, canonicalUrl) {
  const title = escapeHtml(article.title);
  const summary = escapeHtml(article.summary);
  const category = escapeHtml(article.category);
  const author = escapeHtml(article.author || "KraantiInfo Desk");
  const publishedAt = validDate(article.publishedAt);
  const dateLabel = publishedAt
    ? new Intl.DateTimeFormat("hi-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(publishedAt))
    : "";
  const imageUrl = typeof article.image === "string" && /^https:\/\//i.test(article.image) ? article.image : "";
  const imageAlt = escapeHtml(article.imageAlt || article.title);
  const paragraphs = String(article.body || "").split(/\n{2,}/).map(text => text.trim()).filter(Boolean);
  const body = paragraphs.map((paragraph, index) => `${index === 1 ? "<h2>मुख्य बातें</h2>" : ""}<p>${escapeHtml(paragraph)}</p>`).join("");
  const sourceName = escapeHtml(article.sourceName || "KraantiInfo");
  const sourceUrl = typeof article.sourceUrl === "string" && /^https:\/\//i.test(article.sourceUrl) ? article.sourceUrl : "";

  return `<main class="content-wrap"><article class="article-view"><a class="back-link" href="/">← ताज़ा खबरें</a><div class="article-kicker">${category}</div><h1>${title}</h1><p class="article-deck">${summary}</p><div class="article-byline"><span class="author-avatar">K</span><span>लेखक: <strong>${author}</strong>${dateLabel ? `<small><time datetime="${escapeHtml(publishedAt)}">${escapeHtml(dateLabel)}</time></small>` : ""}</span></div>${imageUrl ? `<figure class="article-figure"><img src="${escapeHtml(imageUrl)}" alt="${imageAlt}" /><figcaption>${imageAlt}</figcaption></figure>` : ""}<div class="article-layout"><div class="article-body"><p class="article-lead">${summary}</p>${body}<div class="source-credit"><div><strong>इस खबर के बारे में</strong><span>${sourceName}${sourceUrl ? ` · <a href="${escapeHtml(sourceUrl)}" rel="nofollow noopener" target="_blank">मूल स्रोत पढ़ें</a>` : ""}</span></div></div></div></div></article></main>`;
}

export function renderArticleSeoPage({ shell, article, siteOrigin = DEFAULT_SITE_ORIGIN }) {
  const origin = canonicalSiteOrigin(siteOrigin);
  const articleId = String(article?._id || "");
  if (!articleId || !article?.title || !article?.summary) throw new Error("Published article SEO data is incomplete.");
  const canonicalUrl = `${origin}/article/${encodeURIComponent(articleId)}`;
  const title = `${article.title} | KraantiInfo`;
  const description = String(article.summary).replace(/\s+/g, " ").trim().slice(0, 300);
  const image = typeof article.image === "string" && /^https:\/\//i.test(article.image) ? article.image : "";
  const publishedAt = validDate(article.publishedAt);
  const updatedAt = validDate(article.updatedAt) || publishedAt;
  const authorName = String(article.author || "KraantiInfo Desk");
  const schema = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: article.title,
    description,
    ...(image ? { image: [image] } : {}),
    articleSection: article.category,
    ...(publishedAt ? { datePublished: publishedAt } : {}),
    ...(updatedAt ? { dateModified: updatedAt } : {}),
    author: { "@type": "Organization", name: authorName, url: origin },
    publisher: {
      "@type": "Organization",
      name: "KraantiInfo",
      url: origin,
      logo: { "@type": "ImageObject", url: `${origin}/favicon.svg` }
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonicalUrl },
    inLanguage: article.language === "en" ? "en" : "hi"
  };
  const meta = [
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:site_name" content="KraantiInfo" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}" />`] : []),
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    ...(image ? [`<meta name="twitter:image" content="${escapeHtml(image)}" />`] : []),
    `<meta property="article:published_time" content="${escapeHtml(publishedAt)}" />`,
    `<meta property="article:modified_time" content="${escapeHtml(updatedAt)}" />`,
    `<script type="application/ld+json">${safeJson(schema)}</script>`
  ].join("\n    ");
  const articleData = safeJson({ ...article, _id: articleId });
  const html = String(shell || "").replace(/<html([^>]*)>/i, (_match, attributes) => `<html${attributes.replace(/\s+lang=("|')[^"']*\1/i, "") } lang="${article.language === "en" ? "en" : "hi"}">`);
  const withTitle = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  const withMeta = withTitle.replace(/<\/head>/i, `    ${meta}\n  </head>`);
  const withArticle = withMeta.replace(/<div id="root"><\/div>/i, `<div id="root">${articleHtml(article, canonicalUrl)}</div><script id="seo-article-data" type="application/json">${articleData}</script>`);
  if (withArticle === withMeta) throw new Error("The public site shell is missing its React root.");
  return withArticle;
}

export function createSitemapXml({ articles = [], categories = [], siteOrigin = DEFAULT_SITE_ORIGIN }) {
  const origin = canonicalSiteOrigin(siteOrigin);
  const entries = new Map();
  const put = (url, date) => {
    const lastmod = validDate(date);
    const previous = entries.get(url);
    if (!previous || (lastmod && lastmod > previous)) entries.set(url, lastmod || previous || "");
  };
  for (const article of articles) {
    if (article.status && article.status !== "published") continue;
    if (!article._id) continue;
    put(`${origin}/article/${encodeURIComponent(String(article._id))}`, article.updatedAt || article.publishedAt);
  }
  const latestPublished = articles.map(article => validDate(article.publishedAt)).filter(Boolean).sort().at(-1);
  put(`${origin}/`, latestPublished);
  for (const category of categories) {
    const slug = String(category).toLowerCase().replaceAll(" ", "-");
    const categoryLastmod = articles
      .filter(article => String(article.category || "").toLowerCase() === String(category).toLowerCase())
      .map(article => validDate(article.publishedAt))
      .filter(Boolean)
      .sort()
      .at(-1);
    put(`${origin}/category/${encodeURIComponent(slug)}`, categoryLastmod);
  }
  const urls = [...entries].map(([url, lastmod]) => `  <url>\n    <loc>${escapeHtml(url)}</loc>${lastmod ? `\n    <lastmod>${escapeHtml(lastmod)}</lastmod>` : ""}\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

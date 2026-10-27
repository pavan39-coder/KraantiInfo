import Article from "../models/Article.js";

const BLOGGER_API = "https://www.googleapis.com/blogger/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedAccessToken = "";
let accessTokenExpiresAt = 0;

export function isBloggerPublishingEnabled() {
  return process.env.BLOGGER_AUTO_PUBLISH_ENABLED === "true";
}

export function isBloggerConfigured() {
  return Boolean(
    process.env.BLOGGER_BLOG_ID &&
    process.env.BLOGGER_CLIENT_ID &&
    process.env.BLOGGER_CLIENT_SECRET &&
    process.env.BLOGGER_REFRESH_TOKEN
  );
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function getSyncLabel(articleId) {
  return `kraantiinfo-article-${String(articleId).replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

export function buildBloggerContent(article, articleUrl = "") {
  const paragraphs = String(article.body || article.summary || "")
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => {
      const heading = paragraph.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length === 3 ? "h3" : "h2";
        return `<${level}>${escapeHtml(heading[2])}</${level}>`;
      }
      return `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  const imageUrl = /^https:\/\//i.test(article.image || "") ? article.image : "";
  const image = imageUrl
    ? `<figure><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(article.imageAlt || article.title)}" /></figure>`
    : "";
  const sourceUrl = /^https:\/\//i.test(article.sourceUrl || "") ? article.sourceUrl : "";
  const source = sourceUrl
    ? `<p><strong>Source:</strong> <a href="${escapeHtml(sourceUrl)}" rel="nofollow noopener">${escapeHtml(article.sourceName || "Original source")}</a></p>`
    : "";
  const KraantiInfo = articleUrl
    ? `<p><small>Originally published on <a href="${escapeHtml(articleUrl)}">KraantiInfo</a>.</small></p>`
    : "";
  const disclosure = article.autoPublished
    ? "<p><small>This AI-assisted report was automatically published from attributed source material and has not been independently verified.</small></p>"
    : "";
  return [
    `<p><em>${escapeHtml(article.summary || "")}</em></p>`, image, paragraphs,
    source, disclosure, KraantiInfo
  ].filter(Boolean).join("\n");
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60_000) return cachedAccessToken;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.BLOGGER_CLIENT_ID,
      client_secret: process.env.BLOGGER_CLIENT_SECRET,
      refresh_token: process.env.BLOGGER_REFRESH_TOKEN,
      grant_type: "refresh_token"
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    cachedAccessToken = "";
    accessTokenExpiresAt = 0;
    throw new Error(`Google OAuth token refresh failed (${response.status}): ${data.error_description || data.error || "Check Blogger OAuth credentials."}`);
  }
  cachedAccessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function bloggerRequest(path, options = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${BLOGGER_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers
    },
    signal: AbortSignal.timeout(20_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Blogger API request failed (${response.status}).`;
    throw new Error(message.slice(0, 500));
  }
  return data;
}

async function findExistingPost(blogId, label) {
  const query = new URLSearchParams({ labels: label, status: "live", maxResults: "10", fetchBodies: "false" });
  const data = await bloggerRequest(`/blogs/${encodeURIComponent(blogId)}/posts?${query}`);
  return data.items?.find(post => post.labels?.includes(label)) || null;
}

function articleUrl(article) {
  const base = (process.env.PUBLIC_SITE_URL || "https://kraantiinfo.vercel.app").replace(/\/$/, "");
  return `${base}/?article=${encodeURIComponent(String(article._id))}`;
}

export async function publishArticleToBlogger(article, { force = false } = {}) {
  if (!isBloggerPublishingEnabled()) return { status: "disabled", message: "Blogger auto-publishing is disabled." };
  if (!isBloggerConfigured()) return { status: "not_configured", message: "Blogger OAuth credentials and BLOGGER_BLOG_ID are not configured." };
  if (article.status !== "published") throw new Error("Only KraantiInfo articles already published to the site can be sent to Blogger.");
  if (!article._id) throw new Error("The published article must have a database ID before Blogger sync.");
  if (article.bloggerSync?.status === "published" && article.bloggerSync?.postId && !force) {
    return { status: "published", postId: article.bloggerSync.postId, postUrl: article.bloggerSync.postUrl };
  }

  const label = article.bloggerSync?.label || getSyncLabel(article._id);
  const labels = [...new Set([
    "KraantiInfo",
    article.category,
    ...(Array.isArray(article.tags) ? article.tags : []),
    label
  ].map(value => String(value || "").trim()).filter(Boolean))];
  article.bloggerSync = {
    status: "pending",
    postId: article.bloggerSync?.postId || "",
    postUrl: article.bloggerSync?.postUrl || "",
    label,
    lastAttemptAt: new Date(),
    error: ""
  };
  await article.save();

  try {
    const blogId = process.env.BLOGGER_BLOG_ID;
    // Blogger labels provide an idempotency key so a retry after a network timeout
    // can find a post that Google created even if its first response was lost.
    let post = article.bloggerSync?.postId
      ? await bloggerRequest(`/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(article.bloggerSync.postId)}?fetchBody=false`)
      : await findExistingPost(blogId, label);
    if (!post) {
      post = await bloggerRequest(`/blogs/${encodeURIComponent(blogId)}/posts`, {
        method: "POST",
        body: JSON.stringify({
          kind: "blogger#post",
          blog: { id: blogId },
          title: article.title,
          content: buildBloggerContent(article, articleUrl(article)),
          labels,
          isDraft: false
        })
      });
    }
    if (!post.id) throw new Error("Blogger did not return a post ID.");
    article.bloggerSync = { status: "published", postId: post.id, postUrl: post.url || "", label, lastAttemptAt: new Date(), error: "" };
    await article.save();
    return { status: "published", postId: post.id, postUrl: post.url || "" };
  } catch (error) {
    article.bloggerSync = { status: "failed", postId: article.bloggerSync?.postId || "", postUrl: article.bloggerSync?.postUrl || "", label, lastAttemptAt: new Date(), error: error.message.slice(0, 500) };
    await article.save();
    throw error;
  }
}

export async function retryFailedBloggerArticles({ limit = 25 } = {}) {
  if (!isBloggerPublishingEnabled() || !isBloggerConfigured()) {
    return { enabled: false, attempted: 0, published: 0, failed: 0 };
  }
  const articles = await Article.find({ status: "published", "bloggerSync.status": "failed" })
    .sort({ "bloggerSync.lastAttemptAt": 1 })
    .limit(Math.min(Math.max(Number(limit) || 25, 1), 100));
  let published = 0;
  let failed = 0;
  for (const article of articles) {
    try {
      await publishArticleToBlogger(article);
      published += 1;
    } catch (error) {
      failed += 1;
      console.error(`Blogger retry failed for KraantiInfo article ${article._id}: ${error.message}`);
    }
  }
  return { enabled: true, attempted: articles.length, published, failed };
}



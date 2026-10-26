import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, Clock3,
  Globe2, Menu, Newspaper, Search, Send, Settings2, ShieldCheck, Sparkles, X
} from "lucide-react";
import { API } from "./config.js";
import { brandedAuthor } from "./branding.js";
import { fallbackStories } from "./data/demoStories.js";
import { categories as newsCategories } from "./data/categories.js";
import { StoryCard, StoryImage } from "./components/StoryCard.jsx";
import AdminDashboard from "./features/newsroom/AdminDashboard.jsx";

function formatDate(value) {
  return new Intl.DateTimeFormat("hi-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(value));
}

function articleIdFromLocation() {
  const pathId = window.location.pathname.match(/^\/article\/([^/]+)\/?$/)?.[1];
  return pathId ? decodeURIComponent(pathId) : new URLSearchParams(window.location.search).get("article");
}

function categoryFromLocation() {
  const slug = window.location.pathname.match(/^\/category\/([^/]+)\/?$/)?.[1];
  if (!slug) return "Top stories";
  const requested = decodeURIComponent(slug).replaceAll("-", " ").toLowerCase();
  return newsCategories.find(item => item.toLowerCase() === requested) || "Top stories";
}

function categoryPath(value) {
  return value === "Top stories" || value === "All"
    ? "/"
    : `/category/${encodeURIComponent(value.toLowerCase().replaceAll(" ", "-"))}`;
}

function videoDetails(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be" || host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
      const id = host === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") || url.pathname.match(/\/(?:embed|shorts)\/([^/]+)/)?.[1];
      return id && /^[\w-]{6,20}$/.test(id) ? { kind: "embed", src: `https://www.youtube-nocookie.com/embed/${id}` } : { kind: "link", src: url.toString() };
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const id = url.pathname.match(/\/(?:video\/)?(\d+)/)?.[1];
      return id ? { kind: "embed", src: `https://player.vimeo.com/video/${id}` } : { kind: "link", src: url.toString() };
    }
    if (/\.(mp4|m4v|webm|ogv)$/i.test(url.pathname)) return { kind: "file", src: url.toString() };
    return { kind: "link", src: url.toString() };
  } catch {
    return null;
  }
}

function NewsVideo({ story }) {
  const video = videoDetails(story.videoUrl);
  if (!video) return null;
  return <section className="article-video"><h2>वीडियो</h2>{video.kind === "file"
    ? <video controls preload="metadata" src={video.src} aria-label={`${story.title} वीडियो`} />
    : video.kind === "embed"
      ? <iframe src={video.src} title={`${story.title} वीडियो`} loading="lazy" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
      : <a href={video.src} target="_blank" rel="noreferrer">मूल वीडियो देखें <ArrowUpRight size={14} /></a>}</section>;
}

function getRelatedStories(story, stories) {
  const tags = new Set((story.tags || []).map(tag => String(tag).toLowerCase()));
  return stories
    .filter(item => item._id !== story._id)
    .map(item => ({
      item,
      score: (item.category === story.category ? 2 : 0) + (item.tags || []).filter(tag => tags.has(String(tag).toLowerCase())).length
    }))
    .sort((left, right) => right.score - left.score || new Date(right.item.publishedAt) - new Date(left.item.publishedAt))
    .slice(0, 3)
    .map(({ item }) => item);
}

function formatIndianTime(value) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(value);
}

function App() {
  const [stories, setStories] = useState(import.meta.env.PROD ? [] : fallbackStories);
  const [category, setCategory] = useState(() => categoryFromLocation());
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminToken, setAdminToken] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [question, setQuestion] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [apiStatus, setApiStatus] = useState("demo");
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    let retryTimer;
    const loadStories = async () => {
      try {
        const healthResponse = await fetch(`${API}/health`);
        if (!healthResponse.ok) throw new Error("News service unavailable.");
        const health = await healthResponse.json();
        if (health.database === "connecting" || health.database === "disconnected") {
          if (!cancelled) {
            setApiStatus(import.meta.env.PROD ? "unavailable" : "demo");
            if (import.meta.env.PROD) setStories([]);
            retryTimer = window.setTimeout(loadStories, 5000);
          }
          return;
        }
        const response = await fetch(`${API}/articles?limit=100`);
        if (!response.ok) throw new Error("News service unavailable.");
        const payload = await response.json();
        if (!cancelled) {
          setStories(payload.demo && import.meta.env.PROD ? [] : Array.isArray(payload.data) ? payload.data : []);
          setApiStatus(payload.demo ? (import.meta.env.PROD ? "unavailable" : "demo") : "live");
        }
      } catch {
        if (!cancelled) {
          setApiStatus(import.meta.env.PROD ? "unavailable" : "demo");
          if (import.meta.env.PROD) setStories([]);
          retryTimer = window.setTimeout(loadStories, 5000);
        }
      }
    };
    loadStories();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    const articleId = articleIdFromLocation();
    if (!articleId || selected?._id === articleId) return;
    const existing = stories.find(story => String(story._id) === articleId);
    if (existing) {
      setSelected(existing);
      return;
    }
    if (apiStatus !== "live") return;
    fetch(`${API}/articles/${encodeURIComponent(articleId)}`)
      .then(response => response.ok ? response.json() : null)
      .then(payload => { if (payload?.data) setSelected(payload.data); })
      .catch(() => {});
  }, [stories, apiStatus, selected?._id]);

  useEffect(() => {
    const onPopState = () => {
      const articleId = articleIdFromLocation();
      if (!articleId) setSelected(null);
      else {
        const story = stories.find(item => String(item._id) === articleId);
        if (story) setSelected(story);
      }
      setCategory(categoryFromLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [stories]);

  useEffect(() => {
    const defaultTitle = category === "Top stories" ? "KraantiInfo — हिंदी समाचार, सोच-समझकर" : `${category} समाचार — KraantiInfo`;
    const description = selected?.summary || (category === "Top stories"
      ? "भारत और दुनिया की खबरें, खेल और क्रिकेट की ताज़ा जानकारी — KraantiInfo पर हिंदी में."
      : `${category} की ताज़ा खबरें और रिपोर्ट हिंदी में — KraantiInfo.`);
    document.documentElement.lang = selected?.language || "hi";
    document.title = selected ? `${selected.title} | KraantiInfo` : defaultTitle;
    let descriptionTag = document.querySelector('meta[name="description"]');
    if (!descriptionTag) {
      descriptionTag = document.createElement("meta");
      descriptionTag.name = "description";
      document.head.append(descriptionTag);
    }
    descriptionTag.content = description.slice(0, 300);
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.append(canonical);
    }
    const canonicalOrigin = (import.meta.env.KRAANTIINFO_PUBLIC_SITE_URL || window.location.origin).replace(/\/+$/, "");
    const canonicalUrl = selected
      ? `${canonicalOrigin}/article/${encodeURIComponent(selected._id)}`
      : `${canonicalOrigin}${categoryPath(category)}`;
    canonical.href = canonicalUrl;
    const metaValues = [
      ["property", "og:title", selected ? `${selected.title} | KraantiInfo` : defaultTitle],
      ["property", "og:description", description.slice(0, 300)],
      ["property", "og:url", canonicalUrl],
      ["property", "og:type", selected ? "article" : "website"],
      ["property", "og:image", selected?.image || ""],
      ["name", "twitter:card", selected?.image ? "summary_large_image" : "summary"],
      ["name", "twitter:title", selected ? `${selected.title} | KraantiInfo` : defaultTitle],
      ["name", "twitter:description", description.slice(0, 300)]
    ];
    for (const [attribute, key, content] of metaValues) {
      let tag = document.querySelector(`meta[${attribute}="${key}"]`);
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute(attribute, key);
        document.head.append(tag);
      }
      tag.content = content;
    }
    document.getElementById("news-article-schema")?.remove();
    if (selected) {
      const schema = document.createElement("script");
      schema.id = "news-article-schema";
      schema.type = "application/ld+json";
      schema.textContent = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: selected.title,
        description: selected.summary,
        image: selected.image ? [selected.image] : undefined,
        articleSection: selected.category,
        datePublished: selected.publishedAt,
        dateModified: selected.updatedAt || selected.publishedAt,
        author: { "@type": "Organization", name: brandedAuthor(selected.author) },
        publisher: { "@type": "Organization", name: "KraantiInfo" },
        mainEntityOfPage: canonicalUrl,
        inLanguage: selected.language || "hi"
      });
      document.head.append(schema);
    }
    return () => document.getElementById("news-article-schema")?.remove();
  }, [selected, category]);

  const filteredStories = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return stories.filter(story => {
      const categoryMatch = category === "Top stories" || category === "All" || story.category.toLowerCase() === category.toLowerCase();
      const queryMatch = !needle || `${story.title} ${story.summary} ${story.category} ${(story.tags || []).join(" ")}`.toLowerCase().includes(needle);
      return categoryMatch && queryMatch;
    });
  }, [stories, category, query]);
  const leadStory = filteredStories[0] || stories[0];
  const sideStories = (filteredStories.length > 1 ? filteredStories : stories).slice(1, 3);

  function openCategory(value) {
    setCategory(value);
    setSelected(null);
    window.history.replaceState({}, "", categoryPath(value));
    setAdminOpen(false);
    setMobileMenu(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openStory(story) {
    setSelected(story);
    window.history.pushState({}, "", `/article/${encodeURIComponent(story._id)}`);
    setAssistantOpen(false);
    setQuestions([]);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeStory() {
    setSelected(null);
    window.history.replaceState({}, "", categoryPath(category));
  }

  async function askAssistant(event) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || !selected || assistantLoading) return;
    setQuestions(previous => [...previous, { role: "user", text: prompt }]);
    setQuestion("");
    setAssistantLoading(true);
    try {
      const response = await fetch(`${API}/assistant/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: prompt, article: selected })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Assistant unavailable");
      setQuestions(previous => [...previous, { role: "assistant", text: result.answer }]);
    } catch (error) {
      setQuestions(previous => [...previous, { role: "assistant", text: error.message || "KraantiInfo AI is unavailable right now. Please try again later." }]);
    } finally {
      setAssistantLoading(false);
    }
  }

  const navItems = newsCategories;

  return (
    <div className="app-shell">
      <div className="utility-bar">
        <div className="utility-inner">
          <span>{formatDate(new Date())} <i /> New Delhi</span>
          <div className="utility-right"><span className="demo-indicator"><span /> {apiStatus === "demo" ? "DEMO EDITION" : apiStatus === "unavailable" ? "NEWSROOM OFFLINE" : "LIVE EDITION"}</span><button onClick={() => setAdminOpen(!adminOpen)}>Newsroom <ArrowUpRight size={13} /></button></div>
        </div>
      </div>

      <header className="masthead">
        <button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Open menu"><Menu /></button>
        <div className="masthead__side">
          <button className="icon-button" onClick={() => setSearchOpen(!searchOpen)} aria-label="Search"><Search size={20} /></button>
          <span className="side-label">Independent perspectives</span>
        </div>
        <button className="brand" onClick={() => { closeStory(); setAdminOpen(false); setCategory("Top stories"); window.history.replaceState({}, "", "/"); }} aria-label="KraantiInfo home">
          <span className="brand-mark">K<span>.</span></span>
          <span className="brand-name">KRAANTI<span>INFO</span></span>
          <span className="brand-tagline">NEWS, THOUGHTFULLY TOLD</span>
        </button>
        <div className="masthead__actions">
          <button className="subscribe-button" onClick={() => setSaveMessage("Thank you — newsletter sign-up is coming soon.")}>The daily briefing <ArrowRight size={15} /></button>
        </div>
      </header>

      {searchOpen && <div className="search-row"><Search size={17} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search stories, topics and more" /><button onClick={() => { setQuery(""); setSearchOpen(false); }} aria-label="Close search"><X size={18} /></button></div>}

      <nav className={`category-nav ${mobileMenu ? "category-nav--open" : ""}`}>
        <button className="nav-home" onClick={() => openCategory("Top stories")}><Globe2 size={15} /> Top stories</button>
        {navItems.map(item => <a key={item} className={category === item ? "is-active" : ""} href={categoryPath(item)} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); openCategory(item); }}>{item}</a>)}
        <button className="nav-more" onClick={() => setAdminOpen(!adminOpen)}><Settings2 size={14} /> Newsroom</button>
      </nav>

      {saveMessage && <div className="toast" role="status">{saveMessage}<button onClick={() => setSaveMessage("")} aria-label="Dismiss"><X size={15} /></button></div>}

      <main>
        {adminOpen ? (
          <AdminDashboard onExit={() => setAdminOpen(false)} token={adminToken} onLogin={setAdminToken} requireAuth={import.meta.env.PROD} />
        ) : selected ? (
          <article className="article-view">
            <button className="back-link" onClick={closeStory}><ArrowLeft size={16} /> Back to latest</button>
            <div className="article-kicker">{selected.category} <span> / </span> {selected.tags?.[0] || "Latest"}</div>
            <h1>{selected.title}</h1>
            <p className="article-deck">{selected.summary}</p>
            <div className="article-byline"><span className="author-avatar">K</span><span>By <strong>{brandedAuthor(selected.author)}</strong><small>{formatDate(selected.publishedAt)} · {selected.readTime || "4 min read"}{selected.autoPublished ? " · AI-assisted, automatically published; not independently verified" : selected.aiAssisted ? " · AI-assisted, editor-reviewed" : ""}</small></span><button className="article-share" onClick={() => { navigator.clipboard?.writeText(window.location.href); setSaveMessage("Article link copied."); }}><Bookmark size={16} /> Save story</button></div>
            {selected.image && <figure className="article-figure"><StoryImage story={selected} /><figcaption>{selected.imageAlt || selected.title} <span>{apiStatus === "demo" ? "PHOTO: KRAANTIINFO / DEMO" : "PHOTO: SOURCE"}</span></figcaption></figure>}
            <NewsVideo story={selected} />
            <div className="article-layout">
              <div className="article-body">
                {apiStatus === "demo" && <div className="demo-note"><ShieldCheck size={17} /><span><strong>Demo story.</strong> This sample content is illustrative, not breaking or independently verified news.</span></div>}
                <p className="article-lead">{selected.summary}</p>
                {selected.body ? selected.body.split(/\n{2,}/).filter(Boolean).map((paragraph, index) => index === 1 ? <div key={index}><h2>मुख्य बातें</h2><p>{paragraph}</p></div> : <p key={index}>{paragraph}</p>) : apiStatus === "demo" ? <>
                  <p>There is growing attention on this story and what it could mean for people, institutions and the wider community. The details will continue to develop as more verified information becomes available.</p>
                  <h2>What to know</h2>
                  <p>This KraantiInfo demo article illustrates the publication format. In production, an editor would review source material, verify important claims and add clear attribution before publication. This text is not a report of verified current events.</p>
                </> : <div className="article-unavailable"><strong>पूरा लेख अभी उपलब्ध नहीं है।</strong><p>प्रकाशक की अनुमति या पर्याप्त स्रोत सामग्री मिलने पर संपादकीय टीम इस रिपोर्ट को अपडेट करेगी।</p>{selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">मूल स्रोत पढ़ें <ArrowUpRight size={14} /></a>}</div>}
                <div className="source-credit"><ShieldCheck size={17} /><div><strong>About this story</strong><span>{selected.sourceName || "KraantiInfo Demo Desk"} · {apiStatus === "demo" ? "Sample content for product preview." : "Source attribution."} {selected.sourceUrl && <a href={selected.sourceUrl} target="_blank" rel="noreferrer">Open source</a>}</span></div></div>
                <div className="article-tags">{(selected.tags || []).map(tag => <button key={tag} onClick={() => openCategory(selected.category)}>#{tag}</button>)}</div>
              </div>
              <aside className="article-aside">
                <div className="assistant-promo"><div className="assistant-icon"><Sparkles size={19} /></div><span className="eyebrow">UNDERSTAND THE STORY</span><h3>Curious about the details?</h3><p>Ask KraantiInfo AI to explain this article in simple language.</p><button onClick={() => setAssistantOpen(true)}>Ask KraantiInfo AI <ArrowRight size={15} /></button><small>AI answers can be inaccurate. Check cited sources.</small></div>
                {assistantOpen && <div className="assistant-panel">
                  <div className="assistant-head"><span><Sparkles size={16} /> KraantiInfo AI <em>DEMO</em></span><button onClick={() => setAssistantOpen(false)} aria-label="Close assistant"><X size={17} /></button></div>
                  <div className="assistant-context">Answering about: <strong>{selected.title}</strong></div>
                  <div className="chat-messages">
                    <div className="chat-answer">Hello. I can help explain this demo article, summarize it or pull out key points. What would you like to know?</div>
                    {questions.map((item, index) => <div key={`${item.role}-${index}`} className={`chat-${item.role}`}>{item.text}</div>)}
                    {assistantLoading && <div className="chat-answer">Thinking…</div>}
                  </div>
                  <div className="quick-prompts">{["5 key points", "Explain simply"].map(prompt => <button key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div>
                  <form className="chat-input" onSubmit={askAssistant}><input value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about this article…" aria-label="Ask about this article" /><button type="submit" aria-label="Send question"><Send size={16} /></button></form>
                </div>}
              </aside>
            </div>
            <section className="related-section"><SectionHeading kicker="KEEP READING" title="इस विषय से जुड़ी खबरें" /><div className="story-grid story-grid--three">{getRelatedStories(selected, stories).map(story => <StoryCard key={story._id} story={story} onOpen={openStory} />)}</div></section>
          </article>
        ) : (
          <div className="content-wrap">
            <div className="edition-line"><span><span className="live-dot" /> THE INDIA EDITION</span><span>Independent journalism. Informed perspectives.</span><span>Updated {formatIndianTime(new Date())} IST <ArrowDownRight size={14} /></span></div>
            {category !== "Top stories" && <div className="filter-heading"><span>Browsing</span><h1>{category}</h1><button onClick={() => openCategory("Top stories")}>Clear filter <X size={14} /></button></div>}
            {query && <div className="filter-heading search-result-heading"><span>Search results for</span><h1>“{query}”</h1><button onClick={() => setQuery("")}>Clear search <X size={14} /></button></div>}
            {filteredStories.length === 0 ? <div className="empty-state"><Search size={25} /><h2>{apiStatus === "unavailable" ? "News feed is temporarily unavailable" : "No stories found"}</h2><p>{apiStatus === "unavailable" ? "Please check back soon for the latest KraantiInfo reports." : "Try another topic or browse all of our top stories."}</p><button onClick={() => { setQuery(""); openCategory("Top stories"); }}>Explore top stories</button></div> : (
              <>
                <section className="lead-grid" aria-label="Top stories">
                  <a className="lead-story" href={`/article/${encodeURIComponent(leadStory._id)}`} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); openStory(leadStory); }}>
                    <div className="lead-image"><StoryImage story={leadStory} /><span className="image-caption">{leadStory.imageAlt || leadStory.category} <i>{apiStatus === "demo" ? "KRAANTIINFO / DEMO" : "KRAANTIINFO"}</i></span></div>
                    <div className="lead-copy"><span className="eyebrow">{leadStory.category} <i /> THE BIG STORY</span><h1>{leadStory.title}</h1><p>{leadStory.summary}</p><span className="story-meta">{brandedAuthor(leadStory.author)} <i /> {leadStory.readTime || "4 min read"} <i /> <Clock3 size={13} /> 2 hours ago</span><span className="read-story">Read the story <ArrowRight size={16} /></span></div>
                  </a>
                  <div className="lead-side">
                    <div className="side-heading"><span>ALSO MAKING NEWS</span><ArrowUpRight size={15} /></div>
                    {sideStories.map((story, index) => <StoryCard key={story._id} story={story} onOpen={openStory} compact number={`0${index + 1}`} />)}
                    <div className="editors-note"><span className="eyebrow">THE EDITOR'S NOTE</span><p>Clarity over noise. Context alongside headlines. Journalism that helps you make sense of what matters.</p><span>THE KRAANTIINFO EDITORIAL TEAM</span></div>
                  </div>
                </section>
                <section className="latest-section">
                  <SectionHeading kicker="THE NEWSROOM" title={category === "Top stories" ? "Latest stories" : `Latest in ${category}`} action="View all stories" onAction={() => setCategory("All")} />
                  <div className="latest-layout"><div className="story-grid story-grid--two">{filteredStories.slice(1, 5).map(story => <StoryCard key={story._id} story={story} onOpen={openStory} />)}</div><MostRead stories={stories} onOpen={openStory} /></div>
                </section>
                <section className="topic-section"><SectionHeading kicker="A CLOSER LOOK" title="Across the country" action="Explore India" onAction={() => openCategory("India")} /><div className="story-grid story-grid--three">{stories.filter(story => story.category === "India" || story.category === "Science").slice(0, 3).map(story => <StoryCard key={story._id} story={story} onOpen={openStory} />)}</div></section>
                <BriefingBanner onSubscribe={() => setSaveMessage("Thank you — newsletter sign-up is coming soon.")} />
                <section className="topic-section"><SectionHeading kicker="IDEAS & INNOVATION" title="Technology & business" action="Explore more" onAction={() => openCategory("Technology")} /><div className="story-grid story-grid--three">{stories.filter(story => story.category === "Technology" || story.category === "Business").slice(0, 3).map(story => <StoryCard key={story._id} story={story} onOpen={openStory} />)}</div></section>
              </>
            )}
          </div>
        )}
      </main>
      <footer className="site-footer"><div className="footer-brand"><span className="brand-mark">K<span>.</span></span><div><strong>KRAANTIINFO</strong><span>NEWS, THOUGHTFULLY TOLD</span></div></div><p>Independent perspectives. Informed India.</p><div className="footer-links"><button onClick={() => setSaveMessage("About KraantiInfo — a newsroom built for clarity and context.")}>About</button><button onClick={() => setAdminOpen(true)}>The newsroom</button><span>© {new Date().getFullYear()} KraantiInfo <i /> {apiStatus === "demo" ? "Demo edition" : "Live edition"}</span></div></footer>
    </div>
  );
}

function SectionHeading({ kicker, title, action, onAction }) {
  return <div className="section-heading"><div><span className="eyebrow">{kicker}</span><h2>{title}</h2></div>{action && <button onClick={onAction}>{action} <ArrowRight size={15} /></button>}</div>;
}

function MostRead({ stories, onOpen }) {
  return <aside className="most-read"><span className="eyebrow">MOST READ</span><h2>What readers are following</h2>{stories.slice(0, 4).map((story, index) => <a className="most-read__item" key={story._id} href={`/article/${encodeURIComponent(story._id)}`} onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpen(story); }}><span>{String(index + 1).padStart(2, "0")}</span><strong>{story.title}</strong><ArrowUpRight size={15} /></a>)}</aside>;
}

function BriefingBanner({ onSubscribe }) {
  return <section className="briefing-banner"><div className="briefing-mark"><Newspaper size={22} /></div><div><span className="eyebrow">A CLEAR START TO YOUR DAY</span><h2>The KraantiInfo briefing</h2><p>Thoughtful stories and essential context, in your inbox.</p></div><button onClick={onSubscribe}>Get the briefing <ArrowRight size={16} /></button></section>;
}

export default App;


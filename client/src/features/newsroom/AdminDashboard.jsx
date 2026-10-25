import React, { useEffect, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, Clock3, Command,
  ExternalLink, Newspaper, Settings2, ShieldCheck, Sparkles, X
} from "lucide-react";
import { API } from "../../config.js";
import { categories } from "../../data/categories.js";
import { fallbackStories } from "../../data/demoStories.js";
import { EditorialQueue } from "./components/EditorialQueue.jsx";

const MINIMUM_ARTICLE_WORDS = 500;

function countWords(value) {
  return typeof value === "string"
    ? (value.match(/[\p{L}\p{M}\p{N}]+(?:[’'][\p{L}\p{M}\p{N}]+)*/gu) || []).length
    : 0;
}

function AdminDashboard({ onExit, token, onLogin, requireAuth }) {
  const [overview, setOverview] = useState({ demo: true, counts: { published: fallbackStories.length, review: 3, drafts: 2 }, engine: { enabled: false, lastRun: null } });
  const [collectedArticles, setCollectedArticles] = useState([]);
  const [editorialArticles, setEditorialArticles] = useState([]);
  const [publishedArticles, setPublishedArticles] = useState([]);
  const [editingCandidate, setEditingCandidate] = useState(null);
  const [draftForm, setDraftForm] = useState({ title: "", summary: "", body: "", category: "India", author: "KraantiInfo Desk" });
  const [sources, setSources] = useState([
    { _id: "s1", name: "NewsData.io (not configured)", type: "NEWSDATA", category: "India", enabled: false, reliabilityScore: 85, lastFetchStatus: "API key required" },
    { _id: "s2", name: "GDELT (global news)", type: "GDELT", category: "World", enabled: false, reliabilityScore: 80, lastFetchStatus: "Not configured" },
    { _id: "s3", name: "Government / RSS feed", type: "GOVERNMENT_FEED", category: "India", enabled: false, reliabilityScore: 95, lastFetchStatus: "Feed URL required" }
  ]);
  const [runStatus, setRunStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [editingSource, setEditingSource] = useState(null);
  const [sourceSettings, setSourceSettings] = useState({ language: "hi,en", category: "India", allowFullText: false, allowMedia: false });
  const [newSource, setNewSource] = useState({ name: "", type: "NEWSDATA", endpoint: "", language: "hi,en", country: "in", category: "India", allowFullText: false, allowMedia: false, reliabilityScore: 75 });
  const authorization = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    if (requireAuth && !token) {
      setError("");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const [overviewResponse, sourceResponse] = await Promise.all([
          fetch(`${API}/admin/overview`, { headers: authorization }),
          fetch(`${API}/admin/sources`, { headers: authorization })
        ]);
        if (overviewResponse.status === 401 || sourceResponse.status === 401) {
          throw new Error("Your newsroom session has expired. Please sign in again.");
        }
        if (!overviewResponse.ok || !sourceResponse.ok) {
          throw new Error("Could not load newsroom data. Please retry in a moment.");
        }
        const overviewData = await overviewResponse.json();
        const sourceData = await sourceResponse.json();
        if (cancelled) return;
        setOverview(overviewData);
        if (sourceData.data?.length) setSources(sourceData.data);
        if (!overviewData.demo) {
          const [candidateResponse, editorialResponse, publishedResponse] = await Promise.all([
            fetch(`${API}/admin/collected-articles`, { headers: authorization }),
            fetch(`${API}/admin/editorial/articles`, { headers: authorization }),
            fetch(`${API}/admin/editorial/published-articles?limit=25`, { headers: authorization })
          ]);
          if (candidateResponse.status === 401 || editorialResponse.status === 401) {
            throw new Error("Your newsroom session has expired. Please sign in again.");
          }
          if (!candidateResponse.ok || !editorialResponse.ok) {
            throw new Error("Could not load editorial news. Please retry in a moment.");
          }
          const [candidatePayload, editorialPayload, publishedPayload] = await Promise.all([
            candidateResponse.json(), editorialResponse.json(),
            publishedResponse.ok ? publishedResponse.json() : Promise.resolve({ data: [] })
          ]);
          if (cancelled) return;
          setCollectedArticles(candidatePayload.data || []);
          setEditorialArticles(editorialPayload.data || []);
          setPublishedArticles(publishedPayload.data || []);
        }
        setError("");
      } catch (err) {
        if (!cancelled) setError(err.message || "Newsroom is temporarily unavailable. Please retry.");
      }
    })();

    return () => { cancelled = true; };
  }, [token, requireAuth]);

  if (requireAuth && !token) return <AdminLogin onLogin={onLogin} onExit={onExit} />;

  async function runDemo() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/admin/engine/run-demo`, { method: "POST", headers: authorization });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Demo discovery failed.");
      setRunStatus(`Demo run complete · ${result.found} stories found · ${result.needsReview} sent to editorial review. No external sources contacted.`);
      setOverview(previous => ({ ...previous, engine: { ...previous.engine, lastRun: new Date().toISOString() } }));
    } catch (err) {
      setError(err.message || "Demo discovery could not run.");
    } finally {
      setBusy(false);
    }
  }

  async function runCollector() {
    setBusy(true);
    setError("");
    setRunStatus("");
    try {
      const response = await fetch(`${API}/admin/engine/collect`, { method: "POST", headers: authorization });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "News collection failed.");
      const editorial = result.editorial || {};
      const automationError = editorial.failures?.[0]?.error;
      setRunStatus(`Collection finished · ${result.fetched} fetched · ${result.inserted} new candidates saved · ${result.duplicates} duplicates skipped · ${result.errors} source errors.${editorial.enabled ? ` AI published ${editorial.published || 0} · sent ${editorial.review || 0} to review.${automationError ? ` AI note: ${automationError}` : ""}` : ""}`);
      await loadCollectorSources();
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "News collection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runEditorialAutomation() {
    setBusy(true);
    setError("");
    setRunStatus("");
    try {
      const response = await fetch(`${API}/admin/editorial/automation/run`, {
        method: "POST",
        headers: authorization
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "AI processing could not run.");
      const result = payload.data;
      const failureSummary = result.failures?.length
        ? ` ${result.failed} failed: ${result.failures.map(item => item.error).filter((value, index, values) => values.indexOf(value) === index).join(" ")}`
        : "";
      const bloggerNote = result.blogger?.status === "published" ? " Blogger copy published." : result.blogger?.status === "failed" ? " Blogger sync failed; it is saved as a retryable error." : result.blogger?.status === "not_configured" ? " Blogger is not connected yet." : "";
      setRunStatus(`AI processing finished · ${result.eligible || 0} candidates considered · ${result.published || 0} published · ${result.review || 0} sent to review.${bloggerNote}${result.selectionReason ? ` Why it was selected: ${result.selectionReason}` : ""}${failureSummary}`);
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "AI processing could not run.");
    } finally {
      setBusy(false);
    }
  }

  async function retryBloggerSync() {
    setBusy(true);
    setError("");
    setRunStatus("");
    try {
      const response = await fetch(`${API}/admin/blogger/retry-failed`, { method: "POST", headers: authorization });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Blogger retry could not run.");
      const result = payload.data;
      setRunStatus(`Blogger retry finished · ${result.attempted} attempted · ${result.published} published · ${result.failed} still failed.`);
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "Blogger retry could not run.");
    } finally {
      setBusy(false);
    }
  }

  async function syncPublishedArticleToBlogger(article) {
    setBusy(true);
    setError("");
    setRunStatus("");
    try {
      const response = await fetch(`${API}/admin/editorial/articles/${article._id}/blogger-sync`, {
        method: "POST",
        headers: authorization
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "This article could not be synced to Blogger.");
      setRunStatus(payload.blogger?.status === "published"
        ? `Blogger copy published · ${article.title}`
        : `Blogger sync status: ${payload.blogger?.status || "unknown"} · ${article.title}`);
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "This article could not be synced to Blogger.");
    } finally {
      setBusy(false);
    }
  }

  async function loadCollectorSources() {
    try {
      const response = await fetch(`${API}/admin/sources`, { headers: authorization });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not refresh sources.");
      setSources(payload.data || []);
    } catch (err) {
      setError(err.message || "Could not refresh sources.");
    }
  }

  async function refreshEditorial() {
    const [candidateResponse, editorialResponse, overviewResponse, publishedResponse] = await Promise.all([
      fetch(`${API}/admin/collected-articles`, { headers: authorization }),
      fetch(`${API}/admin/editorial/articles`, { headers: authorization }),
      fetch(`${API}/admin/overview`, { headers: authorization }),
      fetch(`${API}/admin/editorial/published-articles?limit=25`, { headers: authorization })
    ]);
    const candidatePayload = await candidateResponse.json();
    const editorialPayload = await editorialResponse.json();
    const overviewPayload = await overviewResponse.json();
    const publishedPayload = publishedResponse.ok ? await publishedResponse.json() : { data: [] };
    if (!candidateResponse.ok || !editorialResponse.ok || !overviewResponse.ok) {
      throw new Error(candidatePayload.error || editorialPayload.error || overviewPayload.error || "Could not refresh editorial queue.");
    }
    setCollectedArticles(candidatePayload.data || []);
    setEditorialArticles(editorialPayload.data || []);
    setPublishedArticles(publishedPayload.data || []);
    setOverview(overviewPayload);
  }

  function startDraft(candidate) {
    setEditingCandidate(candidate._id);
    setDraftForm({
      title: "",
      summary: "",
      body: "",
      category: categories.includes(candidate.category) ? candidate.category : "India",
      author: "KraantiInfo Desk"
    });
    setError("");
  }

  async function saveEditorialDraft(event, candidate) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/admin/collected-articles/${candidate._id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify(draftForm)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save the editorial draft.");
    setRunStatus("500+ word editorial draft saved. Review it and explicitly submit it for review before publication.");
      setEditingCandidate(null);
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "Could not save the editorial draft.");
    } finally {
      setBusy(false);
    }
  }

  async function generateCandidateDraft(candidate) {
    setBusy(true);
    setError("");
    setRunStatus("");
    try {
      const response = await fetch(`${API}/admin/collected-articles/${candidate._id}/generate-draft`, {
        method: "POST",
        headers: authorization
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "AI could not generate an editorial draft.");
      setRunStatus(`AI created an unpublished draft using ${payload.generatedBy}. Check its verification notes and edit it before review.`);
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "AI could not generate an editorial draft.");
    } finally {
      setBusy(false);
    }
  }

  async function updateEditorialStatus(article, status, confirmations = {}) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/admin/editorial/articles/${article._id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify({ status, ...confirmations })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not update editorial article.");
      const bloggerNote = payload.blogger?.status === "published" ? " Blogger copy published too." : payload.blogger?.status === "failed" ? " Blogger sync failed; use retry after checking the Blogger connection." : payload.blogger?.status === "not_configured" ? " Blogger is not connected yet." : "";
      setRunStatus(status === "published" ? `Article published to KraantiInfo.${bloggerNote}` : status === "review" ? "Article submitted to the review queue." : "Article rejected.");
      await refreshEditorial();
    } catch (err) {
      setError(err.message || "Could not update editorial article.");
    } finally {
      setBusy(false);
    }
  }

  async function saveArticleEdits(article, changes) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/admin/editorial/articles/${article._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify(changes)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save article edits.");
      setRunStatus("Editorial changes saved.");
      await refreshEditorial();
      return true;
    } catch (err) {
      setError(err.message || "Could not save article edits.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggleSource(source) {
    if (String(source._id).startsWith("s")) {
      setError("Sample sources are read-only. Connect MongoDB and add a configured source to enable it.");
      return;
    }
    try {
      const response = await fetch(`${API}/admin/sources/${source._id}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...authorization }, body: JSON.stringify({ enabled: !source.enabled }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not update source.");
      setSources(previous => previous.map(item => item._id === source._id ? payload.data : item));
    } catch (err) {
      setError(err.message || "Could not update source.");
    }
  }

  async function saveSourceSettings(event, source) {
    event.preventDefault();
    try {
      const response = await fetch(`${API}/admin/sources/${source._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify(sourceSettings)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save source settings.");
      setSources(previous => previous.map(item => item._id === source._id ? payload.data : item));
      setEditingSource(null);
      setRunStatus(`${source.name} source settings saved.`);
    } catch (err) {
      setError(err.message || "Could not save source settings.");
    }
  }

  function configureSource(source) {
    if (String(source._id).startsWith("s")) {
      setError("Sample sources are read-only. Add a configured source after connecting MongoDB.");
      return;
    }
    setSourceSettings({ language: ["hi", "hi,en", "en"].includes(source.language) ? source.language : "hi,en", category: categories.includes(source.category) ? source.category : "India", allowFullText: source.allowFullText === true, allowMedia: source.allowMedia === true });
    setEditingSource(editingSource === source._id ? null : source._id);
  }

  async function createSource(event) {
    event.preventDefault();
    setError("");
    try {
      const response = await fetch(`${API}/admin/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authorization },
        body: JSON.stringify({ ...newSource, reliabilityScore: Number(newSource.reliabilityScore) })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not add news source.");
      setSources(previous => [payload.data, ...previous]);
      setNewSource({ name: "", type: "NEWSDATA", endpoint: "", language: "hi,en", country: "in", category: "India", allowFullText: false, allowMedia: false, reliabilityScore: 75 });
      setShowSourceForm(false);
    } catch (err) {
      setError(err.message || "Could not add news source.");
    }
  }

  return (
    <div className="admin-shell">
      <div className="admin-top"><button onClick={onExit}><ArrowLeft size={16} /> Back to publication</button><span><span className="demo-indicator"><span /> {overview.demo ? "DEMO NEWSROOM" : "EDITORIAL DESK"}</span><button className="admin-profile"><span className="profile-dot">W</span> Editorial team <ChevronDown size={14} /></button></span></div>
      <div className="admin-title"><div><span className="eyebrow">KRAANTIINFO · EDITORIAL</span><h1>The newsroom</h1><p>Manage stories, sources and the editorial pipeline.</p></div><div className="collector-actions"><button className="outline-button" onClick={runCollector} disabled={busy || !overview.engine.enabled}><Sparkles size={16} /> {busy ? "Collecting…" : "Collect approved sources"}</button>{overview.automation?.enabled && <button className="candidate-action" onClick={runEditorialAutomation} disabled={busy}><Sparkles size={14} /> {busy ? "Processing…" : "Process AI candidates now"}</button>}{overview.blogger?.enabled && overview.blogger?.configured && <button className="candidate-action" onClick={retryBloggerSync} disabled={busy}><Newspaper size={14} /> Retry failed Blogger posts</button>}<button className="demo-run-button" onClick={runDemo} disabled={busy}>Run demo instead</button></div></div>
      {error && <div className="inline-alert"><ShieldCheck size={17} />{error}<button onClick={() => setError("")}><X size={15} /></button></div>}
      {runStatus && <div className="inline-alert inline-alert--success"><Check size={17} />{runStatus}<button onClick={() => setRunStatus("")}><X size={15} /></button></div>}
      <div className="admin-metrics">{[
        ["Published stories", overview.counts.published, "Available to readers", Newspaper],
        ["Needs review", overview.counts.review, "Editorial approval required", ShieldCheck],
        ["Drafts", overview.counts.drafts, "In the pipeline", Command],
        ["Collected candidates", overview.counts.collected || 0, "Awaiting editorial processing", Newspaper],
        ["Auto-publish", overview.automation?.autoPublishEnabled ? "Enabled" : "Paused", overview.automation?.autoPublishEnabled ? "Eligible low-risk stories only" : "Stories stay in review", ShieldCheck]
      ].map(([label, value, note, Icon]) => <div className="metric-card" key={label}><span>{label}<Icon size={17} /></span><strong>{value}</strong><small>{note}</small></div>)}</div>
      <div className="admin-columns">
        <section className="admin-panel sources-panel"><div className="panel-heading"><div><span className="eyebrow">DISCOVERY</span><h2>News sources</h2></div><button className="quiet-button" onClick={() => setShowSourceForm(value => !value)}>{showSourceForm ? "Close form" : "Add a source"} <ArrowRight size={14} /></button></div><p className="panel-description">Choose Hindi-first collection and a category. Full text and media are saved only when their separate reuse terms allow it.</p>
          {showSourceForm && <form className="source-form" onSubmit={createSource}>
            <label>Source name<input required maxLength="100" value={newSource.name} onChange={event => setNewSource({ ...newSource, name: event.target.value })} placeholder="e.g. Official ministry feed" /></label>
            <label>Type<select value={newSource.type} onChange={event => setNewSource({ ...newSource, type: event.target.value })}><option value="NEWSDATA">NewsData.io</option><option value="RSS">RSS feed</option><option value="GOVERNMENT_FEED">Government feed</option><option value="GDELT">GDELT</option></select></label>
            <label>{newSource.type === "RSS" || newSource.type === "GOVERNMENT_FEED" ? "HTTPS feed URL" : newSource.type === "GDELT" || newSource.type === "NEWSDATA" ? "Optional search query" : "Endpoint"}<input type={newSource.type === "RSS" || newSource.type === "GOVERNMENT_FEED" ? "url" : "text"} value={newSource.endpoint} onChange={event => setNewSource({ ...newSource, endpoint: event.target.value })} placeholder={newSource.type === "GDELT" ? "e.g. India AND (election OR parliament)" : newSource.type === "NEWSDATA" ? "Optional keywords" : "https://…" } /><small>{newSource.type === "NEWSDATA" ? "Key comes from server NEWSDATA_API_KEY." : newSource.type === "GDELT" ? "Uses GDELT DOC API; no key required." : "HTTPS only; never include credentials in the URL."}</small></label>
            <label>Category<select value={newSource.category} onChange={event => setNewSource({ ...newSource, category: event.target.value })}>{categories.map(item => <option key={item}>{item}</option>)}</select></label>
            <label>News language<select value={newSource.language} onChange={event => setNewSource({ ...newSource, language: event.target.value })}><option value="hi,en">Hindi first + English</option><option value="hi">Hindi</option><option value="en">English</option></select></label>
            <label>Country code<input maxLength="2" value={newSource.country} onChange={event => setNewSource({ ...newSource, country: event.target.value.toLowerCase() })} /><small>India is in</small></label>
            <label className="source-checkbox"><input type="checkbox" checked={newSource.allowFullText} onChange={event => setNewSource({ ...newSource, allowFullText: event.target.checked })} /> Source terms allow full-text storage</label>
            <label className="source-checkbox"><input type="checkbox" checked={newSource.allowMedia} onChange={event => setNewSource({ ...newSource, allowMedia: event.target.checked })} /> Source terms allow image/video reuse</label>
            <label>Reliability score<input type="number" min="0" max="100" value={newSource.reliabilityScore} onChange={event => setNewSource({ ...newSource, reliabilityScore: event.target.value })} /></label>
            <button type="submit">Save source <Check size={14} /></button>
          </form>}
          <div className="source-table"><div className="source-row source-row--header"><span>Source</span><span>Type</span><span>Reliability</span><span>Status</span><span>Settings</span><span>Enabled</span></div>
            {sources.map(source => <React.Fragment key={source._id}>
              <div className="source-row"><span className="source-name"><i className={`source-dot ${source.enabled ? "source-dot--on" : ""}`} /><strong>{source.name}</strong><small>{source.category} · {source.language || "hi,en"} · {source.allowFullText ? "Full text allowed" : "Metadata only"} · {source.allowMedia ? "Media allowed" : "No media"} · {source.lastFetchError || source.lastFetchStatus}{source.lastFetchedAt ? ` · ${new Date(source.lastFetchedAt).toLocaleString()}` : ""}</small></span><span className="source-type">{source.type.replace("_", " ")}</span><span>{source.reliabilityScore}%</span><span className="status-pill">{source.enabled ? "Enabled" : "Inactive"}</span><button className="source-settings-button" onClick={() => configureSource(source)}>Settings</button><button className={`toggle ${source.enabled ? "toggle--on" : ""}`} onClick={() => toggleSource(source)} aria-label={`${source.enabled ? "Disable" : "Enable"} ${source.name}`}><span /></button></div>
              {editingSource === source._id && <form className="source-config-panel" onSubmit={event => saveSourceSettings(event, source)}><label>News language<select value={sourceSettings.language} onChange={event => setSourceSettings({ ...sourceSettings, language: event.target.value })}><option value="hi,en">Hindi first + English</option><option value="hi">Hindi</option><option value="en">English</option></select></label><label>Default category<select value={sourceSettings.category} onChange={event => setSourceSettings({ ...sourceSettings, category: event.target.value })}>{categories.map(item => <option key={item}>{item}</option>)}</select></label><label className="source-checkbox"><input type="checkbox" checked={sourceSettings.allowFullText} onChange={event => setSourceSettings({ ...sourceSettings, allowFullText: event.target.checked })} /> Terms allow storing full source text</label><label className="source-checkbox"><input type="checkbox" checked={sourceSettings.allowMedia} onChange={event => setSourceSettings({ ...sourceSettings, allowMedia: event.target.checked })} /> Terms allow image/video reuse</label><button type="submit">Save settings <Check size={13} /></button></form>}
            </React.Fragment>)}
          </div>
          <div className="source-footnote"><ShieldCheck size={15} /> Source status reflects its most recent collector run. Review each provider's terms before publishing material.</div>
        </section>
        <section className="admin-panel pipeline-panel">        <div className="panel-heading"><div><span className="eyebrow">AUTOMATION</span><h2>News collector</h2></div><span className={`paused-pill ${overview.engine.enabled ? "collector-on" : ""}`}><span /> {overview.engine.enabled ? "ENABLED" : "PAUSED"}</span></div><div className="engine-status"><div className="engine-graphic"><Sparkles size={20} /></div><div><strong>{overview.engine.enabled ? "Approved-source collection is enabled" : "External discovery is off"}</strong><span>{overview.engine.enabled ? "Collector checks enabled sources on its server schedule." : "Set NEWS_ENGINE_ENABLED=true on the backend after source approval."}</span></div></div><div className="pipeline-list">{["NewsData.io / GDELT / approved feeds", "Normalize metadata, categories and media", "Deduplicate by canonical URL", "Save candidates to MongoDB", overview.automation?.enabled ? "AI selects a story and drafts in Hindi" : "AI story selection and drafting are paused", "All AI drafts enter human editorial review"].map((step, index) => <div key={step}><span className="pipeline-index">{String(index + 1).padStart(2, "0")}</span><span>{step}</span>{index < 4 ? <Check size={14} /> : overview.automation?.enabled && index === 4 ? <Check size={14} /> : <Clock3 size={14} />}</div>)}</div><div className="last-run">LAST COLLECTION <strong>{overview.engine.lastRun ? new Date(overview.engine.lastRun).toLocaleString() : "Not run yet"}</strong></div><div className="engine-status"><div className="engine-graphic"><Newspaper size={18} /></div><div><strong>{overview.blogger?.enabled && overview.blogger?.configured ? "Blogger auto-publishing is configured" : overview.blogger?.enabled ? "Blogger credentials need setup" : "Blogger auto-publishing is paused"}</strong><span>{overview.blogger?.enabled && overview.blogger?.configured ? "New KraantiInfo publications will also be sent to this Blogger blog." : "Set the Blogger OAuth credentials and blog ID in the backend environment."}</span></div></div></section>
      </div>
      <div className="admin-footnote"><ShieldCheck size={15} /> Sensitive categories (politics, elections, crime, health and financial impact) always require human review, even when auto-publish is enabled.</div>
      {!overview.demo && <section className="admin-panel candidates-panel"><div className="panel-heading"><div><span className="eyebrow">STEP 1 · SOURCE MATERIAL</span><h2>Collected candidates</h2></div><span className="candidate-count">{collectedArticles.length} awaiting editorial processing</span></div><p className="panel-description">AI writes every article with a 500-word minimum. It uses full source text only when permitted; short metadata can still produce an AI-authored explainer, which always needs human review. Video links are collected when media reuse is enabled.</p>{collectedArticles.length ? <div className="candidate-list">{collectedArticles.map(item => <article className="candidate-item" key={item._id}><div className="candidate-copy"><span className="eyebrow">{item.provider.replace("_", " ")} · {item.source?.name || item.sourceName || "Source"}</span><h3>{item.title}</h3><p>{item.description || "No description supplied by source."}</p>{item.imageUrl && <img className="candidate-media-preview" src={item.imageUrl} alt="Source article preview" loading="lazy" />}{item.videoUrl && <a href={item.videoUrl} target="_blank" rel="noreferrer">Open source video <ExternalLink size={13} /></a>}<small>{item.publishedAt ? new Date(item.publishedAt).toLocaleString() : "Publication date unavailable"} · {item.category} · {item.language || "Language unspecified"} · {item.contentText ? countWords(item.contentText) + " source words" : "Metadata only"}</small><a href={item.url} target="_blank" rel="noreferrer">Open original source <ExternalLink size={13} /></a></div><div className="candidate-buttons"><button className="candidate-action ai-draft-button" disabled={busy || ((item.description?.trim().length || 0) < 80 && countWords(item.contentText) < 100)} onClick={() => generateCandidateDraft(item)}><Sparkles size={14} /> Generate Hindi draft</button><button className="manual-draft-button" disabled={busy} onClick={() => startDraft(item)}>Write manually</button></div><small className="editor-word-count">{countWords(item.contentText)} permitted source words · AI writes 500+ words; metadata-only drafts need review. Video items need media permission.</small>{editingCandidate === item._id && <form className="editor-form" onSubmit={event => saveEditorialDraft(event, item)}><div className="editor-form-title"><strong>Write an original report</strong><span>Do not copy the source article. Verify claims and cite the source.</span></div><label>Headline<input required maxLength="180" value={draftForm.title} onChange={event => setDraftForm({ ...draftForm, title: event.target.value })} /></label><label>Summary<textarea required maxLength="500" rows="2" value={draftForm.summary} onChange={event => setDraftForm({ ...draftForm, summary: event.target.value })} /></label><label>KraantiInfo article body<textarea required maxLength="20000" rows="7" value={draftForm.body} onChange={event => setDraftForm({ ...draftForm, body: event.target.value })} placeholder="Write an original Hindi report. Verify claims and attribute source material." /><small className="editor-word-count">{countWords(draftForm.body)} / 500 words minimum</small></label><div className="editor-form-row"><label>Category<select value={draftForm.category} onChange={event => setDraftForm({ ...draftForm, category: event.target.value })}>{categories.map(value => <option key={value}>{value}</option>)}</select></label><label>Author<input maxLength="100" value={draftForm.author} onChange={event => setDraftForm({ ...draftForm, author: event.target.value })} /></label></div><div className="editor-form-actions"><button type="button" className="quiet-button" onClick={() => setEditingCandidate(null)}>Cancel</button><button type="submit" disabled={busy || countWords(draftForm.body) < MINIMUM_ARTICLE_WORDS}>Save draft <Check size={14} /></button></div></form>}</article>)}</div> : <div className="candidate-empty">No source items are waiting for editorial processing.</div>}</section>}
      {!overview.demo && <section className="admin-panel candidates-panel blogger-sync-panel">
        <div className="panel-heading"><div><span className="eyebrow">BLOGGER SYNC</span><h2>Published on KraantiInfo</h2></div><span className="candidate-count">{publishedArticles.length} recent articles</span></div>
        <p className="panel-description">Check each published article’s Blogger status. Sync an individual article if it is missing from Blogger.</p>
        {publishedArticles.length ? <div className="candidate-list">{publishedArticles.map(article => {
          const syncStatus = article.bloggerSync?.status || "not_synced";
          const statusLabel = syncStatus === "published" ? "On Blogger" : syncStatus === "failed" ? "Sync failed" : syncStatus === "pending" ? "Sync pending" : "Not synced";
          return <article className="candidate-item" key={article._id}>
            <div className="candidate-copy">
              <span className="eyebrow">{article.category} · {statusLabel}</span>
              <h3>{article.title}</h3>
              <small>{article.publishedAt ? new Date(article.publishedAt).toLocaleString() : "Publication date unavailable"}</small>
              {syncStatus === "failed" && article.bloggerSync?.error && <small>{article.bloggerSync.error}</small>}
              {syncStatus === "published" && article.bloggerSync?.postUrl && <a href={article.bloggerSync.postUrl} target="_blank" rel="noreferrer">Open Blogger copy <ExternalLink size={13} /></a>}
            </div>
            <div className="candidate-buttons">
              {syncStatus === "published"
                ? <span className="candidate-count">Synced</span>
                : <button className="candidate-action" disabled={busy || !overview.blogger?.enabled || !overview.blogger?.configured} onClick={() => syncPublishedArticleToBlogger(article)}><Newspaper size={14} /> Sync this post</button>}
            </div>
          </article>;
        })}</div> : <div className="candidate-empty">No published articles are available yet.</div>}
      </section>}
      {!overview.demo && <EditorialQueue articles={editorialArticles} busy={busy} onStatus={updateEditorialStatus} onSave={saveArticleEdits} />}
    </div>
  );
}

function AdminLogin({ onLogin, onExit }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not sign in.");
      onLogin(payload.token);
    } catch (err) {
      setError(err.message || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="login-wrap"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to publication</button><form className="login-card" onSubmit={submit}><span className="eyebrow">KRAANTIINFO · EDITORIAL</span><h1>Sign in to the newsroom</h1><p>Admin access is protected. Configure your credentials in the server environment.</p>{error && <div className="inline-alert">{error}</div>}<label>Email<input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label><button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"} <ArrowRight size={15} /></button></form></div>;
}

export default AdminDashboard;


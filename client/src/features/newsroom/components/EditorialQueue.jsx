import React, { useState } from "react";
import { ArrowRight, Check, ExternalLink, ShieldCheck } from "lucide-react";
import { categories } from "../../../data/categories.js";
import { brandedAuthor } from "../../../branding.js";

export function EditorialQueue({ articles, busy, onStatus, onSave }) {
  return (
    <section className="admin-panel editorial-queue">
      <div className="panel-heading"><div><span className="eyebrow">STEP 2 · HUMAN EDITORIAL REVIEW</span><h2>Drafts & review queue</h2></div><span className="candidate-count">{articles.length} active articles</span></div>
      <p className="panel-description">Submitting a draft moves it to “Awaiting review”; it does not publish it. A human editor must verify facts and attribution, then explicitly publish or reject it.</p>
      {!articles.length ? <div className="candidate-empty">No editorial drafts yet. Start with a collected source candidate above.</div> : <div className="editorial-article-list">{articles.map(article => <EditorialArticleCard key={article._id} article={article} busy={busy} onStatus={onStatus} onSave={onSave} />)}</div>}
    </section>
  );
}

function EditorialArticleCard({ article, busy, onStatus, onSave }) {
  const [factCheckConfirmed, setFactCheckConfirmed] = useState(false);
  const [attributionConfirmed, setAttributionConfirmed] = useState(false);
  const [sensitiveReviewConfirmed, setSensitiveReviewConfirmed] = useState(false);
  const [rejectConfirmed, setRejectConfirmed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: article.title, summary: article.summary, body: article.body, category: article.category, author: brandedAuthor(article.author) });
  const source = article.sourceArticle;
  const categoryIsSensitive = /politic|election|crime|health|business|finance|death|market|stock|bank|assault|arrest|murder|injur|fatal|disease|drug|court/i.test(`${article.category} ${source?.title || ""} ${source?.description || ""} ${source?.category || ""}`);
  const canPublish = article.status === "review" && factCheckConfirmed && attributionConfirmed && (!categoryIsSensitive || sensitiveReviewConfirmed);

  return (
    <article className="editorial-article">
      <div className="editorial-article-top"><span className={`editorial-status editorial-status--${article.status}`}>{article.status === "review" ? "AWAITING REVIEW" : "DRAFT"}</span><span className="eyebrow">{article.category} · {brandedAuthor(article.author)}</span></div>
      {editing ? <form className="editor-form editorial-edit-form" onSubmit={async event => { event.preventDefault(); if (await onSave(article, form)) setEditing(false); }}>
        <label>Headline<input required maxLength="180" value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label>
        <label>Summary<textarea required maxLength="500" rows="2" value={form.summary} onChange={event => setForm({ ...form, summary: event.target.value })} /></label>
        <label>KraantiInfo article body<textarea required maxLength="20000" rows="7" value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} /></label>
        <label>AI fact-check / verification notes<textarea maxLength="3000" rows="3" value={form.verificationNotes} onChange={event => setForm({ ...form, verificationNotes: event.target.value })} /></label>
        <div className="editor-form-row"><label>Category<select value={form.category} onChange={event => setForm({ ...form, category: event.target.value })}>{categories.map(value => <option key={value}>{value}</option>)}</select></label><label>Author<input maxLength="100" value={form.author} onChange={event => setForm({ ...form, author: event.target.value })} /></label></div>
        <div className="editor-form-actions"><button type="button" className="quiet-button" onClick={() => setEditing(false)}>Cancel</button><button type="submit" disabled={busy}>Save changes <Check size={14} /></button></div>
      </form> : <>
      <h3>{article.title}</h3>
      <p className="editorial-summary">{article.summary}</p>
      {article.verificationNotes && <div className="verification-notes"><ShieldCheck size={15} /><div><strong>AI verification notes — editor must check</strong><p>{article.verificationNotes}</p></div></div>}
      <details className="editorial-preview"><summary>Read article draft</summary><div>{article.body.split(/\n{2,}/).filter(Boolean).map((paragraph, index) => {
        const heading = paragraph.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          const Heading = heading[1].length === 3 ? "h3" : "h2";
          return <Heading key={index}>{heading[2]}</Heading>;
        }
        return <p key={index}>{paragraph}</p>;
      })}</div></details>
      <div className="editorial-source">Source attribution: <strong>{article.sourceName}</strong>{source?.provider && <span> · {source.provider}</span>} {article.sourceUrl && <a href={article.sourceUrl} target="_blank" rel="noreferrer">Verify original <ExternalLink size={12} /></a>}</div>
      <div className="editorial-actions">
        <button className="quiet-button edit-article-button" disabled={busy} onClick={() => { setForm({ title: article.title, summary: article.summary, body: article.body, verificationNotes: article.verificationNotes || "", category: article.category, author: brandedAuthor(article.author) }); setEditing(true); }}>Edit article</button>
        {article.status === "draft" && <button className="candidate-action" disabled={busy} onClick={() => onStatus(article, "review")}>Submit for review <ArrowRight size={14} /></button>}
        {article.status === "review" && <div className="publish-confirmations">
          <label><input type="checkbox" checked={factCheckConfirmed} onChange={event => setFactCheckConfirmed(event.target.checked)} /> I reviewed the article and verified its factual claims.</label>
          <label><input type="checkbox" checked={attributionConfirmed} onChange={event => setAttributionConfirmed(event.target.checked)} /> Source and attribution are correct.</label>
          {categoryIsSensitive && <label className="sensitive-confirm"><input type="checkbox" checked={sensitiveReviewConfirmed} onChange={event => setSensitiveReviewConfirmed(event.target.checked)} /> I completed the additional editorial review required for this sensitive category.</label>}
          <button className="publish-button" disabled={busy || !canPublish} onClick={() => onStatus(article, "published", { factCheckConfirmed, attributionConfirmed, sensitiveReviewConfirmed })}>Publish to KraantiInfo <Check size={14} /></button>
        </div>}
        {!rejectConfirmed ? <button className="reject-button" disabled={busy} onClick={() => setRejectConfirmed(true)}>Reject</button> : <div className="reject-confirm"><span>Reject this article?</span><button onClick={() => setRejectConfirmed(false)}>Keep</button><button disabled={busy} onClick={() => onStatus(article, "rejected")}>Confirm reject</button></div>}
      </div>
      </>}
    </article>
  );
}


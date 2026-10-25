import React from "react";
import { brandedAuthor } from "../branding.js";

export function StoryImage({ story, className = "" }) {
  return story.image
    ? <img className={className} src={story.image} alt={story.imageAlt || ""} loading="lazy" />
    : <span className={`story-image-placeholder ${className}`} aria-label={`${story.category} image unavailable`}>{story.category || "KraantiInfo"}</span>;
}

export function StoryCard({ story, onOpen, compact = false, number }) {
  return (
    <a className={`story-card ${compact ? "story-card--compact" : ""}`} href={`/article/${encodeURIComponent(story._id)}`} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(story);
    }} aria-label={`Read: ${story.title}`}>
      {number && <span className="rank-number">{number}</span>}
      <div className="story-card__image"><StoryImage story={story} /></div>
      <div className="story-card__copy">
        <span className="eyebrow">{story.category}</span>
        <h3>{story.title}</h3>
        {!compact && <p>{story.summary}</p>}
        <span className="story-meta">{story.readTime || "4 min read"} <i /> {brandedAuthor(story.author)}</span>
      </div>
    </a>
  );
}


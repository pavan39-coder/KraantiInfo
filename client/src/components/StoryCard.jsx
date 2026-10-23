import React from "react";
import { brandedAuthor } from "../branding.js";

export function StoryImage({ story, className = "" }) {
  return <img className={className} src={story.image} alt={story.imageAlt || ""} loading="lazy" />;
}

export function StoryCard({ story, onOpen, compact = false, number }) {
  return (
    <button className={`story-card ${compact ? "story-card--compact" : ""}`} onClick={() => onOpen(story)} aria-label={`Read: ${story.title}`}>
      {number && <span className="rank-number">{number}</span>}
      <div className="story-card__image"><StoryImage story={story} /></div>
      <div className="story-card__copy">
        <span className="eyebrow">{story.category}</span>
        <h3>{story.title}</h3>
        {!compact && <p>{story.summary}</p>}
        <span className="story-meta">{story.readTime || "4 min read"} <i /> {brandedAuthor(story.author)}</span>
      </div>
    </button>
  );
}


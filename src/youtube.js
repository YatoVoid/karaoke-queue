const BARE_ID = /^[\w-]{11}$/;
const WATCH_URL = /(?:youtube\.com)\/watch\?(?:.*&)?v=([\w-]{11})/;
const SHORT_URL = /youtu\.be\/([\w-]{11})/;
const SHORTS_URL = /(?:youtube\.com)\/shorts\/([\w-]{11})/;

export function extractVideoId(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (BARE_ID.test(trimmed)) return trimmed;

  for (const pattern of [WATCH_URL, SHORT_URL, SHORTS_URL]) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// Keyless oEmbed lookup, never throws.
export async function fetchOembedTitle(videoId) {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.title === "string" && data.title.trim() ? data.title : null;
  } catch {
    return null;
  }
}

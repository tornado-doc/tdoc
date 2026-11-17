// The author frame supplies a public post URL. The reader reconstructs the
// player URL and only forwards the identifier and supported start time.
export function socialVideo(href) {
  if (typeof href !== 'string' || href.length > 2048) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;

  if (['instagram.com', 'www.instagram.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/(p|reel)\/([A-Za-z0-9_-]{1,32})\/?$/);
    if (!match) return null;
    const source = `https://www.instagram.com/${match[1]}/${match[2]}/`;
    return { platform: 'Instagram', source, embed: `${source}embed/`, vertical: true };
  }

  if (['tiktok.com', 'www.tiktok.com'].includes(url.hostname)) {
    const match = url.pathname.match(/^\/@([A-Za-z0-9._-]{1,48})\/video\/(\d{10,25})\/?$/);
    if (!match) return null;
    const source = `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
    const embed = `https://www.tiktok.com/player/v1/${match[2]}?autoplay=1&muted=1&rel=0`;
    return { platform: 'TikTok', source, embed, vertical: true };
  }

  if (['youtube.com', 'www.youtube.com', 'youtu.be'].includes(url.hostname)) {
    const id = url.hostname === 'youtu.be'
      ? url.pathname.slice(1)
      : url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/shorts\/([^/]+)\/?$/)?.[1];
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const timestamp = url.searchParams.get('t') || url.searchParams.get('start') || '';
    const start = /^(\d{1,6})s?$/.exec(timestamp)?.[1];
    const source = `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ''}`;
    const embed = `https://www.youtube.com/embed/${id}?playsinline=1&autoplay=1&rel=0${start ? `&start=${start}` : ''}`;
    return { platform: 'YouTube', source, embed, vertical: url.pathname.startsWith('/shorts/') };
  }

  if (['linkedin.com', 'www.linkedin.com'].includes(url.hostname)
      && /^\/posts\/[A-Za-z0-9_-]{1,300}\/?$/.test(url.pathname)) {
    return { platform: 'LinkedIn', source: `https://www.linkedin.com${url.pathname}` };
  }

  return null;
}

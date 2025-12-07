export async function fetchFavicon(url: URL): Promise<string | undefined> {
  try {
    // Try standard favicon.ico location
    const faviconUrl = new URL('/favicon.ico', url.origin);
    const response = await fetch(faviconUrl.toString());

    if (response.ok) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const mimeType = response.headers.get('content-type') || 'image/x-icon';
      return `data:${mimeType};base64,${base64}`;
    }

    // Try HTML head meta tags
    const pageResponse = await fetch(url.toString());
    const html = await pageResponse.text();

    // Look for favicon in meta tags
    const iconMatch =
      html.match(/<link[^>]*?rel=["'](?:shortcut )?icon["'][^>]*?href=["']([^"']+)["'][^>]*>/i) ||
      html.match(/<link[^>]*?href=["']([^"']+)["'][^>]*?rel=["'](?:shortcut )?icon["'][^>]*>/i);

    if (iconMatch) {
      const iconUrl = new URL(iconMatch[1], url.origin);
      const iconResponse = await fetch(iconUrl.toString());

      if (iconResponse.ok) {
        const buffer = await iconResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const mimeType = iconResponse.headers.get('content-type') || 'image/x-icon';
        return `data:${mimeType};base64,${base64}`;
      }
    }

    return undefined;
  } catch (error) {
    console.warn(`Error fetching favicon for ${url}:`, error);
    return undefined;
  }
}

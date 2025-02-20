export function generateDocId(url: string, title: string): string {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split('/').filter(Boolean);

  // For GitHub Pages (e.g., jimdo.github.io/ui/latest)
  if (urlObj.hostname.endsWith('github.io')) {
    const org = urlObj.hostname.split('.')[0];
    const repo = pathParts[0];
    return `${org}-${repo}`;
  }

  // For organization packages (e.g., @org/package)
  if (title.includes('/')) {
    return title.toLowerCase().replace(/[@/]/g, '-').replace(/\s+/g, '-');
  }

  // For regular packages, use the first part of the hostname
  const hostParts = urlObj.hostname.split('.');
  if (hostParts.length > 1) {
    const mainPart = hostParts[0] === 'www' ? hostParts[1] : hostParts[0];
    // If there's a specific product/package in the path, include it
    if (pathParts.length > 0 && pathParts[0] !== 'docs') {
      return `${mainPart}-${pathParts[0]}`;
    }
    return mainPart;
  }

  return urlObj.hostname;
}
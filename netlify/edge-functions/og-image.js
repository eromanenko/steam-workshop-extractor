export default async (request, context) => {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  // Let Netlify process the request normally first
  const response = await context.next();
  
  // Only process HTML files and only if an ID is present
  if (!id || !response.headers.get('content-type')?.includes('text/html')) {
    return response;
  }

  // Get the original HTML text
  let html = await response.text();

  try {
    // Make a server-side request to Steam API
    const steamApiUrl = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
    const body = new URLSearchParams({ 
      itemcount: '1', 
      'publishedfileids[0]': id 
    });
    
    const steamRes = await fetch(steamApiUrl, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    const steamData = await steamRes.json();
    const fileInfo = steamData?.response?.publishedfiledetails?.[0];

    // If we successfully got data from Steam, inject it into the HTML
    if (fileInfo && fileInfo.result === 1) {
      if (fileInfo.title) {
        // Replace og:title
        html = html.replace(
          /<meta property="og:title" content="[^"]*" \/>/i,
          `<meta property="og:title" content="${fileInfo.title.replace(/"/g, '&quot;')} - Steam Extractor" />`
        );
        // Replace normal title
        html = html.replace(
          /<title>([^<]+)<\/title>/i,
          `<title>${fileInfo.title.replace(/</g, '&lt;')} - Steam Extractor</title>`
        );
      }
      
      if (fileInfo.preview_url) {
        // Replace og:image
        html = html.replace(
          /<meta property="og:image" content="[^"]*" \/>/i,
          `<meta property="og:image" content="${fileInfo.preview_url}" />`
        );
        // Set twitter:image if it exists, otherwise just rely on og:image
        html = html.replace(
          /<meta name="twitter:image" content="[^"]*" \/>/i,
          `<meta name="twitter:image" content="${fileInfo.preview_url}" />`
        );
      }
    }
  } catch (err) {
    // If anything fails (Steam API down, rate limits, etc.), just return original HTML
    console.error('Edge Function Error:', err);
  }

  return new Response(html, {
    status: response.status,
    headers: response.headers
  });
};

const ALLOWED_ORIGINS = new Set([
  'https://zekenaulty.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const baseCors = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const makeCorsHeaders = (origin) => {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { ...baseCors, 'Access-Control-Allow-Origin': origin };
  }
  return baseCors;
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const corsHeaders = makeCorsHeaders(origin);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Only allow POST from your site
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    if (!env.GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: 'Missing GEMINI_API_KEY' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Change this to match the exact model you're using
    const GEMINI_MODEL = 'gemini-2.5-flash'; // or gemini-pro, gemini-1.5-pro, etc.
    // Use v1beta to stay aligned with client payloads that include system_instruction, etc.
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

    try {
      // Forward the exact same body your frontend sends
      const proxyRequest = new Request(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: await request.text(), // pass-through the JSON payload unchanged
      });

      const geminiResponse = await fetch(proxyRequest);

      const passthroughHeaders = {
        ...corsHeaders,
        'Content-Type': geminiResponse.headers.get('content-type') ?? 'application/json',
      };

      // Stream the response straight back (preserves chat streaming)
      return new Response(geminiResponse.body, {
        status: geminiResponse.status,
        statusText: geminiResponse.statusText,
        headers: passthroughHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Proxy error', details: err.message }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  },
};

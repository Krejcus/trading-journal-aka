// Retired Tradecopia collector ingress; historical records are retained.
Deno.serve(() => new Response(JSON.stringify({ error: 'tradecopia-retired' }), {
  status: 410, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
}));

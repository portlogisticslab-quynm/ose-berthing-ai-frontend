// Runtime configuration for the static frontend (Cloudflare Pages).
// API_BASE_URL: backend that serves the APPROVED server model. Leave '' to run browser-only.
// If you use the ose-failover Worker in front of the home server / Render, put the Worker URL here.
window.APP_CONFIG = {
  API_BASE_URL: ['127.0.0.1','localhost'].includes(location.hostname) ? 'http://127.0.0.1:8025' : 'https://ose-berthing-ai-backend.onrender.com',
  APP_NAME: 'Berthing AI Advisory System'
};

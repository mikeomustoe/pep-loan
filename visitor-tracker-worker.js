// Visitor Tracker Cloudflare Worker
// Requires KV namespace: VISITORS (bind as VISITORS)

const ADMIN_TOKEN = 'pep-admin-2024-secure'; // Change this to a secure token

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Track visitor (called from main site)
      if (path === '/track' && request.method === 'POST') {
        return await trackVisitor(request, env);
      }

      // Heartbeat (visitor still on site)
      if (path === '/heartbeat' && request.method === 'POST') {
        return await heartbeat(request, env);
      }

      // Visitor left (beacon on page unload)
      if (path === '/leave' && request.method === 'POST') {
        return await visitorLeave(request, env);
      }

      // Get all visitors (admin)
      if (path === '/visitors' && request.method === 'GET') {
        return await getVisitors(request, env);
      }

      // Get online count
      if (path === '/online-count' && request.method === 'GET') {
        return await getOnlineCount(env);
      }

      // Subscribe to push notifications (admin)
      if (path === '/subscribe' && request.method === 'POST') {
        return await subscribePush(request, env);
      }

      // Get VAPID public key
      if (path === '/vapid-key' && request.method === 'GET') {
        return jsonResponse({ publicKey: env.VAPID_PUBLIC_KEY || '' });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  }
};

async function trackVisitor(request, env) {
  const data = await request.json();
  const visitorId = data.visitorId || crypto.randomUUID();
  const now = Date.now();

  // Get geo data from Cloudflare
  const cf = request.cf || {};
  
  const visitor = {
    id: visitorId,
    ip: request.headers.get('CF-Connecting-IP') || 'Unknown',
    country: cf.country || data.country || 'XX',
    countryName: getCountryName(cf.country || data.country),
    city: cf.city || data.city || 'Unknown',
    region: cf.region || data.region || '',
    browser: data.browser || 'Unknown',
    browserVersion: data.browserVersion || '',
    os: data.os || 'Unknown',
    device: data.device || 'desktop',
    referrer: data.referrer || 'Direct',
    page: data.page || '/',
    screenSize: data.screenSize || '',
    language: data.language || 'en',
    firstVisit: now,
    lastSeen: now,
    totalTime: 0,
    pageViews: 1,
    isOnline: true,
    userAgent: data.userAgent || ''
  };

  // Store visitor
  await env.VISITORS.put(`visitor:${visitorId}`, JSON.stringify(visitor), {
    expirationTtl: 86400 * 30 // Keep for 30 days
  });

  // Add to recent visitors list
  let recentList = await env.VISITORS.get('recent_visitors', 'json') || [];
  recentList = recentList.filter(v => v.id !== visitorId);
  recentList.unshift({ id: visitorId, timestamp: now });
  recentList = recentList.slice(0, 500); // Keep last 500
  await env.VISITORS.put('recent_visitors', JSON.stringify(recentList));

  // Update online list
  let onlineList = await env.VISITORS.get('online_visitors', 'json') || [];
  onlineList = onlineList.filter(v => v.id !== visitorId);
  onlineList.push({ id: visitorId, lastSeen: now });
  await env.VISITORS.put('online_visitors', JSON.stringify(onlineList));

  // Send push notification to admin
  await sendPushNotification(env, visitor);

  // Update stats
  await updateStats(env, visitor);

  return jsonResponse({ success: true, visitorId, visitor });
}

async function heartbeat(request, env) {
  const data = await request.json();
  const visitorId = data.visitorId;
  const now = Date.now();

  if (!visitorId) {
    return jsonResponse({ error: 'Missing visitorId' }, 400);
  }

  const visitorData = await env.VISITORS.get(`visitor:${visitorId}`, 'json');
  if (visitorData) {
    visitorData.lastSeen = now;
    visitorData.totalTime = Math.floor((now - visitorData.firstVisit) / 1000);
    visitorData.isOnline = true;
    if (data.page) visitorData.page = data.page;
    if (data.pageViews) visitorData.pageViews = data.pageViews;

    await env.VISITORS.put(`visitor:${visitorId}`, JSON.stringify(visitorData), {
      expirationTtl: 86400 * 30
    });

    // Update online list
    let onlineList = await env.VISITORS.get('online_visitors', 'json') || [];
    onlineList = onlineList.filter(v => v.id !== visitorId);
    onlineList.push({ id: visitorId, lastSeen: now });
    await env.VISITORS.put('online_visitors', JSON.stringify(onlineList));
  }

  return jsonResponse({ success: true });
}

async function visitorLeave(request, env) {
  const data = await request.json();
  const visitorId = data.visitorId;
  const now = Date.now();

  if (!visitorId) {
    return jsonResponse({ error: 'Missing visitorId' }, 400);
  }

  const visitorData = await env.VISITORS.get(`visitor:${visitorId}`, 'json');
  if (visitorData) {
    visitorData.lastSeen = now;
    visitorData.totalTime = Math.floor((now - visitorData.firstVisit) / 1000);
    visitorData.isOnline = false;

    await env.VISITORS.put(`visitor:${visitorId}`, JSON.stringify(visitorData), {
      expirationTtl: 86400 * 30
    });

    // Remove from online list
    let onlineList = await env.VISITORS.get('online_visitors', 'json') || [];
    onlineList = onlineList.filter(v => v.id !== visitorId);
    await env.VISITORS.put('online_visitors', JSON.stringify(onlineList));
  }

  return jsonResponse({ success: true });
}

async function getVisitors(request, env) {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '100');
  const onlineOnly = url.searchParams.get('online') === 'true';

  // Clean up stale online visitors (no heartbeat in 60 seconds)
  const now = Date.now();
  let onlineList = await env.VISITORS.get('online_visitors', 'json') || [];
  const activeOnline = onlineList.filter(v => (now - v.lastSeen) < 60000);
  
  if (activeOnline.length !== onlineList.length) {
    await env.VISITORS.put('online_visitors', JSON.stringify(activeOnline));
    
    // Mark stale visitors as offline
    for (const stale of onlineList.filter(v => (now - v.lastSeen) >= 60000)) {
      const visitorData = await env.VISITORS.get(`visitor:${stale.id}`, 'json');
      if (visitorData) {
        visitorData.isOnline = false;
        await env.VISITORS.put(`visitor:${stale.id}`, JSON.stringify(visitorData), {
          expirationTtl: 86400 * 30
        });
      }
    }
  }

  // Get recent visitors
  const recentList = await env.VISITORS.get('recent_visitors', 'json') || [];
  const visitors = [];

  for (const item of recentList.slice(0, limit)) {
    const visitor = await env.VISITORS.get(`visitor:${item.id}`, 'json');
    if (visitor) {
      // Check if actually online
      visitor.isOnline = activeOnline.some(v => v.id === visitor.id);
      if (!onlineOnly || visitor.isOnline) {
        visitors.push(visitor);
      }
    }
  }

  // Sort: online first, then by lastSeen
  visitors.sort((a, b) => {
    if (a.isOnline && !b.isOnline) return -1;
    if (!a.isOnline && b.isOnline) return 1;
    return b.lastSeen - a.lastSeen;
  });

  const stats = await env.VISITORS.get('stats', 'json') || {};

  return jsonResponse({
    visitors: onlineOnly ? visitors : visitors.slice(0, limit),
    onlineCount: activeOnline.length,
    totalToday: stats.todayCount || 0,
    totalAll: stats.totalCount || 0
  });
}

async function getOnlineCount(env) {
  const now = Date.now();
  let onlineList = await env.VISITORS.get('online_visitors', 'json') || [];
  const activeOnline = onlineList.filter(v => (now - v.lastSeen) < 60000);
  
  return jsonResponse({ count: activeOnline.length });
}

async function subscribePush(request, env) {
  const subscription = await request.json();
  
  // Store subscription
  let subscriptions = await env.VISITORS.get('push_subscriptions', 'json') || [];
  subscriptions = subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  subscriptions.push(subscription);
  await env.VISITORS.put('push_subscriptions', JSON.stringify(subscriptions));

  return jsonResponse({ success: true });
}

async function sendPushNotification(env, visitor) {
  const subscriptions = await env.VISITORS.get('push_subscriptions', 'json') || [];
  
  if (subscriptions.length === 0) return;

  const countryFlag = getCountryFlag(visitor.country);
  const payload = JSON.stringify({
    title: `${countryFlag} New Visitor from ${visitor.countryName}`,
    body: `${visitor.city} • ${visitor.browser} on ${visitor.os}`,
    icon: '/favicon.ico',
    tag: 'new-visitor',
    data: {
      visitorId: visitor.id,
      url: '/admin.html'
    }
  });

  // Send to all subscriptions
  for (const subscription of subscriptions) {
    try {
      await sendWebPush(subscription, payload, env);
    } catch (e) {
      console.error('Push failed:', e);
    }
  }
}

async function sendWebPush(subscription, payload, env) {
  // Web Push implementation using VAPID
  // For full implementation, you'd use web-push library or implement the protocol
  // This is a simplified version - for production use a service worker
  
  const vapidPublicKey = env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = env.VAPID_PRIVATE_KEY;
  
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.log('VAPID keys not configured, skipping push');
    return;
  }

  // In production, implement full Web Push protocol or use a library
  // For now, we'll rely on the admin panel polling
}

async function updateStats(env, visitor) {
  const stats = await env.VISITORS.get('stats', 'json') || {
    totalCount: 0,
    todayCount: 0,
    todayDate: '',
    countries: {},
    browsers: {}
  };

  const today = new Date().toISOString().split('T')[0];
  
  if (stats.todayDate !== today) {
    stats.todayCount = 0;
    stats.todayDate = today;
  }

  stats.totalCount++;
  stats.todayCount++;
  stats.countries[visitor.country] = (stats.countries[visitor.country] || 0) + 1;
  stats.browsers[visitor.browser] = (stats.browsers[visitor.browser] || 0) + 1;

  await env.VISITORS.put('stats', JSON.stringify(stats));
}

function getCountryFlag(countryCode) {
  if (!countryCode || countryCode === 'XX') return '🌍';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function getCountryName(code) {
  const countries = {
    'US': 'United States', 'GB': 'United Kingdom', 'CA': 'Canada', 'AU': 'Australia',
    'DE': 'Germany', 'FR': 'France', 'IT': 'Italy', 'ES': 'Spain', 'NL': 'Netherlands',
    'BR': 'Brazil', 'MX': 'Mexico', 'AR': 'Argentina', 'CO': 'Colombia',
    'IN': 'India', 'CN': 'China', 'JP': 'Japan', 'KR': 'South Korea', 'SG': 'Singapore',
    'NG': 'Nigeria', 'GH': 'Ghana', 'ZA': 'South Africa', 'KE': 'Kenya', 'EG': 'Egypt',
    'PG': 'Papua New Guinea', 'PH': 'Philippines', 'ID': 'Indonesia', 'MY': 'Malaysia',
    'TH': 'Thailand', 'VN': 'Vietnam', 'PK': 'Pakistan', 'BD': 'Bangladesh',
    'RU': 'Russia', 'UA': 'Ukraine', 'PL': 'Poland', 'TR': 'Turkey',
    'SA': 'Saudi Arabia', 'AE': 'UAE', 'IL': 'Israel', 'NZ': 'New Zealand'
  };
  return countries[code] || code || 'Unknown';
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// Service Worker for PEP Visitor Notifications
// Place this at the root of your site as sw.js

self.addEventListener('push', function(event) {
    if (!event.data) return;
    
    const data = event.data.json();
    
    const options = {
        body: data.body,
        icon: data.icon || '/favicon.ico',
        badge: '/badge.png',
        tag: data.tag || 'visitor-notification',
        data: data.data,
        vibrate: [200, 100, 200],
        requireInteraction: false,
        actions: [
            { action: 'view', title: 'View Dashboard' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();

    if (event.action === 'dismiss') return;

    const url = event.notification.data?.url || '/admin.html';
    
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(function(clientList) {
            // Check if admin page is already open
            for (const client of clientList) {
                if (client.url.includes('admin') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Open new window
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});

self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(clients.claim());
});

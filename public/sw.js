console.log('Service Worker Loaded');

self.addEventListener('push', e => {
    const data = e.data.json();
    console.log('Push Received...', data);
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: data.icon || '/icons/laundry-icon-192.png',
    });
});

self.addEventListener('notificationclick', function(event) {
    console.log('On notification click: ', event.notification);
    event.notification.close();
});